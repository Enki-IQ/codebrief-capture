import { spawnSync } from "node:child_process";
import { captureModelCommand } from "./model-complete.js";

function commandAvailable(command, spawn) {
  try {
    const result = spawn(command, ["--version"], { stdio: "ignore", timeout: 5_000 });
    return result?.status === 0;
  } catch {
    return false;
  }
}

/** True if the configured capture model CLI is invocable. Distillation depends on it, not on the host. */
export function isDistillerAvailable(spawn = spawnSync) {
  return commandAvailable(captureModelCommand(), spawn);
}

/** True if the `claude` CLI is invocable. Host detection only; distillation does not use it. */
export function isClaudeAvailable(spawn = spawnSync) {
  return commandAvailable("claude", spawn);
}

/** True if the `codex` CLI is invocable. Host detection only; distillation does not use it. */
export function isCodexAvailable(spawn = spawnSync) {
  return commandAvailable("codex", spawn);
}
