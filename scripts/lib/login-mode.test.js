import { test } from "node:test";
import assert from "node:assert";
import { chooseLoginMode } from "./login-mode.js";

test("explicit --key forces paste mode (even with no piped input)", () => {
  assert.equal(chooseLoginMode(["--key", "ak_x"], { piped: false }), "paste");
});
test("a key piped/redirected on stdin uses paste mode", () => {
  assert.equal(chooseLoginMode([], { piped: true }), "paste");
});
test("no --key and no piped input uses browser mode (interactive terminal OR Claude-launched)", () => {
  assert.equal(chooseLoginMode([], { piped: false }), "browser");
});
