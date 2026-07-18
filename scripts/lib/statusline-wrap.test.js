import { test, beforeEach } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync } from "node:fs";
import { ensureStatusLineWrapped, trampolineCommand } from "./statusline-wrap.js";

let pluginDir, settingsPath;

beforeEach(() => {
  process.env.CODEBRIEF_CONFIG_DIR = mkdtempSync(join(tmpdir(), "cb-cfg-"));
  settingsPath = join(mkdtempSync(join(tmpdir(), "cb-settings-")), "settings.json");
  process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH = settingsPath;
  pluginDir = mkdtempSync(join(tmpdir(), "cb-plugin-"));
  writeFileSync(join(pluginDir, "statusline-runtime.js"), "// fake trampoline v1\n");
});

function readConfig() {
  return JSON.parse(readFileSync(join(process.env.CODEBRIEF_CONFIG_DIR, "config.json"), "utf8"));
}

test("first wrap captures the existing statusLine command and copies the trampoline", () => {
  writeFileSync(settingsPath, JSON.stringify({
    statusLine: { type: "command", command: "node /old/line.js" },
    model: "sonnet",
    hooks: { SessionEnd: [{ hooks: [{ type: "command", command: "node /old/session-end.js" }] }] },
  }));
  const result = ensureStatusLineWrapped(pluginDir);
  assert.equal(result, "wrapped");
  const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  assert.equal(settings.statusLine.command, trampolineCommand());
  assert.equal(settings.model, "sonnet"); // other keys preserved
  assert.deepEqual(settings.hooks, { SessionEnd: [{ hooks: [{ type: "command", command: "node /old/session-end.js" }] }] }); // nested unrelated config preserved untouched
  const cfg = readConfig();
  assert.equal(cfg.statusLineInnerCommand, "node /old/line.js");
  assert.equal(cfg.pluginRoot, pluginDir);
  assert.equal(readFileSync(join(process.env.CODEBRIEF_CONFIG_DIR, "statusline.js"), "utf8"), "// fake trampoline v1\n");
});

test("preserves a restrictive existing settings.json mode across the atomic rename", () => {
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "node /old/line.js" } }));
  chmodSync(settingsPath, 0o600);
  ensureStatusLineWrapped(pluginDir);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
});

test("corrupt settings.json throws instead of being silently overwritten", () => {
  const corrupt = "{ this is not valid json,,,";
  writeFileSync(settingsPath, corrupt);
  assert.throws(() => ensureStatusLineWrapped(pluginDir));
  assert.equal(readFileSync(settingsPath, "utf8"), corrupt); // untouched, not clobbered with {}
});

test("wraps cleanly when there was no prior statusLine (captures null)", () => {
  writeFileSync(settingsPath, JSON.stringify({ model: "sonnet" }));
  ensureStatusLineWrapped(pluginDir);
  const cfg = readConfig();
  assert.equal(cfg.statusLineInnerCommand, null);
});

test("a second call after already wrapped does not re-capture the inner command, but still refreshes the copied file", () => {
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "node /old/line.js" } }));
  ensureStatusLineWrapped(pluginDir); // e.g. login
  writeFileSync(join(pluginDir, "statusline-runtime.js"), "// fake trampoline v2\n");
  const result = ensureStatusLineWrapped(pluginDir); // e.g. a later enable in another repo
  assert.equal(result, "already-wrapped");
  const cfg = readConfig();
  assert.equal(cfg.statusLineInnerCommand, "node /old/line.js"); // NOT overwritten with our own wrapper command
  assert.equal(readFileSync(join(process.env.CODEBRIEF_CONFIG_DIR, "statusline.js"), "utf8"), "// fake trampoline v2\n");
});
