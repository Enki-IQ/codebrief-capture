import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WorkClientError,
  cancelWork,
  claimWork,
  listWork,
  renewWork,
  returnWorkResult,
} from "./active-project-client.js";
import { main } from "../codebrief-cli.js";

function response(status, body = {}) {
  const raw = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-length": String(Buffer.byteLength(raw, "utf8")) }),
    text: async () => raw,
  };
}

test("list and claim use bearer auth with repo.fullName and never accept an organization ID", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return response(200, url.endsWith("/list")
      ? { work: [] }
      : {
          work: {
            handoffId: "10000000-0000-4000-8000-000000000001",
            actionId: "20000000-0000-4000-8000-000000000002",
            actionVersion: 3,
            host: "codex",
            contract: { objective: "Ship the bounded client" },
          },
        });
  };

  const listed = await listWork({
    apiBaseUrl: "https://app.codebrief.ai",
    apiKey: "secret-key",
    repoFullName: "Acme/Widget",
    fetchImpl,
  });
  const claimed = await claimWork({
    apiBaseUrl: "https://app.codebrief.ai",
    apiKey: "secret-key",
    repoFullName: "Acme/Widget",
    actionId: "20000000-0000-4000-8000-000000000002",
    host: "codex",
    fetchImpl,
  });

  assert.deepEqual(listed, []);
  assert.equal(claimed.handoffId, "10000000-0000-4000-8000-000000000001");
  assert.equal("work" in claimed, false);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.headers.authorization, "Bearer secret-key");
    const body = JSON.parse(request.options.body);
    assert.deepEqual(body.repo, { fullName: "Acme/Widget" });
    assert.equal("orgId" in body, false);
    assert.equal(request.options.signal instanceof AbortSignal, true);
  }
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    repo: { fullName: "Acme/Widget" },
    actionId: "20000000-0000-4000-8000-000000000002",
    host: "codex",
  });
});

test("claim sends exactly one action selector and validates the host", async () => {
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return response(200, {
      work: { handoffId: "10000000-0000-4000-8000-000000000001" },
    });
  };

  await claimWork({
    apiBaseUrl: "https://app.codebrief.ai",
    apiKey: "key",
    repoFullName: "Acme/Widget",
    locator: "opaque-queued-work-locator",
    host: "claude",
    fetchImpl,
  });
  assert.deepEqual(bodies[0], {
    repo: { fullName: "Acme/Widget" },
    locator: "opaque-queued-work-locator",
    host: "claude",
  });
  await assert.rejects(
    claimWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      actionId: "action",
      locator: "locator",
      host: "codex",
      fetchImpl,
    }),
    /exactly one selector/,
  );
  await assert.rejects(
    claimWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      actionId: "action",
      host: "shell",
      fetchImpl,
    }),
    /host/,
  );
});

test("renew, cancel, and result requests stay body-based and repository-bound", async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, body: JSON.parse(options.body) });
    return response(200, { ok: true });
  };
  const common = {
    apiBaseUrl: "https://app.codebrief.ai",
    apiKey: "key",
    repoFullName: "Acme/Widget",
    handoffId: "10000000-0000-4000-8000-000000000001",
    fetchImpl,
  };

  await renewWork(common);
  await cancelWork(common);
  await returnWorkResult({
    ...common,
    result: {
      schemaVersion: 2,
      outcome: "completed",
      checks: [{ kind: "tests", status: "passed" }],
      references: [],
      blockers: [],
    },
  });

  assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
    "/api/capture/active-project/renew",
    "/api/capture/active-project/cancel",
    "/api/capture/active-project/result",
  ]);
  assert.deepEqual(requests[0].body, {
    repo: { fullName: "Acme/Widget" },
    handoffId: common.handoffId,
  });
  assert.deepEqual(requests[1].body, {
    repo: { fullName: "Acme/Widget" },
    handoffId: common.handoffId,
  });
  assert.equal(requests[2].body.repo.fullName, "Acme/Widget");
  assert.equal(requests[2].body.handoffId, common.handoffId);
  assert.deepEqual(requests[2].body.result, {
    schemaVersion: 2,
    outcome: "completed",
    checks: [{ kind: "tests", status: "passed" }],
    references: [],
    blockers: [],
  });
});

test("401 gives static re-login guidance without echoing credentials or response content", async () => {
  const apiKey = "ck_live_must_never_be_printed";
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey,
      repoFullName: "Acme/Widget",
      fetchImpl: async () => response(401, { error: `revoked ${apiKey}` }),
    }),
    (error) => {
      assert.equal(error instanceof WorkClientError, true);
      assert.equal(error.status, 401);
      assert.match(error.message, /login/i);
      assert.doesNotMatch(error.message, new RegExp(apiKey));
      assert.doesNotMatch(error.message, /revoked/);
      return true;
    },
  );
});

test("404 is status-only and does not reveal another organization or repository", async () => {
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => response(404, {
        error: "Repo belongs to Secret Org",
        orgId: "org_secret",
      }),
    }),
    (error) => {
      assert.equal(error.status, 404);
      assert.match(error.message, /not found/i);
      assert.doesNotMatch(error.message, /Secret Org|org_secret|Acme\/Widget/);
      return true;
    },
  );
});

test("the timeout remains active while a successful response body is read", { timeout: 100 }, async () => {
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      timeoutMs: 5,
      fetchImpl: async (_url, options) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "11" }),
        text: () => new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new Error("body aborted")));
        }),
      }),
    }),
    (error) => error instanceof WorkClientError
      && error.status === 0
      && !/body aborted/.test(error.message),
  );
});

test("request deadline settles when fetch ignores AbortSignal", { timeout: 200 }, async () => {
  const outcome = await Promise.race([
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      timeoutMs: 5,
      fetchImpl: async () => new Promise(() => {}),
    }).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 75)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.equal(outcome instanceof WorkClientError, true);
  assert.equal(outcome.status, 0);
});

test("body deadline settles when a stream reader ignores cancellation", { timeout: 200 }, async () => {
  let cancelCalled = false;
  const outcome = await Promise.race([
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      timeoutMs: 5,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader: () => ({
            read: () => new Promise(() => {}),
            cancel: () => { cancelCalled = true; return Promise.resolve(); },
            releaseLock: () => {},
          }),
        },
      }),
    }).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 75)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.equal(outcome instanceof WorkClientError, true);
  assert.equal(outcome.status, 0);
  assert.equal(cancelCalled, true);
});

test("body deadline settles when response.text ignores AbortSignal", { timeout: 200 }, async () => {
  const outcome = await Promise.race([
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      timeoutMs: 5,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "11" }),
        text: () => new Promise(() => {}),
      }),
    }).catch((error) => error),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 75)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.equal(outcome instanceof WorkClientError, true);
  assert.equal(outcome.status, 0);
});

test("successful response bodies are rejected while streaming past the size bound", async () => {
  let cancelled = false;
  const chunks = [new Uint8Array(200 * 1024), new Uint8Array(100 * 1024)];
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body,
      }),
    }),
    (error) => error instanceof WorkClientError && error.status === 502,
  );
  assert.equal(cancelled, true);
});

test("response.text fallback fails closed without a trusted content-length", async () => {
  let textCalls = 0;
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        text: async () => {
          textCalls += 1;
          return '{"work":[]}';
        },
      }),
    }),
    (error) => error instanceof WorkClientError && error.status === 502,
  );
  assert.equal(textCalls, 0);
});

test("response.text fallback rejects declared-length mismatches and oversized declarations", async () => {
  let oversizedCalls = 0;
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "1" }),
        text: async () => '{"work":[]}',
      }),
    }),
    (error) => error instanceof WorkClientError && error.status === 502,
  );
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(256 * 1024 + 1) }),
        text: async () => {
          oversizedCalls += 1;
          return '{"work":[]}';
        },
      }),
    }),
    (error) => error instanceof WorkClientError && error.status === 502,
  );
  assert.equal(oversizedCalls, 0);
});

test("response.json fallback is rejected without materializing the body", async () => {
  let jsonCalls = 0;
  await assert.rejects(
    listWork({
      apiBaseUrl: "https://app.codebrief.ai",
      apiKey: "key",
      repoFullName: "Acme/Widget",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "11" }),
        json: async () => {
          jsonCalls += 1;
          return { work: [] };
        },
      }),
    }),
    (error) => error instanceof WorkClientError && error.status === 502,
  );
  assert.equal(jsonCalls, 0);
});

test("work list and claim reject repositories without an exact GitHub origin", async () => {
  let requests = 0;
  const stderr = [];
  const dependencies = {
    resolveRepo: () => null,
    loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
    loadCreds: () => ({ apiKey: "key" }),
    listWork: async () => { requests += 1; },
    claimWork: async () => { requests += 1; },
    error: (line) => stderr.push(line),
  };

  assert.equal(await main(["work", "list"], dependencies), 1);
  assert.equal(await main(["work", "claim", "selector", "--host", "codex"], dependencies), 1);
  assert.equal(requests, 0);
  assert.equal(stderr.every((line) => /GitHub origin/.test(line)), true);
});

test("work show reads the local marker without requiring credentials", async () => {
  const stdout = [];
  let credentialReads = 0;
  const marker = {
    schemaVersion: 1,
    repoHash: "a".repeat(64),
    handoffId: "10000000-0000-4000-8000-000000000001",
    actionId: "20000000-0000-4000-8000-000000000002",
    actionVersion: 4,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  };
  const code = await main(["work", "show"], {
    resolveRepo: () => ({ fullName: "Acme/Widget", commitSha: "a".repeat(40) }),
    loadCreds: () => { credentialReads += 1; return null; },
    loadActiveHandoff: () => marker,
    log: (line) => stdout.push(line),
    error: () => {},
  });

  assert.equal(code, 0);
  assert.equal(credentialReads, 0);
  assert.deepEqual(JSON.parse(stdout.join("")), marker);
});

test("work claim stores only the marker and prints only the guided contract to stdout", async () => {
  const stdout = [];
  let saved = null;
  const contract = {
    schemaVersion: 1,
    objective: "Implement the client",
    context: "",
    acceptanceCriteria: ["Tests pass"],
    constraints: [],
    suggestedFiles: [],
    suggestedTests: [],
    dependencies: [],
    nonGoals: [],
    sourceRefs: [{ type: "runbook", label: "Plan", locator: "docs/plan.md" }],
    returnRequirements: [],
  };
  const code = await main(
    ["work", "claim", "20000000-0000-4000-8000-000000000002", "--host", "codex"],
    {
      resolveRepo: () => ({ fullName: "Acme/Widget", commitSha: "a".repeat(40) }),
      loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
      loadCreds: () => ({ apiKey: "key" }),
      loadActiveHandoff: () => null,
      claimWork: async () => ({
        handoffId: "10000000-0000-4000-8000-000000000001",
        actionId: "20000000-0000-4000-8000-000000000002",
        actionVersion: 4,
        host: "codex",
        contract,
        serverOnly: "do-not-print",
      }),
      saveActiveHandoff: (value) => { saved = value; },
      now: () => new Date("2026-07-27T10:00:00.000Z"),
      log: (line) => stdout.push(line),
      error: () => {},
    },
  );

  assert.equal(code, 0);
  assert.deepEqual(JSON.parse(stdout.join("")), contract);
  assert.deepEqual(saved, {
    repoFullName: "Acme/Widget",
    handoffId: "10000000-0000-4000-8000-000000000001",
    actionId: "20000000-0000-4000-8000-000000000002",
    actionVersion: 4,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  });
});

test("work claim refuses a second active claim before contacting the server", async () => {
  let serverClaims = 0;
  const stderr = [];
  const code = await main(
    ["work", "claim", "20000000-0000-4000-8000-000000000002", "--host", "codex"],
    {
      resolveRepo: () => ({ fullName: "Acme/Widget", commitSha: "a".repeat(40) }),
      loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
      loadCreds: () => ({ apiKey: "key" }),
      loadActiveHandoff: () => ({ handoffId: "10000000-0000-4000-8000-000000000001" }),
      claimWork: async () => { serverClaims += 1; },
      log: () => {},
      error: (line) => stderr.push(line),
    },
  );

  assert.equal(code, 1);
  assert.equal(serverClaims, 0);
  assert.equal(stderr.length, 1);
  assert.match(stderr[0], /active Codebrief work claim/i);
});

test("work claim compensates when restrictive local state cannot be written", async () => {
  const stderr = [];
  const cancelled = [];
  const apiKey = "ck_live_must_not_escape";
  const code = await main(
    ["work", "claim", "20000000-0000-4000-8000-000000000002", "--host", "claude"],
    {
      resolveRepo: () => ({ fullName: "Acme/Widget", commitSha: "a".repeat(40) }),
      loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
      loadCreds: () => ({ apiKey }),
      loadActiveHandoff: () => null,
      claimWork: async () => ({
        handoffId: "10000000-0000-4000-8000-000000000001",
        actionId: "20000000-0000-4000-8000-000000000002",
        actionVersion: 4,
        host: "claude",
        contract: { objective: "Do not print this after the failure" },
      }),
      saveActiveHandoff: () => { throw new Error(`/Users/me/.codebrief/credentials.json ${apiKey}`); },
      cancelWork: async (input) => { cancelled.push(input); },
      log: () => assert.fail("a failed local save must not print the contract"),
      error: (line) => stderr.push(line),
    },
  );

  assert.equal(code, 1);
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].handoffId, "10000000-0000-4000-8000-000000000001");
  assert.equal(stderr.length, 1);
  assert.doesNotMatch(stderr[0], /credentials|ck_live|\/Users\//);
});

test("work cancel clears local state only after the server cancellation succeeds", async () => {
  const marker = {
    handoffId: "10000000-0000-4000-8000-000000000001",
  };
  const calls = [];
  const dependencies = {
    resolveRepo: () => ({ fullName: "Acme/Widget", commitSha: "a".repeat(40) }),
    loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
    loadCreds: () => ({ apiKey: "key" }),
    loadActiveHandoff: () => marker,
    cancelWork: async (input) => { calls.push(["cancel", input]); },
    clearActiveHandoff: (repo) => { calls.push(["clear", repo]); },
    log: () => {},
    error: () => {},
  };

  assert.equal(await main(["work", "cancel"], dependencies), 0);
  assert.deepEqual(calls.map(([operation]) => operation), ["cancel", "clear"]);
  assert.equal(calls[0][1].repoFullName, "Acme/Widget");
  assert.equal(calls[0][1].handoffId, marker.handoffId);

  calls.length = 0;
  dependencies.cancelWork = async () => {
    calls.push(["cancel"]);
    throw new WorkClientError(409);
  };
  assert.equal(await main(["work", "cancel"], dependencies), 1);
  assert.deepEqual(calls.map(([operation]) => operation), ["cancel"]);
});
