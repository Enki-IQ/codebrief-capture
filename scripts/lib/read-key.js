import { createInterface } from "node:readline";

/** Read a line from the TTY with echo SUPPRESSED (key never shows on screen, never in argv/history). */
export function readHiddenTty(promptText, { input = process.stdin, output = process.stdout } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, terminal: true });
    rl._writeToOutput = () => {}; // suppress echo of typed/pasted characters
    output.write(promptText);
    rl.question("", (ans) => { rl.close(); output.write("\n"); resolve(ans.trim()); });
  });
}

/** Read piped stdin to end (supports `printf %s '<key>' | ... login`). */
export function readPipedStdin(input = process.stdin) {
  return new Promise((resolve) => {
    let buf = ""; input.setEncoding("utf8");
    input.on("data", (c) => (buf += c));
    input.on("end", () => resolve(buf.trim()));
  });
}

/**
 * Resolve the login key without ever exposing it in argv when avoidable.
 * Precedence: --key (discouraged; visible in argv) > piped stdin > hidden TTY prompt.
 * Readers are injectable for testing.
 */
export async function readLoginKey(rest, io = {}) {
  const { isTTY = process.stdin.isTTY, readPiped = readPipedStdin, readHidden = readHiddenTty } = io;
  const ki = rest.indexOf("--key");
  if (ki >= 0 && rest[ki + 1]) return rest[ki + 1].trim();
  if (!isTTY) return (await readPiped()).trim();
  return (await readHidden("Paste your Codebrief CLI key (input hidden, press Enter): ")).trim();
}
