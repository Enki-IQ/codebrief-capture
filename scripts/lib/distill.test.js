import { test } from "node:test";
import assert from "node:assert";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { INTENT_SCHEMA, buildPrompt, buildDistillArgs, parseDistillOutput, distill } from "./distill.js";

test("schema is a top-level object wrapping records[] (Claude Code --json-schema requires object)", () => {
  assert.equal(INTENT_SCHEMA.type, "object");
  assert.deepEqual(INTENT_SCHEMA.properties.records.items.properties.kind.enum, ["decision", "plan", "deferral", "constraint"]);
});
test("prompt names the repo + forbids code/secrets", () => {
  const p = buildPrompt({ fullName: "a/b", commitSha: "abc" });
  assert.match(p, /a\/b/);
  assert.match(p, /never.*(code|secret)/i);
});
test("parseDistillOutput unwraps the --output-format json envelope and tolerates bare shapes", () => {
  assert.equal(parseDistillOutput('{"type":"result","structured_output":{"records":[{"kind":"plan"}]}}').length, 1);
  assert.equal(parseDistillOutput('[{"kind":"plan"}]').length, 1);
  assert.equal(parseDistillOutput('{"records":[{"kind":"plan"}]}').length, 1);
  assert.equal(parseDistillOutput("garbage").length, 0);
});

// Regression guard for the spike #4 fixes (Claude Code 2.1.185): lock the invocation contract so a
// future flag regression fails the suite instead of silently producing an inert distiller.
test("buildDistillArgs: object schema, json output, no unsupported --max-turns flag", () => {
  const args = buildDistillArgs({ fullName: "a/b", commitSha: "abc", sessionId: "s", model: "haiku" });
  const schemaArg = JSON.parse(args[args.indexOf("--json-schema") + 1]);
  assert.equal(schemaArg.type, "object"); // top-level array is rejected by the API
  assert.equal(args[args.indexOf("--output-format") + 1], "json");
  assert.ok(args.includes("--no-session-persistence"));
  assert.equal(args[args.indexOf("--model") + 1], "haiku");
  assert.ok(!args.includes("--max-turns")); // not a real flag in 2.1.185
});

test("distill pipes the transcript on stdin and enforces a timeout (no argv blowup)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cb-distill-"));
  const tp = join(dir, "t.jsonl");
  writeFileSync(tp, "TRANSCRIPT-BODY");
  let captured = null;
  const fakeSpawn = (cmd, args, opts) => { captured = { cmd, args, opts }; return { status: 0, stdout: '{"structured_output":{"records":[{"kind":"plan"}]}}' }; };
  const recs = distill({ transcriptPath: tp, fullName: "a/b", commitSha: "abc", sessionId: "s", spawn: fakeSpawn });
  assert.equal(captured.cmd, "claude");
  assert.equal(captured.opts.input, "TRANSCRIPT-BODY"); // transcript on stdin, not in argv
  assert.ok(captured.opts.timeout > 0);
  assert.equal(recs.length, 1);
});
