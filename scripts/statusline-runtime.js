import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const INNER_TIMEOUT_MS = 1_500;

function configPath() {
  return join(process.env.CODEBRIEF_CONFIG_DIR || join(homedir(), ".codebrief"), "config.json");
}

function settingsPath() {
  return process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
}

function defaultLoadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    return raw && typeof raw === "object" ? raw : {};
  } catch { return {}; }
}

function defaultReadSettings() {
  const path = settingsPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("~/.claude/settings.json is not a JSON object");
  }
  return raw;
}

// Same atomic-write rationale as the sibling writeSettings() in scripts/lib/statusline-wrap.js:
// a plain writeFileSync on this shared settings file risks leaving it truncated on a mid-write
// crash — worse here, since selfHeal can retry this write on every render. Also preserves the
// original file's mode across the rename, so a restrictive existing mode (e.g. 0600) doesn't
// silently widen to the process umask's default on every self-heal write.
function defaultWriteSettings(settings) {
  const path = settingsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  let mode;
  try { mode = statSync(path).mode & 0o777; } catch { /* no existing file — use the default mode */ }
  writeFileSync(tmp, JSON.stringify(settings, null, 2), mode !== undefined ? { mode } : undefined);
  renameSync(tmp, path);
}

/** Loads the plugin's repo/config/credentials helpers from its currently-installed location. */
async function loadPluginLib(pluginRoot) {
  const [{ resolveRepo }, { isRepoEnabled }, { loadCreds }] = await Promise.all([
    import(join(pluginRoot, "lib", "repo.js")),
    import(join(pluginRoot, "lib", "config.js")),
    import(join(pluginRoot, "lib", "credentials.js")),
  ]);
  return { resolveRepo, isRepoEnabled, loadCreds };
}

// The saved command is a raw shell command line (e.g. "node /path/to/line.js"), not an argv
// array — run it through a shell rather than trying to parse/quote it ourselves.
function runInner(command, input, d) {
  if (!command) return "";
  try {
    const res = d.spawn(command, [], { input: JSON.stringify(input), encoding: "utf8", timeout: INNER_TIMEOUT_MS, shell: true });
    if (!res || res.status !== 0 || res.error) return "";
    return (res.stdout || "").trim();
  } catch { return ""; }
}

function selfHeal(cfg, input, d) {
  try {
    const settings = d.readSettings();
    // Once already healed, every subsequent render would otherwise re-read/re-write this shared
    // file for no reason — wasted I/O, and it widens the window for a lost update to a key some
    // other process (another terminal, the user editing settings) wrote in the meantime.
    const alreadyHealed = cfg.statusLineInnerCommand
      ? settings.statusLine?.command === cfg.statusLineInnerCommand
      : !("statusLine" in settings);
    if (!alreadyHealed) {
      if (cfg.statusLineInnerCommand) settings.statusLine = { type: "command", command: cfg.statusLineInnerCommand };
      else delete settings.statusLine;
      d.writeSettings(settings);
    }
  } catch (e) {
    if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] statusline self-heal skipped: ${e instanceof Error ? e.message : "unknown error"}`);
  }
  return runInner(cfg.statusLineInnerCommand, input, d);
}

/**
 * Renders one status-line frame. Never throws: a missing plugin install, a broken chained
 * command, or a corrupt config file all degrade gracefully rather than blanking the line.
 * This file is copied verbatim to ~/.codebrief/statusline.js by statusline-wrap.js and must
 * keep working standalone there — no imports from the plugin's own lib/ directory at the top
 * level, only via the dynamic loadPluginLib() call below, which is exactly the path that's
 * allowed to fail (see the pluginRoot existence check) once the plugin has been removed.
 */
export async function renderStatusLine({ input, deps = {} }) {
  const d = {
    loadConfig: defaultLoadConfig, readSettings: defaultReadSettings, writeSettings: defaultWriteSettings,
    existsSync, spawn: spawnSync, loadPluginLib,
    ...deps,
  };
  const cfg = d.loadConfig();

  if (!cfg.pluginRoot || !d.existsSync(cfg.pluginRoot)) return selfHeal(cfg, input, d);

  const base = runInner(cfg.statusLineInnerCommand, input, d);
  let segment = null;
  try {
    const { resolveRepo, isRepoEnabled, loadCreds } = await d.loadPluginLib(cfg.pluginRoot);
    if (loadCreds()?.apiKey) {
      const repo = resolveRepo(input.cwd);
      segment = repo && isRepoEnabled(repo.fullName) ? "Codebrief: capturing" : "Codebrief: off";
    }
  } catch { /* plugin lib failed to load — degrade to just the base segment */ }

  return [base, segment].filter(Boolean).join(" · ");
}

// A plain `import.meta.url === file://${process.argv[1]}` string comparison breaks whenever the
// invoked path runs through a symlink Node resolves but argv[1] doesn't (e.g. macOS's /tmp ->
// /private/tmp, or /var/folders -> /private/var/folders for mktemp-created dirs) — Node computes
// import.meta.url from the REAL (symlink-resolved) path of the entry script, while process.argv[1]
// is exactly what was typed on the command line. Comparing realpath-resolved forms on both sides
// makes this robust regardless of where this file ends up being invoked from.
function isMainModule() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); }
  catch { return false; }
}

if (isMainModule()) {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", async () => {
    let input = {};
    try { input = JSON.parse(buf); } catch { /* no input */ }
    const out = await renderStatusLine({ input });
    process.stdout.write(out);
    process.exit(0);
  });
}
