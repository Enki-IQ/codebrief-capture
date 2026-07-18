import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldCaptureAfterTool } from "./lib/command-trigger.js";
import { beginCapture, markCaptured, wasCaptured } from "./lib/capture-state.js";
import { readHookInput, shouldRememberCapture } from "./lib/hook-input.js";
import { runCodexCapture } from "./codex-capture.js";

export async function handleCodexPostTool(input, deps = {}) {
  const d = { shouldCaptureAfterTool, beginCapture, wasCaptured, markCaptured, runCodexCapture, ...deps };
  try {
    if (!d.shouldCaptureAfterTool(input)) return { status: "skipped:not-trigger" };
    const ticket = d.beginCapture(input);
    if (!ticket) return { status: "skipped:no-transcript" };
    if (d.wasCaptured(ticket)) return { status: "skipped:duplicate" };
    const result = await d.runCodexCapture({ input });
    if (shouldRememberCapture(result.status)) d.markCaptured(ticket);
    return result;
  } catch {
    return { status: "error" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.env.CODEBRIEF_DISTILL_CHILD === "1") process.exit(0);
  const input = await readHookInput();
  const result = await handleCodexPostTool(input);
  if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] ${result.status}`);
}
