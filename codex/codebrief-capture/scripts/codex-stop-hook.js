import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./lib/config.js";
import { beginCapture, isLatestCapture, markCaptured, wasCaptured } from "./lib/capture-state.js";
import { readHookInput, shouldRememberCapture } from "./lib/hook-input.js";
import { runCodexCapture } from "./codex-capture.js";

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

export async function handleCodexStop(input, deps = {}) {
  const d = { loadConfig, beginCapture, isLatestCapture, wasCaptured, markCaptured, runCodexCapture, sleep, ...deps };
  try {
    const ticket = d.beginCapture(input);
    if (!ticket) return { status: "skipped:no-transcript" };
    const configured = Number(d.loadConfig().codexDebounceMs);
    const debounceMs = Number.isFinite(configured) ? Math.max(0, Math.min(configured, 120_000)) : 45_000;
    await d.sleep(debounceMs);
    if (!d.isLatestCapture(ticket)) return { status: "skipped:superseded" };
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
  const result = await handleCodexStop(input);
  if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] ${result.status}`);
}
