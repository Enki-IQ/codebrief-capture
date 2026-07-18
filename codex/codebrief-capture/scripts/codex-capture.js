import { runCaptureCore } from "./lib/capture.js";
import { distillWithCodex } from "./lib/codex-distill.js";
import { isCodexAvailable as realIsCodexAvailable } from "./lib/preflight.js";

/** Codex adapter around the shared authenticated ingest orchestration. */
export function runCodexCapture({ input, deps = {} }) {
  const { isCodexAvailable, ...coreDeps } = deps;
  return runCaptureCore({
    input,
    distiller: {
      distill: distillWithCodex,
      isAvailable: realIsCodexAvailable,
      optionsFromConfig: (cfg) => ({
        model: cfg.codexDistillModel,
        reasoningEffort: cfg.codexDistillReasoningEffort,
      }),
      unavailableStatus: "skipped:no-codex",
      unavailableMessage: "[codebrief] `codex` CLI not found on PATH - cannot distill intent. Install Codex or add it to PATH.",
    },
    deps: {
      ...coreDeps,
      ...(isCodexAvailable ? { isDistillerAvailable: isCodexAvailable } : {}),
    },
  });
}
