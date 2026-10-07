import { test } from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handleSessionEnd,
  runCapture,
  spawnDetachedSessionEnd,
  spawnDistillChild,
} from "./session-end-hook.js";
import { IngestError } from "./lib/http.js";

test("no-op when repo is not enabled", async () => {
  let posted = false;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: { resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => false,
      loadCreds: () => ({ apiKey: "t" }), distill: () => [{ kind: "plan", summary: "x" }],
      postIntent: async () => { posted = true; return { accepted: 1, dropped: [] }; }, loadConfig: () => ({ apiBaseUrl: "http://x" }) },
  });
  assert.equal(out.status, "skipped:not-enabled");
  assert.equal(posted, false);
});

test("no-op (with hint) when not logged in", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: { resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => null, distill: () => [], postIntent: async () => ({}), loadConfig: () => ({ apiBaseUrl: "http://x" }) },
  });
  assert.equal(out.status, "skipped:no-auth");
});

test("happy path distills, pre-scrubs, and posts", async () => {
  let sent = null;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "t" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }, { kind: "plan", summary: "```code```" }],
      createCaptureId: () => "capture-11111111-1111-4111-8111-111111111111",
      postIntent: async ({ records }) => { sent = records; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(sent.length, 1); // the code-fenced record dropped by pre-scrub
});

test("surfaces a new-key hint when the CLI key is rejected (401)", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "dead" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      postIntent: async () => { throw new IngestError(401, { error: "unauthorized" }); },
    },
  });
  assert.equal(out.status, "error:auth");
});

test("surfaces a repo-not-connected hint on 403", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      postIntent: async () => { throw new IngestError(403, { error: "forbidden" }); },
    },
  });
  assert.equal(out.status, "error:repo");
});

test("flags a missing model CLI when distill yields nothing and the CLI is absent", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [], isDistillerAvailable: () => false,
      postIntent: async () => ({ accepted: 0, dropped: [] }),
    },
  });
  assert.equal(out.status, "skipped:no-model");
});

test("empty distill with the model CLI present is plain no-intent (not no-model)", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [], isDistillerAvailable: () => true,
      postIntent: async () => ({ accepted: 0, dropped: [] }),
    },
  });
  assert.equal(out.status, "skipped:no-intent");
});

test("does not forward an unsafe hook session id as sourceRef", async () => {
  let sent;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "session\nleak" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      createCaptureId: () => "capture-11111111-1111-4111-8111-111111111111",
      postIntent: async ({ records }) => { sent = records; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(sent[0].sourceRef, "capture-11111111-1111-4111-8111-111111111111");
});

test("rolling capture id overrides provider and distilled source refs", async () => {
  let payload;
  const out = await runCapture({
    input: {
      cwd: "/x",
      transcript_path: "/t",
      session_id: "provider-session",
      capture_id: "capture-22222222-2222-4222-8222-222222222222",
      capture_state: "in_progress",
    },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login", sourceRef: "model-session" }],
      postIntent: async (input) => { payload = input; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(payload.records[0].sourceRef, "capture-22222222-2222-4222-8222-222222222222");
  assert.equal(payload.capture.sourceRef, "capture-22222222-2222-4222-8222-222222222222");
});

test("preserves a structurally valid opaque capture id even when it resembles a secret", async () => {
  let payload;
  const sourceRef = `sk-${"a".repeat(24)}`;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", capture_id: sourceRef, capture_state: "in_progress" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      createCaptureId: () => "capture-unexpected-fallback",
      postIntent: async (input) => { payload = input; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(payload.capture.sourceRef, sourceRef);
  assert.equal(payload.records[0].sourceRef, sourceRef);
});

test("metadata-only completion posts no intents and does not invoke the distiller", async () => {
  let distilled = false;
  let payload;
  const out = await runCapture({
    input: {
      cwd: "/x",
      transcript_path: "/t",
      capture_id: "capture-33333333-3333-4333-8333-333333333333",
      capture_state: "complete",
      capture_metadata_only: true,
    },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => { distilled = true; return []; },
      postIntent: async (input) => { payload = input; return { accepted: 0, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(distilled, false);
  assert.deepEqual(payload.records, []);
  assert.deepEqual(payload.capture, {
    version: 1,
    sourceRef: "capture-33333333-3333-4333-8333-333333333333",
    host: "claude",
    state: "complete",
  });
});

test("SessionEnd processes active project work before ordinary intent capture", async () => {
  const events = [];
  const output = await handleSessionEnd({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    reason: "session_end",
    deps: {
      handleActiveProjectTurn: async ({ reason }) => {
        events.push(`work:${reason}`);
        return { status: "renewed" };
      },
      beginCapture: () => ({ sourceRef: "capture-1" }),
      isLatestCapture: () => true,
      wasCaptured: () => false,
      markCaptured: () => {},
      runCapture: async () => {
        events.push("capture");
        return { status: "sent" };
      },
    },
  });
  assert.deepEqual(events, ["work:session_end", "capture"]);
  assert.deepEqual(output, { activeProject: "renewed", capture: "sent" });
});

test("SessionEnd remains fail-open when active project return fails", async () => {
  const output = await handleSessionEnd({
    input: { cwd: "/x" },
    deps: {
      handleActiveProjectTurn: async () => { throw new Error("sensitive provider output"); },
      runCapture: async () => ({ status: "skipped:no-intent" }),
    },
  });
  assert.deepEqual(output, { activeProject: "error", capture: "skipped:no-transcript" });
});

test("Claude publish and completion reuse one local opaque capture id without a host session id", async (t) => {
  const stateRoot = mkdtempSync(join(tmpdir(), "cb-claude-capture-"));
  const previousConfigDir = process.env.CODEBRIEF_CONFIG_DIR;
  t.after(() => {
    if (previousConfigDir === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previousConfigDir;
  });
  process.env.CODEBRIEF_CONFIG_DIR = join(stateRoot, "config");
  const transcriptPath = join(stateRoot, "transcript.jsonl");
  writeFileSync(transcriptPath, "first turn\n");
  const captures = [];
  const deps = {
    handleActiveProjectTurn: async () => ({ status: "skipped:no-active-handoff" }),
    runCapture: async ({ input }) => {
      captures.push(input);
      return { status: "sent" };
    },
  };

  const published = await handleSessionEnd({
    input: { cwd: "/repo", transcript_path: transcriptPath },
    reason: "publish",
    deps,
  });
  const completed = await handleSessionEnd({
    input: { cwd: "/repo", transcript_path: transcriptPath },
    reason: "session_end",
    deps,
  });

  assert.equal(published.capture, "sent");
  assert.equal(completed.capture, "sent");
  assert.match(captures[0].capture_id, /^capture-[0-9a-f-]{36}$/);
  assert.equal(captures[1].capture_id, captures[0].capture_id);
  assert.equal(captures[0].capture_state, "in_progress");
  assert.equal(captures[0].capture_metadata_only, false);
  assert.equal(captures[1].capture_state, "complete");
  assert.equal(captures[1].capture_metadata_only, true);

  const duplicate = await handleSessionEnd({
    input: { cwd: "/repo", transcript_path: transcriptPath },
    reason: "session_end",
    deps,
  });
  assert.equal(duplicate.capture, "skipped:duplicate");
  assert.equal(captures.length, 2);

  appendFileSync(transcriptPath, "next turn\n");
  const next = await handleSessionEnd({
    input: { cwd: "/repo", transcript_path: transcriptPath },
    reason: "publish",
    deps,
  });
  assert.equal(next.capture, "sent");
  assert.equal(captures[2].capture_id, captures[0].capture_id);
  assert.equal(captures[2].capture_metadata_only, false);
});

test("ordinary distillation inherits the recursion sentinel", () => {
  let options;
  const output = spawnDistillChild("gemini", ["--prompt", "prompt"], {
    input: "reduced transcript",
    env: { EXISTING: "kept" },
  }, (_command, _args, spawnOptions) => {
    options = spawnOptions;
    return { status: 0 };
  });
  assert.equal(output.status, 0);
  assert.equal(options.env.EXISTING, "kept");
  assert.equal(options.env.CODEBRIEF_DISTILL_CHILD, "1");
});

test("SessionEnd does not serialize active classification and intent distillation", async () => {
  let releaseActive;
  const activePending = new Promise((resolve) => { releaseActive = resolve; });
  const events = [];
  const running = handleSessionEnd({
    input: { cwd: "/x" },
    deps: {
      handleActiveProjectTurn: async () => {
        events.push("work");
        await activePending;
        return { status: "renewed" };
      },
      beginCapture: () => ({ sourceRef: "capture-1" }),
      isLatestCapture: () => true,
      wasCaptured: () => false,
      markCaptured: () => {},
      runCapture: async () => {
        events.push("capture");
        return { status: "sent" };
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeRelease = [...events];
  releaseActive();
  await running;
  assert.deepEqual(startedBeforeRelease, ["work", "capture"]);
});

test("SessionEnd entrypoint can detach bounded work from host shutdown", () => {
  let invocation;
  const writes = [];
  let unrefed = false;
  const child = {
    on: () => {},
    stdin: {
      on: () => {},
      end: (payload, callback) => {
        writes.push(JSON.parse(payload));
        callback();
      },
    },
    unref: () => { unrefed = true; },
  };
  let done = 0;
  spawnDetachedSessionEnd({
    cwd: "/repo",
    transcript_path: "/rollout.jsonl",
    session_id: "session-1",
    tool_input: { command: "private command" },
  }, "session_end", (_command, args, options) => {
    invocation = { args, options };
    return child;
  }, () => { done += 1; });
  assert.ok(invocation.args.includes("--background"));
  assert.ok(invocation.args.includes("--session-end"));
  assert.equal(invocation.options.detached, true);
  assert.deepEqual(writes, [{
    cwd: "/repo",
    transcript_path: "/rollout.jsonl",
    session_id: "session-1",
  }]);
  assert.equal(unrefed, true);
  assert.equal(done, 1);
});
