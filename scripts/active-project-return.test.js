import { test } from "node:test";
import assert from "node:assert";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyWithClaude,
  handleActiveProjectTurn,
  resultFingerprint,
  submitActiveProjectResult,
  withSubmissionLock,
} from "./active-project-return.js";
import {
  classifyWithCodex,
  submitActiveProjectResult as submitCodexActiveProjectResult,
  withSubmissionLock as withCodexSubmissionLock,
} from "../codex/codebrief-capture/scripts/codex-active-project-return.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ID = "11111111-1111-4111-8111-111111111111";

function result(status = "passed") {
  return {
    schemaVersion: 2,
    outcome: "completed",
    checks: [{ kind: "tests", status }],
    references: [],
    blockers: [],
  };
}

function active(host = "claude") {
  return {
    schemaVersion: 1,
    repoHash: "a".repeat(64),
    handoffId: HANDOFF_ID,
    actionId: "22222222-2222-4222-8222-222222222222",
    actionVersion: 3,
    host,
    startMarker: "2026-07-27T10:00:00.000Z",
  };
}

function deps(overrides = {}) {
  let outbox = null;
  return {
    resolveRepo: () => ({ fullName: "acme/widget" }),
    loadCreds: () => ({ apiKey: "secret", apiBaseUrl: "https://app.codebrief.ai" }),
    loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
    loadActiveHandoff: () => active(),
    loadHandoffOutbox: () => outbox,
    saveHandoffOutbox: (entry) => { outbox = entry; return entry; },
    removeHandoffOutbox: () => { outbox = null; },
    clearActiveHandoff: () => {},
    returnWorkResult: async () => ({ proposalId: "proposal-1" }),
    renewWork: async () => ({ leaseExpiresAt: "2026-07-27T18:00:00.000Z" }),
    withSubmissionLock: async (_handoffId, operation) => operation(),
    ...overrides,
  };
}

test("canonical result fingerprints ignore unvalidated input ordering", () => {
  const first = result();
  const second = {
    blockers: [],
    references: first.references,
    checks: first.checks,
    outcome: first.outcome,
    schemaVersion: 2,
  };
  assert.equal(resultFingerprint(first), resultFingerprint(second));
  assert.match(resultFingerprint(first), /^[0-9a-f]{64}$/);
});

test("explicit return validates, stages, submits, then clears local handoff state", async () => {
  const events = [];
  const d = deps({
    saveHandoffOutbox: (entry) => { events.push(["stage", entry]); return entry; },
    returnWorkResult: async (request) => {
      events.push(["submit", request]);
      return { proposalId: "proposal-1" };
    },
    removeHandoffOutbox: () => events.push(["remove"]),
    clearActiveHandoff: (repo) => events.push(["clear", repo]),
  });

  const output = await submitActiveProjectResult({ cwd: "/repo", result: result() }, d);

  assert.equal(output.status, "returned");
  assert.match(output.fingerprint, /^[0-9a-f]{64}$/);
  assert.deepEqual(events.map(([event]) => event), ["stage", "submit", "remove", "clear"]);
  assert.deepEqual(events[1][1].result, result());
  assert.equal(JSON.stringify(output).includes("secret"), false);
});

test("failed submission retains the bounded structured outbox and fails open", async () => {
  let staged;
  const output = await submitActiveProjectResult({ cwd: "/repo", result: result() }, deps({
    saveHandoffOutbox: (entry) => { staged = entry; return entry; },
    returnWorkResult: async () => { throw new Error("response echoed private transcript"); },
  }));
  assert.equal(output.status, "error:submit");
  assert.deepEqual(staged.result, result());
  assert.equal(JSON.stringify(output).includes("private transcript"), false);
});

test("expired result submission removes staged evidence and clears the active marker", async () => {
  for (const submit of [submitActiveProjectResult, submitCodexActiveProjectResult]) {
    const events = [];
    const output = await submit({ cwd: "/repo", result: result() }, deps({
      saveHandoffOutbox: (entry) => {
        events.push("stage");
        return entry;
      },
      returnWorkResult: async () => {
        events.push("submit");
        throw Object.assign(new Error("expired"), { status: 410 });
      },
      removeHandoffOutbox: () => events.push("remove"),
      clearActiveHandoff: () => events.push("clear"),
    }));

    assert.equal(output.status, "error:expired");
    assert.deepEqual(events, ["stage", "submit", "remove", "clear"]);
  }
});

test("expired result cleanup still clears the active marker when outbox removal fails", async () => {
  for (const submit of [submitActiveProjectResult, submitCodexActiveProjectResult]) {
    const events = [];
    const output = await submit({ cwd: "/repo", result: result() }, deps({
      returnWorkResult: async () => {
        throw Object.assign(new Error("expired"), { status: 410 });
      },
      removeHandoffOutbox: () => {
        events.push("remove");
        throw new Error("outbox unavailable");
      },
      clearActiveHandoff: () => events.push("clear"),
    }));

    assert.equal(output.status, "error:submit");
    assert.deepEqual(events, ["remove", "clear"]);
  }
});

test("validated terminal evidence is staged before submission lock acquisition", async () => {
  const events = [];
  const output = await submitActiveProjectResult({ cwd: "/repo", result: result() }, deps({
    saveHandoffOutbox: (entry) => {
      events.push("stage");
      return entry;
    },
    withSubmissionLock: async () => {
      events.push("lock");
      return { status: "skipped:in-flight" };
    },
  }));

  assert.deepEqual(events, ["stage", "lock"]);
  assert.deepEqual(output, { status: "skipped:in-flight" });
});

test("an existing outbox wins so explicit, publish, and end-session paths converge", async () => {
  const first = result("passed");
  let submitted;
  const output = await submitActiveProjectResult({
    cwd: "/repo",
    result: result("failed"),
  }, deps({
    loadHandoffOutbox: () => ({ schemaVersion: 1, handoffId: HANDOFF_ID, result: first }),
    saveHandoffOutbox: () => assert.fail("must not replace the first result"),
    returnWorkResult: async ({ result: submittedResult }) => {
      submitted = submittedResult;
      return { proposalId: "proposal-1" };
    },
  }));
  assert.deepEqual(submitted, first);
  assert.equal(output.fingerprint, resultFingerprint(first));
});

test("a recent malformed submission lock is never replaced or deleted", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
  process.env.CODEBRIEF_CONFIG_DIR = base;
  const directory = join(base, "active-project-locks");
  const path = join(directory, `${HANDOFF_ID}.lock`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, "another-owner", { mode: 0o600 });
  let ran = false;
  try {
    const output = await withSubmissionLock(HANDOFF_ID, async () => {
      ran = true;
      return { status: "returned" };
    });
    assert.deepEqual(output, { status: "skipped:in-flight" });
    assert.equal(ran, false);
    assert.equal(existsSync(path), true);
    assert.equal(readFileSync(path, "utf8"), "another-owner");
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission lock release does not delete a replacement lock", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
  process.env.CODEBRIEF_CONFIG_DIR = base;
  const path = join(base, "active-project-locks", `${HANDOFF_ID}.lock`);
  try {
    const output = await withSubmissionLock(HANDOFF_ID, async () => {
      rmSync(path);
      writeFileSync(path, "new-owner", { mode: 0o600 });
      return { status: "returned" };
    });
    assert.deepEqual(output, { status: "returned" });
    assert.equal(readFileSync(path, "utf8"), "new-owner");
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission lock atomically publishes a complete owner record", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
  process.env.CODEBRIEF_CONFIG_DIR = base;
  const path = join(base, "active-project-locks", `${HANDOFF_ID}.lock`);
  try {
    await withSubmissionLock(HANDOFF_ID, async () => {
      const owner = JSON.parse(readFileSync(path, "utf8"));
      assert.deepEqual(Object.keys(owner).sort(), ["createdAtMs", "nonce", "pid", "uid"]);
      assert.match(owner.nonce, /^[0-9a-f]{32}$/);
      assert.equal(owner.uid, process.getuid());
      return { status: "returned" };
    });
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission lock recovers an old same-UID malformed partial record", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  try {
    for (const lockAdapter of [withSubmissionLock, withCodexSubmissionLock]) {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
      process.env.CODEBRIEF_CONFIG_DIR = base;
      const directory = join(base, "active-project-locks");
      const path = join(directory, `${HANDOFF_ID}.lock`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path, '{"pid":', { mode: 0o600 });
      const old = Date.now() - 10 * 60 * 1000;
      utimesSync(path, new Date(old), new Date(old));
      let ran = false;
      const output = await lockAdapter(HANDOFF_ID, async () => {
        ran = true;
        return { status: "returned" };
      });
      assert.deepEqual(output, { status: "returned" });
      assert.equal(ran, true);
      assert.equal(existsSync(path), false);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission locks reject symlinked managed directories without chmod side effects", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  try {
    for (const lockAdapter of [withSubmissionLock, withCodexSubmissionLock]) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
      const base = join(root, "config");
      const target = join(root, "target");
      mkdirSync(base, { mode: 0o700 });
      mkdirSync(target, { mode: 0o755 });
      symlinkSync(target, join(base, "active-project-locks"));
      process.env.CODEBRIEF_CONFIG_DIR = base;

      await assert.rejects(() => lockAdapter(HANDOFF_ID, async () => {
        assert.fail("operation must not run through a symlink");
      }), /unsafe|symlink/i);
      assert.equal(statSync(target).mode & 0o777, 0o755);
      assert.equal(lstatSync(join(base, "active-project-locks")).isSymbolicLink(), true);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission locks reject a final lock symlink without chmod side effects", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  try {
    for (const lockAdapter of [withSubmissionLock, withCodexSubmissionLock]) {
      const base = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
      const directory = join(base, "active-project-locks");
      const target = join(base, "target");
      const path = join(directory, `${HANDOFF_ID}.lock`);
      mkdirSync(directory, { mode: 0o700 });
      writeFileSync(target, "do-not-touch", { mode: 0o644 });
      symlinkSync(target, path);
      process.env.CODEBRIEF_CONFIG_DIR = base;

      await assert.rejects(() => lockAdapter(HANDOFF_ID, async () => {
        assert.fail("operation must not run through a symlink");
      }), /unsafe|symlink|loop/i);
      const descriptor = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        assert.equal(fstatSync(descriptor).mode & 0o777, 0o644);
        assert.equal(readFileSync(descriptor, "utf8"), "do-not-touch");
      } finally {
        closeSync(descriptor);
      }
    }
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("submission locks reject symlinked ancestors", async () => {
  const previous = process.env.CODEBRIEF_CONFIG_DIR;
  try {
    for (const lockAdapter of [withSubmissionLock, withCodexSubmissionLock]) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "cb-lock-")));
      const target = join(root, "target");
      const alias = join(root, "alias");
      mkdirSync(target, { mode: 0o755 });
      symlinkSync(target, alias);
      process.env.CODEBRIEF_CONFIG_DIR = alias;

      await assert.rejects(() => lockAdapter(HANDOFF_ID, async () => {
        assert.fail("operation must not run through a symlink");
      }), /unsafe|symlink|loop/i);
      assert.equal(statSync(target).mode & 0o777, 0o755);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_CONFIG_DIR;
    else process.env.CODEBRIEF_CONFIG_DIR = previous;
  }
});

test("non-terminal post-marker work renews without returning a proposal", async () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "cb-return-")), "session.jsonl");
  writeFileSync(transcript, [
    JSON.stringify({ timestamp: "2026-07-27T09:59:59.000Z", type: "user", message: { content: "old secret" } }),
    JSON.stringify({ timestamp: "2026-07-27T10:00:01.000Z", type: "assistant", message: { content: [{ type: "text", text: "Still implementing." }] } }),
    JSON.stringify({ timestamp: "2026-07-27T10:00:02.000Z", type: "user", message: { content: [{ type: "tool_result", content: "raw tool output" }] } }),
  ].join("\n"));
  let renewed = 0;
  let returned = 0;
  const output = await handleActiveProjectTurn({
    input: { cwd: "/repo", transcript_path: transcript, session_id: "session-1" },
    reason: "session_end",
    classify: async ({ transcript: reduced, reason }) => {
      assert.equal(reason, "session_end");
      assert.match(reduced, /Still implementing/);
      assert.doesNotMatch(reduced, /old secret|raw tool output/);
      return { terminal: false };
    },
  }, deps({
    renewWork: async () => { renewed += 1; return {}; },
    returnWorkResult: async () => { returned += 1; return {}; },
  }));
  assert.equal(output.status, "renewed");
  assert.equal(renewed, 1);
  assert.equal(returned, 0);
});

test("expired renewal removes any staged result and clears the active marker", async () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "cb-return-")), "session.jsonl");
  writeFileSync(transcript, `${JSON.stringify({
    timestamp: "2026-07-27T10:00:01.000Z",
    type: "assistant",
    message: { content: "Still working." },
  })}\n`);
  const events = [];
  const output = await handleActiveProjectTurn({
    input: { cwd: "/repo", transcript_path: transcript },
    classify: async () => ({ terminal: false }),
  }, deps({
    renewWork: async () => {
      events.push("renew");
      throw Object.assign(new Error("expired"), { status: 410 });
    },
    removeHandoffOutbox: () => events.push("remove"),
    clearActiveHandoff: () => events.push("clear"),
  }));

  assert.deepEqual(output, { status: "error:expired" });
  assert.deepEqual(events, ["renew", "remove", "clear"]);
});

test("terminal classification returns exactly one validated result", async () => {
  const transcript = join(mkdtempSync(join(tmpdir(), "cb-return-")), "session.jsonl");
  writeFileSync(transcript, `${JSON.stringify({
    timestamp: "2026-07-27T10:00:01.000Z",
    type: "assistant",
    message: { content: "Implemented and tests pass." },
  })}\n`);
  let submitted = 0;
  const output = await handleActiveProjectTurn({
    input: { cwd: "/repo", transcript_path: transcript },
    reason: "publish",
    classify: async ({ reason }) => {
      assert.equal(reason, "publish");
      return { terminal: true, result: result() };
    },
  }, deps({
    returnWorkResult: async () => { submitted += 1; return {}; },
  }));
  assert.equal(output.status, "returned");
  assert.equal(submitted, 1);
});

test("classification pipes reduced transcript on stdin through the shared model CLI", async () => {
  let invocation;
  const classified = await classifyWithClaude({
    transcript: "ASSISTANT:\nWork is complete.",
    reason: "session_end",
    spawn: (command, args, options) => {
      const schemaPath = args[args.indexOf("--schema-file") + 1];
      invocation = { command, args, options, schema: JSON.parse(readFileSync(schemaPath, "utf8")) };
      return {
        status: 0,
        stdout: JSON.stringify({ response: JSON.stringify({ terminal: true, result: result() }) }),
      };
    },
  });
  assert.equal(classified.terminal, true);
  assert.equal(invocation.command, "gemini");
  assert.equal(invocation.options.input, "ASSISTANT:\nWork is complete.");
  assert.equal(invocation.options.env.CODEBRIEF_DISTILL_CHILD, "1");
  assert.equal(invocation.args.includes("ASSISTANT:\nWork is complete."), false);
  assert.equal(invocation.args[invocation.args.indexOf("--model") + 1], "gemini-3.8-flash");
  assert.equal(invocation.options.cwd, tmpdir());
  const schema = invocation.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["terminal", "result"]);
  assert.equal(schema.properties.result.additionalProperties, false);
  assert.deepEqual(
    schema.properties.result.required,
    ["schemaVersion", "outcome", "checks", "references", "blockers"],
  );
  assert.deepEqual(Object.keys(schema.properties.result.properties), [
    "schemaVersion",
    "outcome",
    "checks",
    "references",
    "blockers",
  ]);
  assert.equal(schema.properties.result.properties.schemaVersion.const, 2);
  assert.equal(schema.properties.result.properties.checks.items.additionalProperties, false);
  assert.equal(schema.properties.result.properties.references.maxItems, 0);
});

test("classification requests the closed v2 facts contract for every host", async () => {
  let prompt;
  let schema;
  const classified = await classifyWithCodex({
    transcript: "ASSISTANT:\nWork is complete.",
    reason: "stop",
    spawn: (_command, args) => {
      prompt = args[args.indexOf("--prompt") + 1];
      schema = JSON.parse(readFileSync(args[args.indexOf("--schema-file") + 1], "utf8"));
      return { status: 0, stdout: JSON.stringify({ terminal: true, result: result() }) };
    },
  });

  assert.equal(classified.terminal, true);
  assert.match(prompt, /schemaVersion=2/);
  assert.match(prompt, /checks.*kind.*status/s);
  assert.match(prompt, /references.*always be \[\]/s);
  assert.match(prompt, /blockers.*dependency.*permissions.*environment.*review.*unknown/s);
  assert.doesNotMatch(prompt, /summary|detail|test locators|recommendedCurrentState/i);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["terminal", "result"]);
  assert.deepEqual(
    schema.properties.result.required,
    ["schemaVersion", "outcome", "checks", "references", "blockers"],
  );
  assert.equal(schema.properties.result.properties.schemaVersion.const, 2);
  assert.equal(schema.properties.result.properties.references.maxItems, 0);
});

test("provider classification scrubs credentials at the final spawn boundary", async () => {
  const transcript = [
    "Work is complete.",
    `ghp_${"a".repeat(36)}`,
    `glpat-${"b".repeat(24)}`,
    `npm_${"b".repeat(36)}`,
    `sk_live_${"c".repeat(24)}`,
    `ASIA${"D".repeat(16)}`,
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
    `Authorization: Bearer ${"e".repeat(32)}`,
  ].join("\n");

  for (const classify of [classifyWithClaude, classifyWithCodex]) {
    let providerInput;
    await classify({
      transcript,
      reason: "session_end",
      spawn: (_command, _args, options) => {
        providerInput = options.input;
        return { status: 1, stdout: "" };
      },
    });
    assert.match(providerInput, /Work is complete/);
    assert.doesNotMatch(providerInput, /ghp_|glpat-|npm_|sk_live_|ASIA|xoxb-|Authorization:/);
  }
});

test("work and return skills preserve the guided contract and stdin-only result boundary", () => {
  for (const hostRoot of [
    join(HERE, ".."),
    join(HERE, "..", "codex", "codebrief-capture"),
  ]) {
    const work = readFileSync(join(hostRoot, "skills", "codebrief-work", "SKILL.md"), "utf8");
    const returned = readFileSync(join(hostRoot, "skills", "codebrief-return", "SKILL.md"), "utf8");
    assert.match(work, /work list/);
    assert.match(work, /work claim/);
    assert.match(work, /objective.*context.*acceptanceCriteria.*constraints.*suggestedFiles.*suggestedTests.*dependencies.*nonGoals.*sourceRefs.*returnRequirements/s);
    assert.match(work, /verify all\s+suggested files and tests/is);
    assert.match(work, /normal\s+local permissions/i);
    assert.doesNotMatch(work, /^allowed-tools:/m);
    assert.match(work, /codebrief-return/);
    assert.match(returned, /completed.*partial.*blocked.*no_change/s);
    assert.match(returned, /schemaVersion: 2/);
    assert.match(returned, /tests.*lint.*types.*build.*review/s);
    assert.match(returned, /dependency.*permissions.*environment.*review.*unknown/s);
    assert.match(returned, /stdin/i);
    assert.doesNotMatch(returned, /result\.json["']?\s*$/m);
    assert.match(returned, /source code|patch|diff|transcript|tool output/i);
  }
});

test("package validation covers both host adapters, exact skill names, and shared drift", () => {
  const validator = readFileSync(join(HERE, "validate-package.js"), "utf8");
  assert.match(validator, /scripts\/active-project-return\.js/);
  assert.match(validator, /scripts\/codex-active-project-return\.js/);
  assert.match(validator, /const requiredSkills = \["codebrief-work", "codebrief-return"\]/);
  assert.match(validator, /skill frontmatter name must match directory/);
  assert.match(validator, /generated shared file is stale/);
});
