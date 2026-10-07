import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginCapture, captureStateDir, isLatestCapture, markCaptured, wasCaptured } from "./capture-state.js";

beforeEach(() => { process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-state-")); });

const input = { session_id: "session-1", transcript_path: "/rollout.jsonl" };
const stat = () => ({ size: 100, mtimeMs: 200 });

test("new generations supersede older Stop tickets", () => {
  const first = beginCapture(input, { stat, generation: () => "first" });
  const second = beginCapture(input, { stat, generation: () => "second" });
  assert.equal(isLatestCapture(first), false);
  assert.equal(isLatestCapture(second), true);
});

test("a completed fingerprint deduplicates later generations", () => {
  const first = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(first);
  const repeat = beginCapture(input, { stat, generation: () => "repeat" });
  assert.equal(wasCaptured(repeat), true);
  const changed = beginCapture(input, { stat: () => ({ size: 101, mtimeMs: 201 }), generation: () => "changed" });
  assert.equal(wasCaptured(changed), false);
});

test("content and completion markers are independent for one fingerprint", () => {
  const ticket = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(ticket, "content");
  assert.equal(wasCaptured(ticket, "content"), true);
  assert.equal(wasCaptured(ticket, "complete"), false);
  markCaptured(ticket, "complete");
  assert.equal(wasCaptured(ticket, "complete"), true);
});

test("rolling captures reuse one opaque source ref even when no host session id exists", () => {
  const rollingInput = { transcript_path: "/rolling.jsonl" };
  const first = beginCapture(rollingInput, { stat, generation: () => "first" });
  const changed = beginCapture(rollingInput, {
    stat: () => ({ size: 101, mtimeMs: 201 }),
    generation: () => "changed",
  });
  assert.match(first.sourceRef, /^capture-[0-9a-f-]{36}$/);
  assert.equal(changed.sourceRef, first.sourceRef);
});

test("marking an older fingerprint cannot overwrite the active generation", () => {
  const first = beginCapture(input, { stat, generation: () => "first" });
  const second = beginCapture(input, {
    stat: () => ({ size: 101, mtimeMs: 201 }),
    generation: () => "second",
  });
  markCaptured(first);
  assert.equal(isLatestCapture(second), true);
  assert.equal(wasCaptured(first), true);
  assert.equal(wasCaptured(second), false);
});

test("state directory and files use restrictive permissions", () => {
  const ticket = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(ticket);
  assert.equal(statSync(captureStateDir()).mode & 0o777, 0o700);
  assert.equal(statSync(ticket.path).mode & 0o777, 0o600);
  const captured = readdirSync(captureStateDir()).find((name) => name.endsWith(".captured"));
  assert.equal(statSync(join(captureStateDir(), captured)).mode & 0o777, 0o600);
});
