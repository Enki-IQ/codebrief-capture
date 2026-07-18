import { test } from "node:test";
import assert from "node:assert";
import { readHookInput } from "./hook-input.js";

test("returns immediately and closes the iterator when hook input exceeds the limit", async () => {
  let requestedAnotherChunk = false;
  let closed = false;
  async function* oversizedInput() {
    try {
      yield Buffer.alloc(6);
      requestedAnotherChunk = true;
      yield Buffer.alloc(6);
    } finally {
      closed = true;
    }
  }
  assert.deepEqual(await readHookInput(oversizedInput(), 5), {});
  assert.equal(requestedAnotherChunk, false);
  assert.equal(closed, true);
});

test("parses a bounded object and rejects non-object JSON", async () => {
  async function* stream(value) { yield Buffer.from(value); }
  assert.deepEqual(await readHookInput(stream('{"session_id":"s"}'), 100), { session_id: "s" });
  assert.deepEqual(await readHookInput(stream('["not","an","object"]'), 100), {});
});
