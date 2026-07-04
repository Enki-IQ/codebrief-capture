import { test } from "node:test";
import assert from "node:assert";
import { spawnDetachedCapture } from "./push-capture-hook.js";

function fakeChild() {
  const writes = [];
  return {
    on: () => {},
    stdin: {
      end: (s, cb) => { writes.push(s); if (cb) cb(); },
      on: () => {},
    },
    unref: () => {},
    _writes: writes,
  };
}

test("spawns node against session-end-hook.js, detached, with its own stdin pipe", () => {
  let captured = null;
  const child = fakeChild();
  const fakeSpawn = (cmd, args, opts) => { captured = { cmd, args, opts }; return child; };
  spawnDetachedCapture({ cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" }, fakeSpawn);
  assert.equal(captured.cmd, process.execPath);
  assert.ok(captured.args.some((a) => a.endsWith("session-end-hook.js")));
  assert.equal(captured.opts.detached, true);
  assert.deepEqual(captured.opts.stdio, ["pipe", "ignore", "ignore"]);
});

test("forwards only cwd/transcript_path/session_id — never the full PostToolUse input (e.g. tool_input.command)", () => {
  const child = fakeChild();
  const fakeSpawn = () => child;
  spawnDetachedCapture(
    { cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1", tool_name: "Bash", tool_input: { command: "git push origin main" } },
    fakeSpawn,
  );
  const forwarded = JSON.parse(child._writes[0]);
  assert.deepEqual(forwarded, { cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" });
});

test("unrefs the child so the parent process can exit immediately without waiting on it", () => {
  let unrefed = false;
  const child = fakeChild();
  child.unref = () => { unrefed = true; };
  const fakeSpawn = () => child;
  spawnDetachedCapture({ cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" }, fakeSpawn);
  assert.equal(unrefed, true);
});

test("calls onDone only once the stdin write to the child actually completes (never exits before the payload flushes)", () => {
  let flushed = false;
  let onDoneCalledAfterFlush = null;
  const child = {
    on: () => {},
    stdin: {
      end: (s, cb) => {
        // Simulate an async flush: onDone must not have been invoked before this callback fires.
        flushed = true;
        cb();
      },
      on: () => {},
    },
    unref: () => {},
  };
  const fakeSpawn = () => child;
  const onDone = () => { onDoneCalledAfterFlush = flushed; };
  spawnDetachedCapture({ cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" }, fakeSpawn, onDone);
  assert.equal(onDoneCalledAfterFlush, true);
});

test("calls onDone on a stdin error instead of hanging forever waiting for the write callback", () => {
  let onDoneCalled = false;
  const child = {
    on: () => {},
    stdin: {
      end: () => { /* never calls back — simulates a stuck write */ },
      on: (event, handler) => { if (event === "error") handler(new Error("EPIPE")); },
    },
    unref: () => {},
  };
  const fakeSpawn = () => child;
  spawnDetachedCapture({ cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" }, fakeSpawn, () => { onDoneCalled = true; });
  assert.equal(onDoneCalled, true);
});

test("calls onDone when the child itself fails to spawn (e.g. ENOENT), not just on a stdin-level error", () => {
  let onDoneCalled = false;
  const child = {
    on: (event, handler) => { if (event === "error") handler(new Error("ENOENT")); },
    stdin: {
      end: () => { /* never calls back — spawn failed before stdin could ever flush */ },
      on: () => {},
    },
    unref: () => {},
  };
  const fakeSpawn = () => child;
  spawnDetachedCapture({ cwd: "/repo", transcript_path: "/t.jsonl", session_id: "s1" }, fakeSpawn, () => { onDoneCalled = true; });
  assert.equal(onDoneCalled, true);
});
