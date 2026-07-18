import { test } from "node:test";
import assert from "node:assert";
import { readLoginKey } from "./read-key.js";

test("--key wins and is trimmed", async () => {
  const k = await readLoginKey(["--key", "  ak_abc  "], { isTTY: true, hasPipedKey: () => false, readPiped: async () => "PIPED", readHidden: async () => "HIDDEN" });
  assert.equal(k, "ak_abc");
});
test("piped stdin used when not a TTY and no --key", async () => {
  const k = await readLoginKey([], { isTTY: false, hasPipedKey: () => true, readPiped: async () => "  ak_piped ", readHidden: async () => "HIDDEN" });
  assert.equal(k, "ak_piped");
});
test("hidden TTY prompt used when interactive and no --key", async () => {
  const k = await readLoginKey([], { isTTY: true, hasPipedKey: () => false, readPiped: async () => "PIPED", readHidden: async () => "  ak_hidden " });
  assert.equal(k, "ak_hidden");
});
test("a non-TTY character device with no piped data returns without reading", async () => {
  const k = await readLoginKey([], {
    isTTY: false,
    hasPipedKey: () => false,
    readPiped: async () => assert.fail("must not wait for non-piped stdin"),
    readHidden: async () => assert.fail("must not prompt on a non-TTY device"),
  });
  assert.equal(k, "");
});
