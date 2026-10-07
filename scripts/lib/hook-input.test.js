import { test } from "node:test";
import assert from "node:assert";
import { readHookInput } from "./hook-input.js";

test("Claude hook input stops reading as soon as the byte limit is exceeded", async () => {
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

test("Claude hook input parses only bounded JSON objects", async () => {
  async function* stream(value) {
    yield Buffer.from(value);
  }

  assert.deepEqual(await readHookInput(stream('{"session_id":"s"}'), 100), { session_id: "s" });
  assert.deepEqual(await readHookInput(stream('["not","an","object"]'), 100), {});
});
