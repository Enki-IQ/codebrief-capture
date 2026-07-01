import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

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

export function distill({ transcriptPath, fullName, commitSha, sessionId, model = "sonnet", spawn = spawnSync, timeoutMs = 120_000 }) {
  const transcript = readFileSync(transcriptPath, "utf8");
  const args = buildDistillArgs({ fullName, commitSha, sessionId, model });
  // `timeout` bounds a stalled `claude` so the SessionEnd hook can't hang the shutdown.
  const res = spawn("claude", args, { input: transcript, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs });
  if (res.status !== 0 || !res.stdout) return [];
  return parseDistillOutput(res.stdout.trim());
}
