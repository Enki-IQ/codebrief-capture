import { test } from "node:test";
import assert from "node:assert";
import { normalizeSourceRef, preScrub, preScrubMetadata, preScrubRecords, scrubTranscriptText } from "./scrub.js";
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

test("preserves opaque source refs with the same structural contract as ingestion", () => {
  const secretLikeOpaqueId = `sk-${"a".repeat(24)}`;
  assert.equal(normalizeSourceRef(`  ${secretLikeOpaqueId}  `), `  ${secretLikeOpaqueId}  `);
  assert.equal(normalizeSourceRef("session\nleak"), undefined);
  assert.equal(normalizeSourceRef("session\u0085leak"), undefined);
  assert.equal(normalizeSourceRef("session\u2028leak"), undefined);
  assert.equal(normalizeSourceRef("session\u202eleak"), undefined);
  assert.equal(normalizeSourceRef("cafe\u0301"), "cafe\u0301");
  assert.notEqual(normalizeSourceRef("cafe\u0301"), normalizeSourceRef("caf\u00e9"));
  assert.equal(normalizeSourceRef("x".repeat(201)), undefined);
});

test("redacts secrets and fenced code from provider-bound transcript text", () => {
  const secret = `sk-proj-${"a".repeat(24)}`;
  const clean = scrubTranscriptText(`Keep the API stable. ${secret}\n\`\`\`ts\nconst leaked = true;\n\`\`\``);
  assert.match(clean, /Keep the API stable/);
  assert.doesNotMatch(clean, /sk-proj|leaked/);
  assert.match(clean, /\[redacted secret\]|\[redacted code\]/);
});

test("redacts provider-bound repository, package, payment, cloud, chat, and auth credentials", () => {
  const secrets = [
    `ghp_${"a".repeat(36)}`,
    `github_pat_${"b".repeat(40)}`,
    `glpat-${"c".repeat(24)}`,
    `npm_${"c".repeat(36)}`,
    `sk_live_${"d".repeat(24)}`,
    `ASIA${"E".repeat(16)}`,
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-"),
    `Authorization: Bearer ${"f".repeat(32)}`,
    `Authorization: Basic ${Buffer.from("user:password").toString("base64")}`,
  ];
  const clean = scrubTranscriptText(`Keep this summary.\n${secrets.join("\n")}`);

  assert.match(clean, /Keep this summary/);
  for (const secret of secrets) assert.equal(clean.includes(secret), false, secret);
  assert.match(clean, /\[redacted secret\]/);
});
