import { spawnSync } from "node:child_process";
import { openSync, fstatSync, readSync, closeSync } from "node:fs";

// Claude Code's --json-schema requires a top-level OBJECT schema (a top-level array is rejected by the
// API with "input_schema.type: Input should be 'object'"), so the records array is wrapped in an object.
export const INTENT_SCHEMA = {
  type: "object",
  required: ["records"],
  properties: {
    records: {
      type: "array",
      items: {
        type: "object",
        required: ["kind", "summary", "sourceType", "sourceRef"],
        properties: {
          kind: { type: "string", enum: ["decision", "plan", "deferral", "constraint"] },
          summary: { type: "string", maxLength: 400 },
          sourceType: { type: "string", enum: ["session", "commit"] },
          sourceRef: { type: "string" },
          anchor: {
            type: "object",
            properties: { symbol: { type: "string" }, path: { type: "string" }, startLine: { type: "integer" }, endLine: { type: "integer" } },
          },
        },
      },
    },
  },
};

export function buildPrompt({ fullName, commitSha }) {
  return [
    `You are distilling DEVELOPER INTENT from this coding session on the repo "${fullName}" (HEAD ${commitSha}).`,
    `Extract only decisions made, plans stated, work deferred ("come back to X"), and constraints adopted.`,
    `For each, write a short plain-English summary (<=400 chars) and, where clear, anchor it to a file path or a symbol name referenced in the session.`,
    `NEVER include code, code snippets, secrets, keys, tokens, or file contents in a summary — describe intent in prose only.`,
    `Note: for a very long session, only the most recent portion of the transcript is provided (it may start mid-conversation) — extract intent from what's shown, don't flag the truncation itself as an issue.`,
    `Output ONLY a JSON object { "records": [ ... ] } matching the provided schema. If there is no clear intent, output { "records": [] }.`,
  ].join("\n");
}

export function parseDistillOutput(stdout) {
  try {
    let v = JSON.parse(stdout);
    // `--output-format json` wraps the answer in a result envelope; the schema-constrained payload
    // is under `structured_output`. Unwrap it before reading records.
    if (v && typeof v === "object" && !Array.isArray(v) && v.structured_output !== undefined) v = v.structured_output;
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.records)) return v.records;
    if (v && Array.isArray(v.result)) return v.result;
    return [];
  } catch { return []; }
}

// Distill via the user's own `claude -p`: transcript on STDIN (not argv → no ARG_MAX), structured
// output via `--output-format json`. Verified against Claude Code 2.1.185.
/** Build the `claude` argv for the distill call. Exported so the invocation contract is unit-testable. */
export function buildDistillArgs({ fullName, commitSha, sessionId, model = "sonnet" }) {
  const instructions = `${buildPrompt({ fullName, commitSha })}\nSession id: ${sessionId}\nThe session transcript (JSONL) is provided on stdin.`;
  const args = ["-p", instructions, "--json-schema", JSON.stringify(INTENT_SCHEMA), "--no-session-persistence", "--output-format", "json"];
  if (model) args.push("--model", model); // runs under the user's own account; Codebrief incurs no cost
  return args;
}

// TWO separate size limits are in play here (verified empirically against Claude Code 2.1.200,
// both against a real ~20MB production transcript):
//  1. `claude -p` hard-rejects piped stdin over 10MB ("piped stdin input exceeds 10MB. Pass
//     large content as a file path in your prompt instead").
//  2. The REAL binding constraint is much tighter: the model's total request token limit
//     (1,000,000 tokens). A 2MB transcript (~517K tokens) failed with "Prompt is too long ...
//     the request is ~1,148,245 tokens (limit 1,000,000)" — ~631K tokens of that was fixed
//     overhead (system prompt, tool definitions, schema), leaving roughly ~370K tokens
//     (~1.4MB at the observed ~3.9 bytes/token ratio for this JSONL format) as the worst-case
//     transcript budget in a plugin-heavy dev environment. 500KB and 700KB both succeeded
//     cleanly end-to-end (real distilled output, well under the 120s timeout).
// Capped well under that measured edge for margin — a different repo/user's overhead (fewer
// enabled plugins/skills, shorter CLAUDE.md) will vary, and this errs toward "reliably captures
// something" over "maximize captured history and risk failing again."
export const MAX_TRANSCRIPT_STDIN_BYTES = 700_000;

/**
 * Keep the LAST `maxBytes` of `transcript`, trimmed forward to the next newline so the result
 * starts on a clean JSONL line boundary (only the leading partial line of the tail slice is
 * dropped). The tail — not the head — is kept deliberately: JSONL is append-only chronological,
 * and "decisions made / plans stated / work deferred" (what distillation extracts) are
 * disproportionately likely to show up as the session's most recent turns, not its earliest ones.
 */
export function truncateTranscriptForStdin(transcript, maxBytes = MAX_TRANSCRIPT_STDIN_BYTES) {
  const buf = Buffer.from(transcript, "utf8");
  if (buf.length <= maxBytes) return transcript;
  const tail = buf.subarray(buf.length - maxBytes);
  const newlineIndex = tail.indexOf(0x0a);
  const clean = newlineIndex === -1 ? tail : tail.subarray(newlineIndex + 1);
  return clean.toString("utf8");
}

// Read only the tail bytes actually needed, instead of loading a (potentially 20MB+) transcript
// fully into memory just to discard most of it. Reads a little more than maxBytes so
// truncateTranscriptForStdin still has room to trim forward to a clean JSONL line boundary (it
// only trims when its input is strictly larger than maxBytes) — a seek can land mid-UTF8-char or
// mid-line at the read boundary, but that's harmless: it falls within the leading partial line
// truncateTranscriptForStdin already discards.
const TAIL_READ_CUSHION_BYTES = 65_536;

function readTranscriptTail(transcriptPath, maxBytes) {
  // Open ONCE and do every subsequent operation (size check + read) against that file
  // descriptor, never re-resolving transcriptPath. A separate statSync(path) followed by a
  // second openSync(path)/readFileSync(path) is a TOCTOU race (CodeQL js/file-system-race) — the
  // file at that path isn't guaranteed to still be the same file by the second call. fstatSync
  // on an already-open fd always refers to the exact file that was opened, regardless of what
  // happens to the path afterward.
  const fd = openSync(transcriptPath, "r");
  try {
    const { size } = fstatSync(fd);
    const readSize = Math.min(size, maxBytes + TAIL_READ_CUSHION_BYTES);
    const start = size - readSize;
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, start);
    return buf.toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function distill({ transcriptPath, fullName, commitSha, sessionId, model = "sonnet", spawn = spawnSync, timeoutMs = 120_000 }) {
  const tail = readTranscriptTail(transcriptPath, MAX_TRANSCRIPT_STDIN_BYTES);
  const transcript = truncateTranscriptForStdin(tail);
  const args = buildDistillArgs({ fullName, commitSha, sessionId, model });
  // `timeout` bounds a stalled `claude` so the SessionEnd hook can't hang the shutdown.
  const res = spawn("claude", args, { input: transcript, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout) {
    // A failed/timed-out claude invocation is indistinguishable from "genuinely no intent found"
    // to the caller by design (a background telemetry hook must never surface an alarming error
    // to the user) — but it must be diagnosable, so log it when a developer opts in. `res.stderr`
    // is deliberately NOT included: it's free-form CLI output that can plausibly echo back
    // fragments of the failing prompt/transcript, which must never be logged per this file's own
    // "never include code/secrets/tokens" rule — only structured, content-free fields are safe.
    if (process.env.CODEBRIEF_DEBUG) {
      console.error(`[codebrief] distill: claude exited status=${res.status} signal=${res.signal ?? "none"} error=${res.error?.message ?? "none"}`);
    }
    return [];
  }
  return parseDistillOutput(res.stdout.trim());
}
