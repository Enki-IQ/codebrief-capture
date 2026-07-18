import { test } from "node:test";
import assert from "node:assert";
import { handleCodexPostTool } from "./codex-post-tool-hook.js";
import { handleCodexStop } from "./codex-stop-hook.js";

test("Stop debounces and only the latest uncaptured generation runs", async () => {
  let ran = 0;
  const ticket = { generation: "g" };
  const result = await handleCodexStop({ session_id: "s" }, {
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
    beginCapture: () => ({}), loadConfig: () => ({ codexDebounceMs: 0 }), sleep: async () => {},
    runCodexCapture: async () => { ran = true; return { status: "sent" }; },
  };
  assert.equal((await handleCodexStop({}, { ...common, isLatestCapture: () => false })).status, "skipped:superseded");
  assert.equal((await handleCodexStop({}, { ...common, isLatestCapture: () => true, wasCaptured: () => true })).status, "skipped:duplicate");
  assert.equal(ran, false);
});

test("PostToolUse ignores ordinary commands and captures a valid push once", async () => {
  let ran = 0;
  const ignored = await handleCodexPostTool({}, { shouldCaptureAfterTool: () => false });
  assert.equal(ignored.status, "skipped:not-trigger");
  const sent = await handleCodexPostTool({}, {
    shouldCaptureAfterTool: () => true,
    beginCapture: () => ({ fingerprint: "f" }),
    wasCaptured: () => false,
    runCodexCapture: async () => { ran += 1; return { status: "sent" }; },
    markCaptured: () => {},
  });
  assert.equal(sent.status, "sent");
  assert.equal(ran, 1);
});
