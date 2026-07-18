import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { loadConfig, saveConfig, configDir } from "./config.js";

function claudeSettingsPath() {
  return process.env.CODEBRIEF_CLAUDE_SETTINGS_PATH || join(homedir(), ".claude", "settings.json");
}

function readSettings() {
  const path = claudeSettingsPath();
  if (!existsSync(path)) return {};
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("~/.claude/settings.json is not a JSON object");
  }
  return raw;
}

// Atomic write (temp file + rename) so a process kill/crash mid-write can never leave the
// user's shared, load-bearing ~/.claude/settings.json truncated or corrupted. The temp file is
// explicitly given the ORIGINAL file's mode (falling back to the process umask only when the
// file doesn't exist yet) — writeFileSync's default umask-derived mode would otherwise silently
// loosen a more restrictive existing mode (e.g. 0600) on every rename.
function writeSettings(settings) {
  const path = claudeSettingsPath();
  const tmp = `${path}.${process.pid}.tmp`;
  let mode;
  try { mode = statSync(path).mode & 0o777; } catch { /* no existing file — use the default mode */ }
  writeFileSync(tmp, JSON.stringify(settings, null, 2), mode !== undefined ? { mode } : undefined);
  renameSync(tmp, path);
}

export function trampolinePath() {
  return join(configDir(), "statusline.js");
}

export function trampolineCommand() {
  return `node "${trampolinePath()}"`;
}

/**
 * Best-effort, idempotent: wires the Codebrief status-line trampoline into the user's
 * ~/.claude/settings.json, chaining onto whatever statusLine.command is already configured
 * there (captured exactly once, on first wrap, so re-running this never wraps our own wrapper).
 * Returns "wrapped" the first time it actually changes settings.json, "already-wrapped" on every
 * later call — the copied trampoline file is refreshed either way, so plugin updates land.
 */
export function ensureStatusLineWrapped(pluginScriptsDir) {
  const cfg = loadConfig();
  cfg.pluginRoot = pluginScriptsDir;
  saveConfig(cfg);

  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  copyFileSync(join(pluginScriptsDir, "statusline-runtime.js"), trampolinePath());

  const settings = readSettings();
  const wanted = trampolineCommand();
  if (settings.statusLine?.command === wanted) return "already-wrapped";

  if (cfg.statusLineInnerCommand === undefined) {
    cfg.statusLineInnerCommand = settings.statusLine?.command ?? null;
    saveConfig(cfg);
  }
  settings.statusLine = { type: "command", command: wanted };
  writeSettings(settings);
  return "wrapped";
}
