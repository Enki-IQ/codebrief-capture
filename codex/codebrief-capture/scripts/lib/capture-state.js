import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
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

function capturedStatePath(ticket) {
  return `${ticket.path}.${ticket.fingerprint}.captured`;
}

/** Create a generation ticket without persisting the transcript path or session id. */
export function beginCapture(input, { stat = statSync, generation = randomUUID } = {}) {
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
    const ticket = { path, fingerprint, generation: generation() };
    writeState(path, {
      activeFingerprint: fingerprint,
      generation: ticket.generation,
      updatedAt: Date.now(),
    });
    return ticket;
  } catch {
    return null;
  }
}

export function isLatestCapture(ticket) {
  return Boolean(ticket && readState(ticket.path).generation === ticket.generation);
}

export function wasCaptured(ticket) {
  return Boolean(ticket && readState(capturedStatePath(ticket)).capturedFingerprint === ticket.fingerprint);
}

/** Write an immutable per-fingerprint marker without touching the active generation. */
export function markCaptured(ticket) {
  if (!ticket) return;
  writeState(capturedStatePath(ticket), {
    capturedFingerprint: ticket.fingerprint,
    capturedAt: Date.now(),
  });
}
