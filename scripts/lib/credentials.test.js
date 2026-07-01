import { test } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { FileStore } from "./credentials.js";

test("FileStore round-trips the Clerk key creds and writes 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-creds-"));
  const store = new FileStore(join(dir, "credentials.json"));
  store.save({ apiKey: "ck_live_abc", apiBaseUrl: "http://x" });
  assert.deepEqual(store.load(), { apiKey: "ck_live_abc", apiBaseUrl: "http://x" });
  assert.equal(statSync(join(dir, "credentials.json")).mode & 0o777, 0o600);
  store.clear();
  assert.equal(store.load(), null);
});

test("FileStore tightens permissions on a pre-existing 0644 file (chmod, not just create-mode)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-creds-"));
  const p = join(dir, "credentials.json");
  writeFileSync(p, "{}", { mode: 0o644 });
  chmodSync(p, 0o644); // force broad perms regardless of umask
  new FileStore(p).save({ apiKey: "k", apiBaseUrl: "u" });
  assert.equal(statSync(p).mode & 0o777, 0o600);
});
