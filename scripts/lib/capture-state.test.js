import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beginCapture, captureStateDir, isLatestCapture, markCaptured, pruneCaptureState, wasCaptured } from "./capture-state.js";

beforeEach(() => { process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-state-")); });

const input = { session_id: "session-1", transcript_path: "/rollout.jsonl" };
const stat = () => ({ size: 100, mtimeMs: 200 });

test("new generations supersede older Claude capture tickets", () => {
  const first = beginCapture(input, { stat, generation: () => "first" });
  const second = beginCapture(input, { stat, generation: () => "second" });
  assert.equal(isLatestCapture(first), false);
  assert.equal(isLatestCapture(second), true);
});

test("a completed Claude fingerprint deduplicates later generations", () => {
  const first = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(first);
  const repeat = beginCapture(input, { stat, generation: () => "repeat" });
  assert.equal(wasCaptured(repeat), true);
  const changed = beginCapture(input, { stat: () => ({ size: 101, mtimeMs: 201 }), generation: () => "changed" });
  assert.equal(wasCaptured(changed), false);
});

test("Claude content and completion markers are independent for one fingerprint", () => {
  const ticket = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(ticket, "content");
  assert.equal(wasCaptured(ticket, "content"), true);
  assert.equal(wasCaptured(ticket, "complete"), false);
  markCaptured(ticket, "complete");
  assert.equal(wasCaptured(ticket, "complete"), true);
});

test("rolling Claude captures reuse one opaque source ref without a valid host session id", () => {
  const rollingInput = { session_id: "unsafe\nsession", transcript_path: "/rolling.jsonl" };
  const first = beginCapture(rollingInput, { stat, generation: () => "first" });
  const changed = beginCapture(rollingInput, {
    stat: () => ({ size: 101, mtimeMs: 201 }),
    generation: () => "changed",
  });
  assert.match(first.sourceRef, /^capture-[0-9a-f-]{36}$/);
  assert.equal(changed.sourceRef, first.sourceRef);
  assert.equal(first.sourceRef.includes("unsafe"), false);
});

test("marking an older Claude fingerprint cannot overwrite the active generation", () => {
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

test("Claude capture state directory and files use restrictive permissions", () => {
  const ticket = beginCapture(input, { stat, generation: () => "first" });
  markCaptured(ticket);
  assert.equal(statSync(captureStateDir()).mode & 0o777, 0o700);
  assert.equal(statSync(ticket.path).mode & 0o777, 0o600);
  const captured = readdirSync(captureStateDir()).find((name) => name.endsWith(".captured"));
  assert.equal(statSync(join(captureStateDir(), captured)).mode & 0o777, 0o600);
});

test("Claude capture-state pruning removes aged state and caps only captured markers", () => {
  const dir = captureStateDir();
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const markers = [
    { name: "old.content.captured", mtimeMs: now - (31 * 24 * 60 * 60 * 1_000) },
    { name: "recent.content.captured", mtimeMs: now - 1_000 },
    ...Array.from({ length: 256 }, (_, index) => ({
      name: `overflow-${String(index).padStart(3, "0")}.captured`,
      mtimeMs: now - 2_000 - index,
    })),
    { name: "old-active.json", mtimeMs: now - (31 * 24 * 60 * 60 * 1_000) },
    ...Array.from({ length: 300 }, (_, index) => ({
      name: `active-${String(index).padStart(3, "0")}.json`,
      mtimeMs: now - 1_000 - index,
    })),
  ];
  const mtimeByPath = new Map(markers.map((marker) => [join(dir, marker.name), marker.mtimeMs]));
  for (const marker of markers) writeFileSync(join(dir, marker.name), "{}");

  pruneCaptureState({
    now: () => now,
    readDir: () => markers.map((marker) => ({ name: marker.name, isFile: () => true })),
    stat: (path) => ({ mtimeMs: mtimeByPath.get(path) }),
  });

  const remaining = new Set(readdirSync(dir));
  assert.equal(remaining.has("old.content.captured"), false);
  assert.equal(remaining.has("recent.content.captured"), true);
  assert.equal([...remaining].filter((name) => name.endsWith(".captured")).length, 256);
  assert.equal(remaining.has("old-active.json"), false);
  assert.equal([...remaining].filter((name) => name.endsWith(".json")).length, 300);
});
