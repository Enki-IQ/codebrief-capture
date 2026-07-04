import fs from "node:fs";

/**
 * True only when a key is genuinely being delivered on stdin — a pipe (`printf %s "$KEY" | login`)
 * or a redirected file (`login < keyfile`). A merely non-TTY stdin is NOT piped input: Claude Code's
 * agent shell and the `!` prefix hand the process a non-TTY char device with no data, and those must
 * still use browser login (which reads no stdin at all).
 */
export function stdinHasPipedKey(fd = 0) {
  try { const s = fs.fstatSync(fd); return s.isFIFO() || s.isFile(); }
  catch { return false; }
}

/**
 * Pick login mode. Browser (loopback, click-through) is the default and needs no stdin, so it works
 * whether launched from an interactive terminal or by Claude. We fall back to paste only for
 * deliberate non-interactive key delivery: an explicit `--key` arg, or a key piped/redirected on stdin.
 */
export function chooseLoginMode(rest, { piped = stdinHasPipedKey() } = {}) {
  if (rest.includes("--key")) return "paste";
  if (piped) return "paste";
  return "browser";
}
