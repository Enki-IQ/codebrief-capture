import { spawnSync } from "node:child_process";

/** True if the `claude` CLI is invocable. Distillation depends on it; surfaced in `status` and the hook. */
export function isClaudeAvailable(spawn = spawnSync) {
  try {
    const r = spawn("claude", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return r?.status === 0;
  } catch {
    return false;
  }
}

/** True if the `codex` CLI is invocable. */
export function isCodexAvailable(spawn = spawnSync) {
  try {
    const result = spawn("codex", ["--version"], { stdio: "ignore", timeout: 5_000 });
    return result?.status === 0;
  } catch {
    return false;
  }
}
