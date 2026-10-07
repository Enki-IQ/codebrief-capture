import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { beginCapture, isLatestCapture, markCaptured, wasCaptured } from "./lib/capture-state.js";
import { readHookInput, shouldRememberCapture } from "./lib/hook-input.js";
import { runCodexCapture } from "./codex-capture.js";
import { runActiveProjectTurn } from "./codex-active-project-return.js";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function handleCodexStop(input, deps = {}) {
  const d = {
    loadConfig,
    beginCapture,
    isLatestCapture,
    wasCaptured,
    markCaptured,
    runCodexCapture,
    runActiveProjectTurn,
    sleep,
    ...deps,
  };
  try {
    let activeProject;
    try {
      activeProject = Promise.resolve(d.runActiveProjectTurn(input, { reason: "stop" }))
        .catch(() => ({ status: "error" }));
    } catch {
      activeProject = Promise.resolve({ status: "error" });
    }
    const ticket = d.beginCapture(input);
    if (!ticket) {
      await activeProject;
      return { status: "skipped:no-transcript" };
    }
    const configured = Number(d.loadConfig().codexDebounceMs);
    const debounceMs = Number.isFinite(configured) ? Math.max(0, Math.min(configured, 120_000)) : 45_000;
    await d.sleep(debounceMs);
    if (!d.isLatestCapture(ticket)) {
      await activeProject;
      return { status: "skipped:superseded" };
    }
    if (d.wasCaptured(ticket, "complete")) {
      await activeProject;
      return { status: "skipped:duplicate" };
    }
    const contentAlreadyCaptured = d.wasCaptured(ticket, "content");
    const result = await d.runCodexCapture({ input: {
      ...input,
      capture_id: ticket.sourceRef,
      capture_state: "complete",
      capture_metadata_only: contentAlreadyCaptured,
    } });
    await activeProject;
    if (shouldRememberCapture(result.status)) {
      if (!contentAlreadyCaptured) d.markCaptured(ticket, "content");
      d.markCaptured(ticket, "complete");
    }
    return result;
  } catch {
    return { status: "error" };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.env.CODEBRIEF_DISTILL_CHILD === "1") process.exit(0);
  const input = await readHookInput();
  const result = await handleCodexStop(input);
  if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] ${result.status}`);
}
