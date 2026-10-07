import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config.js";

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function captureStateDir() {
  return join(configDir(), "capture-state");
}

function readState(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function writeState(path, value) {
  const dir = captureStateDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temp, { force: true });
  }
}

function capturedStatePath(ticket, phase = "content") {
  const safePhase = phase === "complete" ? "complete" : "content";
  return `${ticket.path}.${ticket.fingerprint}.${safePhase}.captured`;
}

const CAPTURE_MARKER_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const CAPTURE_MARKER_LIMIT = 256;

/**
 * Keep rolling-capture deduplication state bounded. Marker names contain only hashes, but a new
 * transcript fingerprint is created after every write, so an active installation can otherwise
 * accumulate them forever. Fail-open: cleanup must never prevent a capture.
 */
export function pruneCaptureState({
  now = Date.now,
  readDir = readdirSync,
  stat = statSync,
  remove = rmSync,
} = {}) {
  try {
    const dir = captureStateDir();
    const stateFiles = readDir(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && (entry.name.endsWith(".captured") || entry.name.endsWith(".json")))
      .map((entry) => {
        const path = join(dir, entry.name);
        return { path, name: entry.name, mtimeMs: Number(stat(path).mtimeMs) };
      })
      .filter((entry) => Number.isFinite(entry.mtimeMs));
    const cutoff = now() - CAPTURE_MARKER_MAX_AGE_MS;
    const markers = stateFiles
      .filter((entry) => entry.name.endsWith(".captured"))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const [index, marker] of markers.entries()) {
      if (marker.mtimeMs < cutoff || index >= CAPTURE_MARKER_LIMIT) {
        remove(marker.path, { force: true });
      }
    }
    // Active-generation state is one file per host Session and is not subject to the marker count
    // cap. Remove only abandoned state so long-running active Sessions retain their sourceRef.
    for (const active of stateFiles.filter((entry) => entry.name.endsWith(".json"))) {
      if (active.mtimeMs < cutoff) remove(active.path, { force: true });
    }
  } catch {
    // Capture state is an optimization. Permission races or cleanup failures stay fail-open.
  }
}

/** Create a generation ticket without persisting the transcript path or session id. */
export function beginCapture(input, {
  stat = statSync,
  generation = randomUUID,
  prune = pruneCaptureState,
} = {}) {
  if (typeof input?.transcript_path !== "string" || !input.transcript_path) return null;
  try {
    const metadata = stat(input.transcript_path);
    const sessionKey = typeof input.session_id === "string" && input.session_id
      ? input.session_id
      : input.transcript_path;
    const path = join(captureStateDir(), `${hash(sessionKey)}.json`);
    const fingerprint = hash(JSON.stringify([
      sessionKey,
      input.transcript_path,
      Number(metadata.size),
      Number(metadata.mtimeMs),
    ]));
    const previous = readState(path);
    const previousSourceRef = typeof previous.sourceRef === "string" && previous.sourceRef
      ? previous.sourceRef
      : null;
    const ticket = {
      path,
      fingerprint,
      generation: generation(),
      sourceRef: previousSourceRef ?? `capture-${randomUUID()}`,
    };
    writeState(path, {
      activeFingerprint: fingerprint,
      generation: ticket.generation,
      sourceRef: ticket.sourceRef,
      updatedAt: Date.now(),
    });
    prune();
    return ticket;
  } catch {
    return null;
  }
}

export function isLatestCapture(ticket) {
  return Boolean(ticket && readState(ticket.path).generation === ticket.generation);
}

export function wasCaptured(ticket, phase = "content") {
  return Boolean(ticket && readState(capturedStatePath(ticket, phase)).capturedFingerprint === ticket.fingerprint);
}

/** Write an immutable per-fingerprint marker without touching the active generation. */
export function markCaptured(ticket, phase = "content") {
  if (!ticket) return;
  writeState(capturedStatePath(ticket, phase), {
    capturedFingerprint: ticket.fingerprint,
    phase: phase === "complete" ? "complete" : "content",
    capturedAt: Date.now(),
  });
}
