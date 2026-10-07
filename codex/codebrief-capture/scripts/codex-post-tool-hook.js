import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { shouldCaptureAfterTool } from "./lib/command-trigger.js";
import { beginCapture, markCaptured, wasCaptured } from "./lib/capture-state.js";
import { readHookInput, shouldRememberCapture } from "./lib/hook-input.js";
import { runCodexCapture } from "./codex-capture.js";
import { runActiveProjectTurn } from "./codex-active-project-return.js";

export async function handleCodexPostTool(input, deps = {}) {
  const d = {
    shouldCaptureAfterTool,
    beginCapture,
    wasCaptured,
    markCaptured,
    runCodexCapture,
    runActiveProjectTurn,
    ...deps,
  };
  try {
    if (!d.shouldCaptureAfterTool(input)) return { status: "skipped:not-trigger" };
    let activeProject;
    try {
      activeProject = Promise.resolve(d.runActiveProjectTurn(input, { reason: "publish" }))
        .catch(() => ({ status: "error" }));
    } catch {
      activeProject = Promise.resolve({ status: "error" });
    }
    const ticket = d.beginCapture(input);
    if (!ticket) {
      await activeProject;
      return { status: "skipped:no-transcript" };
    }
    if (d.wasCaptured(ticket, "content")) {
      await activeProject;
      return { status: "skipped:duplicate" };
    }
    const result = await d.runCodexCapture({ input: {
      ...input,
      capture_id: ticket.sourceRef,
      capture_state: "in_progress",
    } });
    await activeProject;
    if (shouldRememberCapture(result.status)) d.markCaptured(ticket, "content");
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
