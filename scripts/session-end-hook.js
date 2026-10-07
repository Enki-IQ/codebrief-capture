import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distill as realDistill } from "./lib/distill.js";
import { isDistillerAvailable as realIsDistillerAvailable } from "./lib/preflight.js";
import { runCaptureCore } from "./lib/capture.js";
import { beginCapture, isLatestCapture, markCaptured, wasCaptured } from "./lib/capture-state.js";
import { readHookInput, shouldRememberCapture } from "./lib/hook-input.js";
import {
  classifyWithClaude,
  handleActiveProjectTurn,
} from "./active-project-return.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function spawnDistillChild(command, args, options, spawn = spawnSync) {
  return spawn(command, args, {
    ...options,
    env: {
      ...process.env,
      ...options?.env,
      CODEBRIEF_DISTILL_CHILD: "1",
    },
  });
}

/** Host adapter around the shared authenticated ingest orchestration. The model call is not host-specific. */
export function runCapture({ input, deps = {} }) {
  const { isDistillerAvailable, ...coreDeps } = deps;
  return runCaptureCore({
    input,
    captureHost: "claude",
    distiller: {
      distill: realDistill,
      isAvailable: realIsDistillerAvailable,
      optionsFromConfig: (cfg) => ({
        model: cfg.distillModel,
        spawn: spawnDistillChild,
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

export async function handleSessionEnd({
  input,
  reason = "session_end",
  deps = {},
}) {
  const d = {
    handleActiveProjectTurn,
    runCapture,
    beginCapture,
    isLatestCapture,
    wasCaptured,
    markCaptured,
    ...deps,
  };
  const activePromise = (async () => {
    try {
      return await d.handleActiveProjectTurn({
        input,
        reason,
        classify: classifyWithClaude,
      });
    } catch {
      return { status: "error" };
    }
  })();
  const capturePromise = (async () => {
    try {
      const ticket = d.beginCapture(input);
      if (!ticket) return { status: "skipped:no-transcript" };

      const isPublish = reason === "publish";
      const phase = isPublish ? "content" : "complete";
      if (!isPublish && !d.isLatestCapture(ticket)) return { status: "skipped:superseded" };
      if (d.wasCaptured(ticket, phase)) return { status: "skipped:duplicate" };

      const contentAlreadyCaptured = !isPublish && d.wasCaptured(ticket, "content");
      const result = await d.runCapture({ input: {
        ...input,
        // The locally-issued opaque id is authoritative. Provider ids remain inputs to the
        // hashed rolling-state key but are never exposed as the canonical capture provenance.
        capture_id: ticket.sourceRef,
        capture_state: isPublish ? "in_progress" : "complete",
        capture_metadata_only: contentAlreadyCaptured,
      } });
      if (shouldRememberCapture(result.status)) {
        if (!isPublish && !contentAlreadyCaptured) d.markCaptured(ticket, "content");
        d.markCaptured(ticket, phase);
      }
      return result;
    } catch {
      return { status: "error" };
    }
  })();
  const [activeProject, capture] = await Promise.all([activePromise, capturePromise]);
  return {
    activeProject: activeProject?.status ?? "error",
    capture: capture?.status ?? "error",
  };
}

export function spawnDetachedSessionEnd(
  input,
  reason = "session_end",
  spawnFn = spawn,
  onDone = () => {},
) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  const child = spawnFn(
    process.execPath,
    [
      "--no-warnings=ExperimentalWarning",
      join(__dirname, "session-end-hook.js"),
      "--background",
      reason === "publish" ? "--publish" : "--session-end",
    ],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  child.on("error", finish);
  child.stdin.on("error", finish);
  child.stdin.end(JSON.stringify({
    cwd: input?.cwd,
    transcript_path: input?.transcript_path,
    session_id: input?.session_id,
  }), finish);
  child.unref();
}

// Entrypoint: read the hook JSON from stdin, run, exit 0 regardless (never block session end).
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.env.CODEBRIEF_DISTILL_CHILD === "1") process.exit(0);
  const background = process.argv.includes("--background");
  const forceExit = background ? null : setTimeout(() => process.exit(0), 3_000);
  forceExit?.unref();
  const done = () => {
    if (forceExit) clearTimeout(forceExit);
    process.exit(0);
  };
  const input = await readHookInput();
  if (!background) {
    try {
      spawnDetachedSessionEnd(input, "session_end", spawn, done);
    } catch {
      done();
    }
  } else {
    const out = await handleSessionEnd({
      input,
      reason: process.argv.includes("--publish") ? "publish" : "session_end",
    });
    if (process.env.CODEBRIEF_DEBUG) {
      console.error(`[codebrief] active-project=${out.activeProject} capture=${out.capture}`);
    }
    done();
  }
}
