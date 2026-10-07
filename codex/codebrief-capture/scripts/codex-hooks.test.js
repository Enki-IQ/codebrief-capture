import { test } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import {
  classifyWithCodex,
  runActiveProjectTurn,
} from "./codex-active-project-return.js";
import { handleCodexPostTool } from "./codex-post-tool-hook.js";
import { handleCodexStop } from "./codex-stop-hook.js";

test("Stop debounces and only the latest uncaptured generation runs", async () => {
  let ran = 0;
  const ticket = { generation: "g" };
  const result = await handleCodexStop({ session_id: "s" }, {
    runActiveProjectTurn: async () => ({ status: "skipped:no-active-handoff" }),
    beginCapture: () => ticket,
    loadConfig: () => ({ codexDebounceMs: 1 }),
    sleep: async (ms) => assert.equal(ms, 1),
    isLatestCapture: () => true,
    wasCaptured: () => false,
    runCodexCapture: async () => { ran += 1; return { status: "sent" }; },
    markCaptured: (value) => assert.equal(value, ticket),
  });
  assert.equal(result.status, "sent");
  assert.equal(ran, 1);
});

test("superseded and duplicate Stop tickets do not distill", async () => {
  let ran = false;
  const common = {
    runActiveProjectTurn: async () => ({ status: "skipped:no-active-handoff" }),
    beginCapture: () => ({}), loadConfig: () => ({ codexDebounceMs: 0 }), sleep: async () => {},
    runCodexCapture: async () => { ran = true; return { status: "sent" }; },
  };
  assert.equal((await handleCodexStop({}, { ...common, isLatestCapture: () => false })).status, "skipped:superseded");
  assert.equal((await handleCodexStop({}, { ...common, isLatestCapture: () => true, wasCaptured: () => true })).status, "skipped:duplicate");
  assert.equal(ran, false);
});

test("Stop sends metadata-only completion after PostTool captured the same fingerprint", async () => {
  const phases = [];
  let captureInput;
  const result = await handleCodexStop({}, {
    runActiveProjectTurn: async () => ({ status: "skipped:no-active-handoff" }),
    beginCapture: () => ({ sourceRef: "capture-1" }),
    loadConfig: () => ({ codexDebounceMs: 0 }),
    sleep: async () => {},
    isLatestCapture: () => true,
    wasCaptured: (_ticket, phase) => phase === "content",
    runCodexCapture: async (input) => { captureInput = input; return { status: "sent" }; },
    markCaptured: (_ticket, phase) => phases.push(phase),
  });
  assert.equal(result.status, "sent");
  assert.equal(captureInput.input.capture_id, "capture-1");
  assert.equal(captureInput.input.capture_state, "complete");
  assert.equal(captureInput.input.capture_metadata_only, true);
  assert.deepEqual(phases, ["complete"]);
});

test("PostToolUse ignores ordinary commands and captures a valid push once", async () => {
  let ran = 0;
  const ignored = await handleCodexPostTool({}, { shouldCaptureAfterTool: () => false });
  assert.equal(ignored.status, "skipped:not-trigger");
  const sent = await handleCodexPostTool({}, {
    shouldCaptureAfterTool: () => true,
    runActiveProjectTurn: async (_input, { reason }) => {
      assert.equal(reason, "publish");
      return { status: "returned" };
    },
    beginCapture: () => ({ fingerprint: "f" }),
    wasCaptured: () => false,
    runCodexCapture: async () => { ran += 1; return { status: "sent" }; },
    markCaptured: () => {},
  });
  assert.equal(sent.status, "sent");
  assert.equal(ran, 1);
});

test("Stop renews or returns active work before scheduling intent capture", async () => {
  const events = [];
  const result = await handleCodexStop({ session_id: "s" }, {
    runActiveProjectTurn: async (_input, { reason }) => {
      events.push(`work:${reason}`);
      return { status: "renewed" };
    },
    beginCapture: () => ({ generation: "g" }),
    loadConfig: () => ({ codexDebounceMs: 0 }),
    sleep: async () => {},
    isLatestCapture: () => true,
    wasCaptured: () => false,
    runCodexCapture: async () => {
      events.push("capture");
      return { status: "skipped:no-intent" };
    },
    markCaptured: () => {},
  });
  assert.equal(result.status, "skipped:no-intent");
  assert.deepEqual(events, ["work:stop", "capture"]);
});

test("Codex hooks fail open when active work processing throws", async () => {
  const result = await handleCodexPostTool({}, {
    shouldCaptureAfterTool: () => true,
    runActiveProjectTurn: async () => { throw new Error("sensitive result"); },
    beginCapture: () => null,
  });
  assert.equal(result.status, "skipped:no-transcript");
});

test("Codex classification uses the shared model CLI and keeps the transcript on stdin", async () => {
  let invocation;
  const result = await classifyWithCodex({
    transcript: "ASSISTANT:\nAll focused tests passed.",
    reason: "stop",
    spawn: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 0, stdout: "{\"terminal\":false}" };
    },
  });
  assert.deepEqual(result, { terminal: false });
  assert.equal(invocation.command, "gemini");
  assert.equal(invocation.options.input, "ASSISTANT:\nAll focused tests passed.");
  assert.equal(invocation.options.env.CODEBRIEF_DISTILL_CHILD, "1");
  assert.equal(invocation.args.includes("ASSISTANT:\nAll focused tests passed."), false);
  assert.equal(invocation.args[0], "--prompt");
  assert.equal(invocation.options.cwd, tmpdir());
  assert.ok(invocation.options.timeout > 0);
});

test("Codex non-terminal turns renew the active lease without a result", async () => {
  let renewed = 0;
  let returned = 0;
  const output = await runActiveProjectTurn({ cwd: "/repo" }, {
    classify: async () => ({ terminal: false }),
    deps: {
      resolveRepo: () => ({ fullName: "acme/widget" }),
      loadActiveHandoff: () => ({
        handoffId: "11111111-1111-4111-8111-111111111111",
        startMarker: "2026-07-27T10:00:00.000Z",
      }),
      loadHandoffOutbox: () => null,
      loadCreds: () => ({ apiKey: "key" }),
      loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
      renewWork: async () => { renewed += 1; },
      returnWorkResult: async () => { returned += 1; },
    },
  });
  assert.equal(output.status, "renewed");
  assert.equal(renewed, 1);
  assert.equal(returned, 0);
});

test("Codex expired renewal clears staged and active local state", async () => {
  const events = [];
  const output = await runActiveProjectTurn({ cwd: "/repo" }, {
    classify: async () => ({ terminal: false }),
    deps: {
      resolveRepo: () => ({ fullName: "acme/widget" }),
      loadActiveHandoff: () => ({
        handoffId: "11111111-1111-4111-8111-111111111111",
        startMarker: "2026-07-27T10:00:00.000Z",
      }),
      loadHandoffOutbox: () => null,
      loadCreds: () => ({ apiKey: "key" }),
      loadConfig: () => ({ apiBaseUrl: "https://app.codebrief.ai" }),
      renewWork: async () => {
        events.push("renew");
        throw Object.assign(new Error("expired"), { status: 410 });
      },
      removeHandoffOutbox: () => events.push("remove"),
      clearActiveHandoff: () => events.push("clear"),
    },
  });

  assert.deepEqual(output, { status: "error:expired" });
  assert.deepEqual(events, ["renew", "remove", "clear"]);
});

test("Codex Stop overlaps active classification with debounce and intent capture", async () => {
  let releaseActive;
  const activePending = new Promise((resolve) => { releaseActive = resolve; });
  const events = [];
  const running = handleCodexStop({}, {
    runActiveProjectTurn: async () => {
      events.push("work");
      await activePending;
      return { status: "renewed" };
    },
    beginCapture: () => ({}),
    loadConfig: () => ({ codexDebounceMs: 0 }),
    sleep: async () => {},
    isLatestCapture: () => true,
    wasCaptured: () => false,
    runCodexCapture: async () => {
      events.push("capture");
      return { status: "sent" };
    },
    markCaptured: () => {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startedBeforeRelease = [...events];
  releaseActive();
  await running;
  assert.deepEqual(startedBeforeRelease, ["work", "capture"]);
});
