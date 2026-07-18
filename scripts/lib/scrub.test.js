import { test } from "node:test";
import assert from "node:assert";
import { preScrub, preScrubMetadata, preScrubRecords, scrubTranscriptText } from "./scrub.js";
test("drops obvious secrets/code/over-length, keeps clean prose", () => {
  assert.equal(preScrub("Chose magic-link login.").ok, true);
  assert.equal(preScrub("```ts\nx\n```").ok, false);
  const awsLike = `AKIA${"A".repeat(16)}`; // synthetic — avoids a real-looking literal tripping secret scanners
  assert.equal(preScrub(`key ${awsLike}`).ok, false);
  assert.equal(preScrub(`token ck_live_${"a".repeat(24)}`).ok, false); // Clerk key format
  assert.equal(preScrub("x".repeat(401)).ok, false);
});

test("allowlists the complete outbound record and drops unsafe metadata", () => {
  const records = preScrubRecords([{
    kind: "decision",
    summary: "Keep the public API stable",
    sourceType: "session",
    sourceRef: "session-1",
    anchor: { path: "src/api.ts", symbol: "handler", startLine: 4, extra: "raw code" },
    unexpected: "raw source contents",
  }, {
    kind: "unknown",
    summary: "invalid kind",
  }, {
    kind: "plan",
    summary: "Ship it",
    sourceRef: "line one\nline two",
    anchor: { symbol: "```secret```" },
  }]);
  assert.deepEqual(records, [{
    kind: "decision",
    summary: "Keep the public API stable",
    sourceType: "session",
    sourceRef: "session-1",
    anchor: { path: "src/api.ts", symbol: "handler", startLine: 4 },
  }, {
    kind: "plan",
    summary: "Ship it",
  }]);
});

test("rejects unsafe fallback metadata", () => {
  assert.equal(preScrubMetadata("session-123", 200), "session-123");
  assert.equal(preScrubMetadata("session\nleak", 200), undefined);
  assert.equal(preScrubMetadata(`sk-${"a".repeat(24)}`, 200), undefined);
  assert.equal(preScrubMetadata(`sk-proj-${"a".repeat(24)}`, 200), undefined);
});

test("redacts secrets and fenced code from provider-bound transcript text", () => {
  const secret = `sk-proj-${"a".repeat(24)}`;
  const clean = scrubTranscriptText(`Keep the API stable. ${secret}\n\`\`\`ts\nconst leaked = true;\n\`\`\``);
  assert.match(clean, /Keep the API stable/);
  assert.doesNotMatch(clean, /sk-proj|leaked/);
  assert.match(clean, /\[redacted secret\]|\[redacted code\]/);
});
