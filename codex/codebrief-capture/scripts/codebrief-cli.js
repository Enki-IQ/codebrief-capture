import { clearCreds, loadCreds, saveCreds } from "./lib/credentials.js";
import { disableRepo, enableRepo, listEnabledRepos, loadConfig } from "./lib/config.js";
import { resolveRepo } from "./lib/repo.js";
import { isCodexAvailable } from "./lib/preflight.js";
import { readLoginKey } from "./lib/read-key.js";
import { chooseLoginMode } from "./lib/login-mode.js";
import { runLoopbackLogin } from "./lib/browser-login.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function finishLogin(apiKey, apiBaseUrl) {
  saveCreds({ apiKey, apiBaseUrl });
  console.error("Logged in.");
  try {
    const repo = resolveRepo(process.cwd());
    if (repo) {
      enableRepo(repo.fullName);
      console.error(`Capture enabled for ${repo.fullName}.`);
    }
  } catch {
    console.error("Capture auto-enable failed. Run the Codebrief enable skill manually.");
  }
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === "login") {
    const { apiBaseUrl } = loadConfig();
    if (chooseLoginMode(rest) === "browser") {
      try {
        console.error("Opening your browser to authorize this device...");
        const { apiKey } = await runLoopbackLogin({ apiBaseUrl });
        finishLogin(apiKey, apiBaseUrl);
        return 0;
      } catch {
        console.error("Browser login did not complete. Falling back to a secure manual prompt.");
      }
    }
    const apiKey = await readLoginKey(rest);
    if (!apiKey) {
      console.error("No key provided. Create one in Settings > Connected CLIs, then run the Codebrief login skill again.");
      return 1;
    }
    finishLogin(apiKey, apiBaseUrl);
    return 0;
  }
  if (command === "logout") {
    clearCreds();
    console.error("Logged out.");
    return 0;
  }
  if (command === "status") {
    const credentials = loadCreds();
    const cfg = loadConfig();
    console.error(credentials?.apiKey ? "Logged in." : "Not logged in.");
    console.error(isCodexAvailable()
      ? "codex CLI: found."
      : "codex CLI: NOT found - distillation will produce nothing. Install Codex and ensure it is on PATH.");
    console.error(cfg.codexDistillModel
      ? `Distillation model: ${cfg.codexDistillModel}.`
      : "Distillation model: Codex default.");
    const repos = listEnabledRepos();
    console.error(repos.length ? `Enabled repos: ${repos.join(", ")}` : "Enabled repos: none.");
    return 0;
  }
  if (command === "enable" || command === "disable") {
    const repo = resolveRepo(process.cwd());
    if (!repo) {
      console.error("Not a connected git repo.");
      return 1;
    }
    if (command === "enable") {
      enableRepo(repo.fullName);
      console.error(`Capture enabled for ${repo.fullName}.`);
    } else {
      disableRepo(repo.fullName);
      console.error(`Capture disabled for ${repo.fullName}.`);
    }
    return 0;
  }
  if (command === "list") {
    const repos = listEnabledRepos();
    console.error(repos.length ? `Capture enabled for:\n${repos.map((repo) => `  ${repo}`).join("\n")}` : "No repos enabled.");
    return 0;
  }
  console.error("usage: codebrief-cli <login|logout|status|enable|disable|list>");
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
