export { runTandemCommand as returnTandemCommand } from './lib/tandem-client.js';
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
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
import { scrubTranscriptText } from "./lib/scrub.js";
import { classifyCapture } from "./lib/model-complete.js";

const MAX_STDIN_BYTES = 128 * 1024;
const MAX_TRANSCRIPT_TAIL_BYTES = 700 * 1024;
const MAX_REDUCED_TRANSCRIPT_BYTES = 220 * 1024;
const MAX_MESSAGE_BYTES = 16 * 1024;

const CLASSIFICATION_SCHEMA = JSON.parse(readFileSync(
  new URL("../schemas/active-project-result.schema.json", import.meta.url),
  "utf8",
));

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
  const config = dependencies.loadConfig();
  return {
    apiKey: creds.apiKey,
    apiBaseUrl: creds.apiBaseUrl ?? config.apiBaseUrl,
  };
}

function canonicalResult(input) {
  return validateHandoffResult(input);
}

export function resultFingerprint(input) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalResult(input)), "utf8")
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
    const normalized = canonicalResult(result);
    const existing = d.loadHandoffOutbox(context.handoff.handoffId);
    const staged = existing?.result ?? normalized;
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
        return {
          status: "error:auth",
          fingerprint: resultFingerprint(authoritative),
        };
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
      return {
        status: "returned",
        fingerprint: resultFingerprint(authoritative),
      };
    });
  } catch {
    return { status: "error:submit" };
  }
}

async function renewActiveProject({ cwd }, dependencies) {
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

function readTail(path, maxBytes = MAX_TRANSCRIPT_TAIL_BYTES) {
  const descriptor = openSync(path, "r");
  try {
    const { size } = fstatSync(descriptor);
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(descriptor, buffer, 0, length, size - length);
    let text = buffer.toString("utf8");
    if (size > length) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(descriptor);
  }
}

function timestamp(record) {
  for (const value of [record?.timestamp, record?.created_at, record?.createdAt]) {
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return Date.parse(value);
  }
  return null;
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => ["text", "input_text", "output_text"].includes(part?.type))
    .map((part) => part.text)
    .filter((part) => typeof part === "string")
    .join("\n");
}

function conversationalEntry(record) {
  if (record?.type === "user" || record?.type === "assistant") {
    const text = contentText(record.message?.content ?? record.content);
    return text ? { role: record.type, text } : null;
  }
  const payload = record?.payload;
  if (record?.type === "event_msg" && payload?.type === "user_message") {
    return typeof payload.message === "string" ? { role: "user", text: payload.message } : null;
  }
  if (record?.type === "event_msg" && payload?.type === "agent_message") {
    return typeof payload.message === "string" ? { role: "assistant", text: payload.message } : null;
  }
  if (record?.type === "response_item" && payload?.type === "message") {
    const text = contentText(payload.content);
    return text && ["user", "assistant"].includes(payload.role)
      ? { role: payload.role, text }
      : null;
  }
  return null;
}

function boundedMessage(value) {
  const scrubbed = scrubTranscriptText(value).replaceAll("\u0000", "").trim();
  const bytes = Buffer.from(scrubbed, "utf8");
  if (bytes.length <= MAX_MESSAGE_BYTES) return scrubbed;
  return bytes.subarray(bytes.length - MAX_MESSAGE_BYTES).toString("utf8").replace(/^\uFFFD/, "");
}

export function reduceTranscriptAfterMarker(transcriptPath, startMarker) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return "";
  const marker = Date.parse(startMarker);
  if (Number.isNaN(marker)) return "";
  const entries = [];
  let afterMarker = false;
  for (const line of readTail(transcriptPath).split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const recordTimestamp = timestamp(record);
    if (recordTimestamp !== null) {
      afterMarker = recordTimestamp >= marker;
      if (!afterMarker) continue;
    }
    if (!afterMarker) continue;
    const entry = conversationalEntry(record);
    if (!entry) continue;
    const text = boundedMessage(entry.text);
    if (text) entries.push(`${entry.role.toUpperCase()}:\n${text}`);
  }
  const selected = [];
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(entries[index], "utf8") + 2;
    if (selected.length && bytes + size > MAX_REDUCED_TRANSCRIPT_BYTES) break;
    selected.unshift(entries[index]);
    bytes += size;
  }
  return selected.join("\n\n");
}

export function classifyWithClaude({
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
    validate: canonicalResult,
  });
}

export async function handleActiveProjectTurn({
  input,
  reason = "session_end",
  classify = classifyWithClaude,
}, overrides = {}) {
  const d = { ...DEFAULT_DEPS, ...overrides };
  try {
    const context = activeContext(input?.cwd ?? process.cwd(), d);
    if (context.status) return { status: context.status };
    const pending = d.loadHandoffOutbox(context.handoff.handoffId);
    if (pending) {
      return submitActiveProjectResult({
        cwd: input?.cwd ?? process.cwd(),
        result: pending.result,
      }, d);
    }
    const transcript = reduceTranscriptAfterMarker(
      input?.transcript_path,
      context.handoff.startMarker,
    );
    const classification = await classify({ transcript, reason });
    if (!classification?.terminal) {
      return renewActiveProject({ cwd: input?.cwd ?? process.cwd() }, d);
    }
    return submitActiveProjectResult({
      cwd: input?.cwd ?? process.cwd(),
      result: classification.result,
    }, d);
  } catch {
    return { status: "error" };
  }
}

async function readBoundedJson(stream = process.stdin, maxBytes = MAX_STDIN_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new TypeError("result exceeds local limit");
    chunks.push(chunk);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return canonicalResult(parsed);
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
