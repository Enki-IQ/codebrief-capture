import { test } from "node:test";
import assert from "node:assert";
import { isClaudeAvailable, isCodexAvailable, isDistillerAvailable } from "./preflight.js";

test("available when `claude --version` exits 0", () => {
  assert.equal(isClaudeAvailable(() => ({ status: 0 })), true);
});
test("unavailable on non-zero exit or spawn error", () => {
  assert.equal(isClaudeAvailable(() => ({ status: 127 })), false);
  assert.equal(isClaudeAvailable(() => { throw new Error("ENOENT"); }), false);
});

test("distillation checks the configured model CLI, not the capture host", () => {
  const previous = process.env.CODEBRIEF_DISTILL_COMMAND;
  delete process.env.CODEBRIEF_DISTILL_COMMAND;
  try {
    let executable = "";
    assert.equal(isDistillerAvailable((name) => { executable = name; return { status: 0 }; }), true);
    assert.equal(executable, "gemini");
    assert.equal(isDistillerAvailable(() => ({ status: 127 })), false);
  } finally {
    if (previous === undefined) delete process.env.CODEBRIEF_DISTILL_COMMAND;
    else process.env.CODEBRIEF_DISTILL_COMMAND = previous;
  }
});

test("checks Codex availability independently", () => {
  let executable = "";
  assert.equal(isCodexAvailable((name) => { executable = name; return { status: 0 }; }), true);
  assert.equal(executable, "codex");
  assert.equal(isCodexAvailable(() => ({ status: 127 })), false);
});
