import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * PostToolUse entrypoint for `git push`/`gh pr create` (see hooks.json's `if` filters — this
 * script trusts that filtering and does not re-check the command itself). Unlike SessionEnd,
 * a PostToolUse hook BLOCKS the user's turn until it exits, and distillation can take 30-70s+
 * (a `claude -p` subprocess) — so this only forwards the small input JSON to a fully DETACHED
 * child running the real capture logic (session-end-hook.js's runCapture), then exits. The
 * detached child gets its own independent stdin pipe (not the parent's, which closes when the
 * parent exits) — cwd/transcript_path/session_id are tiny strings, cheap to re-pipe, so no temp
 * file is needed.
 *
 * `onDone` fires once the payload write to the child's stdin actually completes (success or
 * error) — calling `process.exit(0)` right after issuing `child.stdin.end(...)`, without waiting
 * for it to flush, risks the write being cut off and the detached child never receiving the
 * capture request at all.
 */
export function spawnDetachedCapture(input, spawnFn = spawn, onDone = () => {}) {
  const child = spawnFn(
    process.execPath,
    ["--no-warnings=ExperimentalWarning", join(__dirname, "session-end-hook.js")],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );
  child.on("error", onDone); // e.g. spawn itself failed (ENOENT/EACCES) before stdin ever opens
  child.stdin.on("error", onDone); // e.g. a write-time failure after the child did start
  child.stdin.end(JSON.stringify({ cwd: input.cwd, transcript_path: input.transcript_path, session_id: input.session_id }), onDone);
  child.unref();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // One safety net over the WHOLE flow (stdin read + spawn + payload write): the happy path
  // exits the moment the write completes (well under this), but if anything hangs — the hook
  // framework never closes our stdin, the spawn call blocks, the write never flushes — this
  // guarantees we still don't block the user's turn indefinitely. `unref()` so this timer itself
  // can never be the reason the process stays alive.
  const forceExit = setTimeout(() => process.exit(0), 3_000);
  forceExit.unref();
  const done = () => { clearTimeout(forceExit); process.exit(0); };

  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => {
    let input = {};
    try { input = JSON.parse(buf); } catch { /* no input */ }
    try { spawnDetachedCapture(input, spawn, done); } catch { done(); }
  });
}
