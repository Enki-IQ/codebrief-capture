import { test } from "node:test";
import assert from "node:assert";
import { reduceCodexRollout } from "./transcript-reducer.js";

const line = (type, payload) => JSON.stringify({ type, payload });

test("keeps user/assistant intent and safe tool names", () => {
  const reduced = reduceCodexRollout([
    line("event_msg", { type: "user_message", message: "Use a bounded queue." }),
    line("response_item", { type: "function_call", name: "apply_patch", arguments: "secret code" }),
    line("event_msg", { type: "agent_message", message: "I will preserve FIFO ordering." }),
  ].join("\n"));
  assert.match(reduced, /bounded queue/);
  assert.match(reduced, /apply_patch/);
  assert.match(reduced, /preserve FIFO/);
  assert.doesNotMatch(reduced, /secret code/);
});

test("drops instructions, reasoning, tool output, images, and malformed lines", () => {
  const reduced = reduceCodexRollout([
    "not-json",
    line("session_meta", { instructions: "system secret" }),
    line("response_item", { type: "reasoning", summary: ["private thought"] }),
    line("response_item", { type: "function_call_output", output: "raw source code" }),
    line("world_state", { files: ["private.ts"] }),
    line("event_msg", { type: "user_message", message: "Ship the public API", images: ["data:image/png;base64,secret"] }),
  ].join("\n"));
  assert.equal(reduced, "USER:\nShip the public API");
});

test("redacts secrets and fenced code from every retained message shape", () => {
  const secret = `sk-proj-${"a".repeat(24)}`;
  const reduced = reduceCodexRollout([
    line("response_item", {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: `Keep the API stable. Token: ${secret}` }],
    }),
    line("event_msg", {
      type: "agent_message",
      message: "Implementation result:\n```ts\nconst leakedSource = true;\n```",
    }),
  ].join("\n"));
  assert.match(reduced, /Keep the API stable/);
  assert.doesNotMatch(reduced, /sk-proj|leakedSource/);
  assert.match(reduced, /\[redacted secret\]/);
  assert.match(reduced, /\[redacted code\]/);
});

test("deduplicates event and response message copies and keeps the newest bounded tail", () => {
  const duplicate = "same intent";
  const reduced = reduceCodexRollout([
    line("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: duplicate }] }),
    line("event_msg", { type: "user_message", message: duplicate }),
    line("event_msg", { type: "agent_message", message: "newest decision" }),
  ].join("\n"), 45);
  assert.doesNotMatch(reduced, /same intent/);
  assert.match(reduced, /newest decision/);
});
