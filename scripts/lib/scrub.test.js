import { test } from "node:test";
import assert from "node:assert";
import { preScrub } from "./scrub.js";
test("drops obvious secrets/code/over-length, keeps clean prose", () => {
  assert.equal(preScrub("Chose magic-link login.").ok, true);
  assert.equal(preScrub("```ts\nx\n```").ok, false);
  const awsLike = `AKIA${"A".repeat(16)}`; // synthetic — avoids a real-looking literal tripping secret scanners
  assert.equal(preScrub(`key ${awsLike}`).ok, false);
  assert.equal(preScrub(`token ck_live_${"a".repeat(24)}`).ok, false); // Clerk key format
  assert.equal(preScrub("x".repeat(401)).ok, false);
});
