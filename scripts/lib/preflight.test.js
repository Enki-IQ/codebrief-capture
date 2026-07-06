import { test } from "node:test";
import assert from "node:assert";
import { isClaudeAvailable } from "./preflight.js";

test("available when `claude --version` exits 0", () => {
  assert.equal(isClaudeAvailable(() => ({ status: 0 })), true);
});
test("unavailable on non-zero exit or spawn error", () => {
  assert.equal(isClaudeAvailable(() => ({ status: 127 })), false);
  assert.equal(isClaudeAvailable(() => { throw new Error("ENOENT"); }), false);
});
