import { runCaptureCore } from "./lib/capture.js";
import { distillWithCodex } from "./lib/codex-distill.js";
import { isDistillerAvailable as realIsDistillerAvailable } from "./lib/preflight.js";

/** Codex host adapter. Transcript reduction stays host-specific; the model call does not. */
export function runCodexCapture({ input, deps = {} }) {
  const { isDistillerAvailable, ...coreDeps } = deps;
  return runCaptureCore({
    input,
    captureHost: "codex",
    distiller: {
      distill: distillWithCodex,
      isAvailable: realIsDistillerAvailable,
      optionsFromConfig: (cfg) => ({
        model: cfg.distillModel,
      }),
      unavailableStatus: "skipped:no-model",
      unavailableMessage: "[codebrief] model CLI not found on PATH - cannot distill intent. Install the configured capture model CLI (default `gemini`) or set CODEBRIEF_DISTILL_COMMAND.",
    },
    deps: {
      ...coreDeps,
      ...(isDistillerAvailable ? { isDistillerAvailable } : {}),
    },
  });
}
