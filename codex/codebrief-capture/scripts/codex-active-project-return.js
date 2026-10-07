import { createHash } from "node:crypto";
import { readFileSync, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  renewWork,
  returnWorkResult,
} from "./lib/active-project-client.js";
import { loadConfig } from "./lib/config.js";
import { loadCreds } from "./lib/credentials.js";
import { validateHandoffResult } from "./lib/handoff-result.js";
import {
  clearActiveHandoff,
  loadActiveHandoff,
  loadHandoffOutbox,
  removeHandoffOutbox,
  saveHandoffOutbox,
  withSubmissionLock,
} from "./lib/handoff-state.js";
import { resolveRepo } from "./lib/repo.js";
import { reduceCodexRollout } from "./lib/transcript-reducer.js";
import { classifyCapture } from "./lib/model-complete.js";

const MAX_STDIN_BYTES = 128 * 1024;
const MAX_ROLLOUT_BYTES = 700 * 1024;
const CLASSIFICATION_SCHEMA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "schemas",
  "active-project-result.schema.json",
);

const DEFAULT_DEPS = {
  clearActiveHandoff,
  loadActiveHandoff,
  loadConfig,
  loadCreds,
  loadHandoffOutbox,
  removeHandoffOutbox,
  renewWork,
  resolveRepo,
  returnWorkResult,
  saveHandoffOutbox,
  withSubmissionLock,
};

export { withSubmissionLock };

function safeErrorStatus(error) {
  if (error?.status === 401) return "error:auth";
  if (error?.status === 403) return "error:scope";
  if (error?.status === 409) return "error:conflict";
  if (error?.status === 410) return "error:expired";
  return "error:submit";
}

function activeContext(cwd, dependencies) {
  const repo = dependencies.resolveRepo(cwd);
  if (!repo?.fullName) return { status: "skipped:no-repo" };
  const handoff = dependencies.loadActiveHandoff(repo.fullName);
  if (!handoff) return { status: "skipped:no-active-handoff", repo };
  return { repo, handoff };
}

function credentials(dependencies) {
  const creds = dependencies.loadCreds();
  if (!creds?.apiKey) return null;
  return {
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl ?? dependencies.loadConfig().apiBaseUrl,
  };
}

function normalizedResult(input) {
  return validateHandoffResult(input);
}

export function resultFingerprint(input) {
  return createHash("sha256")
    .update(JSON.stringify(normalizedResult(input)), "utf8")
    .digest("hex");
}

function terminalizeExpiredWork(context, dependencies) {
  let failure;
  try {
    dependencies.removeHandoffOutbox(context.handoff.handoffId);
  } catch (error) {
    failure = error;
  }
  try {
    dependencies.clearActiveHandoff(context.repo.fullName);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
}

export async function submitActiveProjectResult({ cwd = process.cwd(), result }, overrides = {}) {
  const d = { ...DEFAULT_DEPS, ...overrides };
  try {
    const context = activeContext(cwd, d);
    if (context.status) return { status: context.status };
    const candidate = normalizedResult(result);
    const existing = d.loadHandoffOutbox(context.handoff.handoffId);
    const staged = existing?.result ?? candidate;
    if (!existing) {
      d.saveHandoffOutbox({
        handoffId: context.handoff.handoffId,
        result: staged,
      });
    }
    return await d.withSubmissionLock(context.handoff.handoffId, async () => {
      const current = activeContext(cwd, d);
      if (current.status) return { status: current.status };
      const pending = d.loadHandoffOutbox(current.handoff.handoffId);
      const authoritative = pending?.result ?? staged;
      const auth = credentials(d);
      if (!auth) {
        return { status: "error:auth", fingerprint: resultFingerprint(authoritative) };
      }
      try {
        await d.returnWorkResult({
          ...auth,
          repoFullName: current.repo.fullName,
          handoffId: current.handoff.handoffId,
          result: authoritative,
        });
      } catch (error) {
        if (error?.status === 410) terminalizeExpiredWork(current, d);
        return {
          status: safeErrorStatus(error),
          fingerprint: resultFingerprint(authoritative),
        };
      }
      d.removeHandoffOutbox(current.handoff.handoffId);
      d.clearActiveHandoff(current.repo.fullName);
      return { status: "returned", fingerprint: resultFingerprint(authoritative) };
    });
  } catch {
    return { status: "error:submit" };
  }
}

function timestamp(record) {
  for (const value of [record?.timestamp, record?.created_at, record?.createdAt]) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  }
  return null;
}

function readPostMarkerRollout(path, startMarker) {
  if (typeof path !== "string" || !path) return "";
  const descriptor = openSync(path, "r");
  let size;
  let text;
  try {
    size = fstatSync(descriptor).size;
    const length = Math.min(size, MAX_ROLLOUT_BYTES);
    const tail = Buffer.alloc(length);
    readSync(descriptor, tail, 0, length, size - length);
    text = tail.toString("utf8");
  } finally {
    closeSync(descriptor);
  }
  if (size > MAX_ROLLOUT_BYTES) {
    const newline = text.indexOf("\n");
    text = newline === -1 ? "" : text.slice(newline + 1);
  }
  const marker = Date.parse(startMarker);
  if (Number.isNaN(marker)) return "";
  let afterMarker = false;
  const selected = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const created = timestamp(record);
    if (created !== null) {
      afterMarker = created >= marker;
      if (!afterMarker) continue;
    }
    if (afterMarker) selected.push(line);
  }
  return selected.join("\n");
}

const CLASSIFICATION_SCHEMA = JSON.parse(readFileSync(CLASSIFICATION_SCHEMA_PATH, "utf8"));

export function classifyWithCodex({
  transcript,
  reason,
  model,
  command,
  spawn,
  timeoutMs,
}) {
  return classifyCapture({
    transcript,
    reason,
    schema: CLASSIFICATION_SCHEMA,
    model,
    command,
    spawn,
    timeoutMs,
    validate: normalizedResult,
  });
}

async function renewActiveProject(cwd, dependencies) {
  let context;
  try {
    context = activeContext(cwd, dependencies);
    if (context.status) return { status: context.status };
    const auth = credentials(dependencies);
    if (!auth) return { status: "error:auth" };
    await dependencies.renewWork({
      ...auth,
      repoFullName: context.repo.fullName,
      handoffId: context.handoff.handoffId,
    });
    return { status: "renewed" };
  } catch (error) {
    if (error?.status === 410 && context && !context.status) {
      terminalizeExpiredWork(context, dependencies);
    }
    return { status: safeErrorStatus(error) };
  }
}

export async function runActiveProjectTurn(input, {
  reason = "stop",
  classify = classifyWithCodex,
  deps = {},
} = {}) {
  const d = { ...DEFAULT_DEPS, ...deps };
  const cwd = input?.cwd ?? process.cwd();
  try {
    const context = activeContext(cwd, d);
    if (context.status) return { status: context.status };
    const pending = d.loadHandoffOutbox(context.handoff.handoffId);
    if (pending) {
      return submitActiveProjectResult({ cwd, result: pending.result }, d);
    }
    const transcript = reduceCodexRollout(readPostMarkerRollout(
      input?.transcript_path,
      context.handoff.startMarker,
    ));
    const classification = await classify({ transcript, reason });
    if (!classification?.terminal) return renewActiveProject(cwd, d);
    return submitActiveProjectResult({ cwd, result: classification.result }, d);
  } catch {
    return { status: "error" };
  }
}

async function readBoundedJson(stream = process.stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > MAX_STDIN_BYTES) throw new TypeError("result exceeds local limit");
    chunks.push(chunk);
  }
  return normalizedResult(JSON.parse(Buffer.concat(chunks).toString("utf8")));
}

export async function main() {
  try {
    const result = await readBoundedJson();
    const output = await submitActiveProjectResult({ result });
    process.stdout.write(`${JSON.stringify(output)}\n`);
    return output.status === "returned" ? 0 : 1;
  } catch {
    process.stderr.write("Codebrief return rejected the local result.\n");
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  if (process.env.CODEBRIEF_DISTILL_CHILD !== "1") process.exitCode = await main();
}
