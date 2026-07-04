import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { enableRepo, disableRepo, listEnabledRepos, isRepoEnabled } from "./config.js";

beforeEach(() => { process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-cfg-")); });

test("enable adds (idempotent), list reflects, disable removes", () => {
  assert.deepEqual(listEnabledRepos(), []);
  enableRepo("a/b");
  enableRepo("a/b"); // idempotent — no duplicate
  enableRepo("c/d");
  assert.deepEqual([...listEnabledRepos()].sort(), ["a/b", "c/d"]);
  assert.equal(isRepoEnabled("a/b"), true);
  disableRepo("a/b");
  assert.equal(isRepoEnabled("a/b"), false);
  assert.deepEqual(listEnabledRepos(), ["c/d"]);
  disableRepo("not/there"); // no-op, must not throw
  assert.deepEqual(listEnabledRepos(), ["c/d"]);
});
