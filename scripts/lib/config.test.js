import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { enableRepo, disableRepo, listEnabledRepos, isRepoEnabled, configDir, loadConfig } from "./config.js";

beforeEach(() => {
  process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-cfg-"));
  delete process.env.CODEBRIEF_API_BASE_URL;
  delete process.env.CODEBRIEF_ALLOW_LOCAL_API;
  delete process.env.CODEBRIEF_CODEX_DEBOUNCE_MS;
});

test("configDir honors CODEBRIEF_CONFIG_DIR", () => {
  assert.equal(configDir(), process.env.CODEBRIEF_CONFIG_DIR);
});

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

test("an untrusted configured API origin falls back to production without losing repo settings", () => {
  writeFileSync(join(configDir(), "config.json"), JSON.stringify({
    apiBaseUrl: "https://app.x",
    enabledRepos: ["a/b"],
  }));
  const config = loadConfig();
  assert.equal(config.apiBaseUrl, "https://app.codebrief.ai");
  assert.deepEqual(config.enabledRepos, ["a/b"]);
});

test("an untrusted API origin from the environment falls back to production", () => {
  process.env.CODEBRIEF_API_BASE_URL = "https://app.x";
  assert.equal(loadConfig().apiBaseUrl, "https://app.codebrief.ai");
});

test("an explicitly enabled loopback API origin remains available for local development", () => {
  process.env.CODEBRIEF_API_BASE_URL = "http://127.0.0.1:3000";
  process.env.CODEBRIEF_ALLOW_LOCAL_API = "1";
  assert.equal(loadConfig().apiBaseUrl, "http://127.0.0.1:3000");
});

test("configuration loads do not share the default enabled repository array", () => {
  enableRepo("a/b");
  process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-cfg-other-"));
  assert.deepEqual(loadConfig().enabledRepos, []);
});

test("the debounce environment default preserves zero and rejects invalid values", () => {
  process.env.CODEBRIEF_CODEX_DEBOUNCE_MS = "0";
  assert.equal(loadConfig().codexDebounceMs, 0);
  process.env.CODEBRIEF_CODEX_DEBOUNCE_MS = "-1";
  assert.equal(loadConfig().codexDebounceMs, 45_000);
  process.env.CODEBRIEF_CODEX_DEBOUNCE_MS = "Infinity";
  assert.equal(loadConfig().codexDebounceMs, 45_000);
  process.env.CODEBRIEF_CODEX_DEBOUNCE_MS = "";
  assert.equal(loadConfig().codexDebounceMs, 45_000);
});
