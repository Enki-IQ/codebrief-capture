import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

// Config dir is overridable via CODEBRIEF_CONFIG_DIR (used by tests) and read lazily per call so
// an env change between calls is honored; defaults to ~/.codebrief.
export function configDir() { return process.env.CODEBRIEF_CONFIG_DIR || join(homedir(), ".codebrief"); }
function configPath() { return join(configDir(), "config.json"); }

const DEFAULTS = {
  apiBaseUrl: process.env.CODEBRIEF_API_BASE_URL || "https://app.codebrief.ai",
  enabledRepos: [],
  // Model the local `claude -p` distill runs under (the USER's own Anthropic spend, every session;
  // Codebrief is never billed). Defaults to `sonnet`; override via config ("distillModel") or
  // CODEBRIEF_DISTILL_MODEL (e.g. "haiku").
  distillModel: process.env.CODEBRIEF_DISTILL_MODEL || "sonnet",
};

export function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    const cfg = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
    // Defensive: a hand-edited/corrupt config must not crash command paths that assume these shapes.
    if (!Array.isArray(cfg.enabledRepos)) cfg.enabledRepos = [];
    if (typeof cfg.apiBaseUrl !== "string" || !cfg.apiBaseUrl) cfg.apiBaseUrl = DEFAULTS.apiBaseUrl;
    return cfg;
  } catch { return { ...DEFAULTS }; }
}
export function saveConfig(cfg) {
  const dir = configDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}
export function isRepoEnabled(fullName) { return loadConfig().enabledRepos.includes(fullName); }
export function listEnabledRepos() { return loadConfig().enabledRepos; }
export function enableRepo(fullName) {
  const cfg = loadConfig();
  if (!cfg.enabledRepos.includes(fullName)) { cfg.enabledRepos.push(fullName); saveConfig(cfg); }
}
export function disableRepo(fullName) {
  const cfg = loadConfig();
  const next = cfg.enabledRepos.filter((r) => r !== fullName);
  if (next.length !== cfg.enabledRepos.length) { cfg.enabledRepos = next; saveConfig(cfg); }
}
