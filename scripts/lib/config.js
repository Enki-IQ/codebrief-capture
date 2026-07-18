import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { CODEBRIEF_API_BASE_URL, normalizeCodebriefApiBaseUrl } from "./api-url.js";

// Config dir is overridable via CODEBRIEF_CONFIG_DIR (used by tests) and read lazily per call so
// an env change between calls is honored; defaults to ~/.codebrief.
export function configDir() { return process.env.CODEBRIEF_CONFIG_DIR || join(homedir(), ".codebrief"); }
function configPath() { return join(configDir(), "config.json"); }

const DEFAULTS = {
  apiBaseUrl: CODEBRIEF_API_BASE_URL,
  // Model the local `claude -p` distill runs under (the USER's own Anthropic spend, every session;
  // Codebrief is never billed). Defaults to `sonnet`; override via config ("distillModel") or
  // CODEBRIEF_DISTILL_MODEL (e.g. "haiku").
  distillModel: process.env.CODEBRIEF_DISTILL_MODEL || "sonnet",
  // Codex defaults to the user's configured model. These optional settings affect only the
  // ephemeral Codex distillation child, never the primary coding session.
  codexDistillModel: process.env.CODEBRIEF_CODEX_DISTILL_MODEL || "",
  codexDistillReasoningEffort: process.env.CODEBRIEF_CODEX_REASONING_EFFORT || "low",
  codexDebounceMs: 45_000,
};

function safeApiBaseUrl(value, fallback = CODEBRIEF_API_BASE_URL) {
  try { return normalizeCodebriefApiBaseUrl(value); } catch { return fallback; }
}

function defaults() {
  const debounceRaw = process.env.CODEBRIEF_CODEX_DEBOUNCE_MS;
  const debounce = Number(debounceRaw);
  return {
    ...DEFAULTS,
    enabledRepos: [],
    apiBaseUrl: safeApiBaseUrl(process.env.CODEBRIEF_API_BASE_URL, CODEBRIEF_API_BASE_URL),
    codexDebounceMs: typeof debounceRaw === "string" && debounceRaw.trim() !== ""
      && Number.isFinite(debounce) && debounce >= 0 ? debounce : DEFAULTS.codexDebounceMs,
  };
}

export function loadConfig() {
  try {
    const raw = JSON.parse(readFileSync(configPath(), "utf8"));
    const base = defaults();
    const cfg = { ...base, ...(raw && typeof raw === "object" ? raw : {}) };
    // Defensive: a hand-edited/corrupt config must not crash command paths that assume these shapes.
    if (!Array.isArray(cfg.enabledRepos)) cfg.enabledRepos = [];
    cfg.apiBaseUrl = safeApiBaseUrl(cfg.apiBaseUrl, base.apiBaseUrl);
    if (typeof cfg.codexDistillModel !== "string") cfg.codexDistillModel = DEFAULTS.codexDistillModel;
    if (typeof cfg.codexDistillReasoningEffort !== "string" || !cfg.codexDistillReasoningEffort) cfg.codexDistillReasoningEffort = DEFAULTS.codexDistillReasoningEffort;
    if (!Number.isFinite(cfg.codexDebounceMs) || cfg.codexDebounceMs < 0) cfg.codexDebounceMs = base.codexDebounceMs;
    return cfg;
  } catch { return defaults(); }
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
