import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, copyFileSync, symlinkSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStatusLine } from "./statusline-runtime.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function baseDeps(overrides = {}) {
  return {
    loadConfig: () => ({ pluginRoot: "/plugin", statusLineInnerCommand: "node /old/line.js" }),
    existsSync: () => true,
    spawn: () => ({ status: 0, stdout: "base-segment" }),
    loadPluginLib: async () => ({
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }),
      isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "t" }),
    }),
    readSettings: () => ({}),
    writeSettings: () => {},
    ...overrides,
  };
}

test("shows capturing when logged in and repo enabled", async () => {
  const out = await renderStatusLine({ input: { cwd: "/repo" }, deps: baseDeps() });
  assert.equal(out, "base-segment · Codebrief: capturing");
});

test("shows off when logged in but repo not enabled", async () => {
  const out = await renderStatusLine({
    input: { cwd: "/repo" },
    deps: baseDeps({ loadPluginLib: async () => ({ resolveRepo: () => ({ fullName: "a/b" }), isRepoEnabled: () => false, loadCreds: () => ({ apiKey: "t" }) }) }),
  });
  assert.equal(out, "base-segment · Codebrief: off");
});

test("shows off when cwd isn't a resolvable repo", async () => {
  const out = await renderStatusLine({
    input: { cwd: "/not-a-repo" },
    deps: baseDeps({ loadPluginLib: async () => ({ resolveRepo: () => null, isRepoEnabled: () => false, loadCreds: () => ({ apiKey: "t" }) }) }),
  });
  assert.equal(out, "base-segment · Codebrief: off");
});

test("hides the Codebrief segment entirely when not logged in", async () => {
  const out = await renderStatusLine({
    input: { cwd: "/repo" },
    deps: baseDeps({ loadPluginLib: async () => ({ resolveRepo: () => ({ fullName: "a/b" }), isRepoEnabled: () => true, loadCreds: () => null }) }),
  });
  assert.equal(out, "base-segment");
});

test("drops the base segment when the inner command exits non-zero", async () => {
  const out = await renderStatusLine({ input: { cwd: "/repo" }, deps: baseDeps({ spawn: () => ({ status: 1, stdout: "" }) }) });
  assert.equal(out, "Codebrief: capturing");
});

test("drops the base segment when the inner command times out", async () => {
  const out = await renderStatusLine({ input: { cwd: "/repo" }, deps: baseDeps({ spawn: () => ({ status: null, error: new Error("ETIMEDOUT") }) }) });
  assert.equal(out, "Codebrief: capturing");
});

test("shows nothing at all when there's no inner command and no one logged in", async () => {
  const out = await renderStatusLine({
    input: { cwd: "/repo" },
    deps: baseDeps({
      loadConfig: () => ({ pluginRoot: "/plugin", statusLineInnerCommand: null }),
      spawn: () => { throw new Error("should not be called when there's no inner command"); },
      loadPluginLib: async () => ({ resolveRepo: () => null, isRepoEnabled: () => false, loadCreds: () => null }),
    }),
  });
  assert.equal(out, "");
});

test("self-heals when pluginRoot no longer exists: restores the saved inner command into settings and prints it once more", async () => {
  let written = null;
  const out = await renderStatusLine({
    input: { cwd: "/repo" },
    deps: baseDeps({
      existsSync: () => false,
      readSettings: () => ({ statusLine: { type: "command", command: "node /path/to/statusline.js" }, model: "sonnet" }),
      writeSettings: (s) => { written = s; },
      spawn: () => ({ status: 0, stdout: "restored-base" }),
    }),
  });
  assert.equal(out, "restored-base");
  assert.equal(written.statusLine.command, "node /old/line.js");
  assert.equal(written.model, "sonnet");
});

test("self-heals by removing the statusLine key entirely when there was nothing to restore", async () => {
  let written = null;
  const out = await renderStatusLine({
    input: { cwd: "/repo" },
    deps: baseDeps({
      loadConfig: () => ({ pluginRoot: "/plugin", statusLineInnerCommand: null }),
      existsSync: () => false,
      readSettings: () => ({ statusLine: { type: "command", command: "node /path/to/statusline.js" }, model: "sonnet" }),
      writeSettings: (s) => { written = s; },
    }),
  });
  assert.equal(out, "");
  assert.ok(!("statusLine" in written));
  assert.equal(written.model, "sonnet");
});

test("self-heal never clobbers a corrupt real settings.json on disk", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-settings-"));
  const settingsPath = join(dir, "settings.json");
  const corrupt = "{ not valid json";
  writeFileSync(settingsPath, corrupt);
  process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH = settingsPath;
  try {
    const out = await renderStatusLine({
      input: { cwd: "/repo" },
      deps: {
        loadConfig: () => ({ pluginRoot: "/plugin", statusLineInnerCommand: "node /old/line.js" }),
        existsSync: () => false,
        spawn: () => ({ status: 0, stdout: "restored-base" }),
        loadPluginLib: async () => ({ resolveRepo: () => null, isRepoEnabled: () => false, loadCreds: () => null }),
      },
    });
    assert.equal(out, "restored-base"); // render still works — degrades gracefully
    assert.equal(readFileSync(settingsPath, "utf8"), corrupt); // file on disk is untouched, not clobbered
  } finally {
    delete process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH;
  }
});

test("self-heal preserves a restrictive existing settings.json mode across the atomic rename", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-settings-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ statusLine: { type: "command", command: "node /old/other-line.js" }, model: "sonnet" }));
  chmodSync(settingsPath, 0o600);
  process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH = settingsPath;
  try {
    await renderStatusLine({
      input: { cwd: "/repo" },
      deps: {
        loadConfig: () => ({ pluginRoot: "/plugin", statusLineInnerCommand: "node /old/line.js" }),
        existsSync: () => false,
        spawn: () => ({ status: 0, stdout: "restored-base" }),
        loadPluginLib: async () => ({ resolveRepo: () => null, isRepoEnabled: () => false, loadCreds: () => null }),
      },
    });
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  } finally {
    delete process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH;
  }
});

test("still fires its stdin entrypoint when invoked through a symlinked path (regression: import.meta.url resolves symlinks, argv[1] doesn't)", () => {
  const realDir = mkdtempSync(join(tmpdir(), "cb-real-"));
  copyFileSync(join(HERE, "statusline-runtime.js"), join(realDir, "statusline-runtime.js"));

  const linkParent = mkdtempSync(join(tmpdir(), "cb-linkparent-"));
  const linkDir = join(linkParent, "link");
  symlinkSync(realDir, linkDir, "dir");

  const cfgDir = mkdtempSync(join(tmpdir(), "cb-cfg-"));
  writeFileSync(join(cfgDir, "config.json"), JSON.stringify({ pluginRoot: "/does/not/exist", statusLineInnerCommand: "echo distinctive-marker-xyz" }));
  const settingsDir = mkdtempSync(join(tmpdir(), "cb-settings-"));

  const res = spawnSync(process.execPath, [join(linkDir, "statusline-runtime.js")], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, CODEBRIEF_CONFIG_DIR: cfgDir, CODEBRIEF_CLAUDE_SETTINGS_PATH: join(settingsDir, "settings.json") },
    timeout: 5000,
  });

  // pluginRoot doesn't exist → goes through selfHeal → runInner(statusLineInnerCommand) → the
  // marker. An empty stdout here means the entrypoint block never ran at all (the actual bug).
  assert.equal(res.stdout, "distinctive-marker-xyz");
});
