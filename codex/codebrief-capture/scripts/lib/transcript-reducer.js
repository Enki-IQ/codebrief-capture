import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { scrubTranscriptText } from "./scrub.js";

export const MAX_ROLLOUT_TAIL_BYTES = 700_000;
export const MAX_REDUCED_TRANSCRIPT_BYTES = 240_000;
const MAX_MESSAGE_BYTES = 24_000;
const TAIL_CUSHION_BYTES = 65_536;

export function readRolloutTail(path, maxBytes = MAX_ROLLOUT_TAIL_BYTES) {
  const fd = openSync(path, "r");
  try {
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, maxBytes + TAIL_CUSHION_BYTES);
    const buffer = Buffer.alloc(readSize);
    readSync(fd, buffer, 0, readSize, size - readSize);
    let text = buffer.toString("utf8");
    if (size > readSize) {
      const newline = text.indexOf("\n");
      text = newline === -1 ? "" : text.slice(newline + 1);
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function boundedText(value) {
  if (typeof value !== "string") return "";
  const clean = scrubTranscriptText(value).replaceAll("\u0000", "").trim();
  const bytes = Buffer.from(clean);
  if (bytes.length <= MAX_MESSAGE_BYTES) return clean;
  return bytes.subarray(bytes.length - MAX_MESSAGE_BYTES).toString("utf8").replace(/^\uFFFD/, "");
}

function responseMessage(payload) {
  if (payload?.type !== "message" || !["user", "assistant"].includes(payload.role)) return null;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content
    .filter((part) => ["input_text", "output_text", "text"].includes(part?.type))
    .map((part) => part.text)
    .filter((part) => typeof part === "string")
    .join("\n");
  return { role: payload.role, text: boundedText(text) };
}

function rolloutEntry(record) {
  const payload = record?.payload;
  if (record?.type === "event_msg" && payload?.type === "user_message") {
    return { role: "user", text: boundedText(payload.message) };
  }
  if (record?.type === "event_msg" && payload?.type === "agent_message") {
    return { role: "assistant", text: boundedText(payload.message) };
  }
  if (record?.type === "response_item") {
    const message = responseMessage(payload);
    if (message) return message;
    if (payload?.type === "function_call" && /^[A-Za-z0-9_.:-]{1,80}$/.test(payload.name ?? "")) {
      return { role: "tool", text: payload.name };
    }
  }
  return null;
}

/** Reduce untrusted Codex rollout JSONL to bounded conversational intent context. */
export function reduceCodexRollout(jsonl, maxBytes = MAX_REDUCED_TRANSCRIPT_BYTES) {
  const entries = [];
  const seen = new Set();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const entry = rolloutEntry(record);
    if (!entry?.text) continue;
    const key = `${entry.role}\u0000${entry.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }

  const blocks = entries.map(({ role, text }) => role === "tool"
    ? `[tool used: ${text}]`
    : `${role === "user" ? "USER" : "ASSISTANT"}:\n${text}`);
  const selected = [];
  let total = 0;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const bytes = Buffer.byteLength(blocks[index]) + 2;
    if (selected.length && total + bytes > maxBytes) break;
    selected.unshift(blocks[index]);
    total += bytes;
  }
  return selected.join("\n\n");
}
