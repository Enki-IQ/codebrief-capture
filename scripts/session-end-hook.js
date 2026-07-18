import { distill as realDistill } from "./lib/distill.js";
import { isClaudeAvailable as realIsClaudeAvailable } from "./lib/preflight.js";
import { runCaptureCore } from "./lib/capture.js";

/** Claude adapter around the shared authenticated ingest orchestration. */
export function runCapture({ input, deps = {} }) {
  const { isClaudeAvailable, ...coreDeps } = deps;
  return runCaptureCore({
    input,
    distiller: {
      distill: realDistill,
      isAvailable: realIsClaudeAvailable,
      optionsFromConfig: (cfg) => ({ model: cfg.distillModel }),
      unavailableStatus: "skipped:no-claude",
      unavailableMessage: "[codebrief] `claude` CLI not found on PATH - cannot distill intent. Install Claude Code or add it to PATH.",
    },
    deps: {
      ...coreDeps,
      ...(isClaudeAvailable ? { isDistillerAvailable: isClaudeAvailable } : {}),
    },
  });
}

// Entrypoint: read the hook JSON from stdin, run, exit 0 regardless (never block session end).
if (import.meta.url === `file://${process.argv[1]}`) {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", async () => {
    let input = {};
    try { input = JSON.parse(buf); } catch { /* no input */ }
    const out = await runCapture({ input });
    if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] ${out.status}`);
    process.exit(0);
  });
}
