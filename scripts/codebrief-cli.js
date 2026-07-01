import { loadCreds, saveCreds, clearCreds } from "./lib/credentials.js";
import { loadConfig, enableRepo, disableRepo, listEnabledRepos } from "./lib/config.js";
import { resolveRepo } from "./lib/repo.js";
import { isClaudeAvailable } from "./lib/preflight.js";
import { readLoginKey } from "./lib/read-key.js";
import { chooseLoginMode } from "./lib/login-mode.js";
import { runLoopbackLogin } from "./lib/browser-login.js";

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "login") {
    const { apiBaseUrl } = loadConfig();
    if (chooseLoginMode(rest) === "browser") {
      try {
        console.error("Opening your browser to authorize this device…");
        const { apiKey } = await runLoopbackLogin({ apiBaseUrl });
        saveCreds({ apiKey, apiBaseUrl });
        console.error("Logged in.");
        return;
      } catch (e) {
        console.error(`Browser login didn't complete (${e instanceof Error ? e.message : "unknown"}). Falling back to manual paste.`);
        // fall through to paste
      }
    }
    const apiKey = await readLoginKey(rest);
    if (!apiKey) { console.error("No key provided. Create one in Settings → Connected CLIs, then run: codebrief-cli login (it prompts securely)."); process.exit(1); }
    saveCreds({ apiKey, apiBaseUrl });
    console.error("Logged in.");
    return;
  }
  if (cmd === "logout") { clearCreds(); console.error("Logged out."); return; }
  if (cmd === "status") {
    const c = loadCreds();
    console.error(c?.apiKey ? "Logged in." : "Not logged in.");
    console.error(isClaudeAvailable()
      ? "claude CLI: found."
      : "claude CLI: NOT found — distillation will produce nothing. Install Claude Code and ensure `claude` is on PATH.");
    const repos = listEnabledRepos();
    console.error(repos.length ? `Enabled repos: ${repos.join(", ")}` : "Enabled repos: none.");
    return;
  }
  if (cmd === "enable") {
    const repo = resolveRepo(process.cwd());
    if (!repo) { console.error("Not a connected git repo."); process.exit(1); }
    enableRepo(repo.fullName); console.error(`Capture enabled for ${repo.fullName}.`); return;
  }
  if (cmd === "disable") {
    const repo = resolveRepo(process.cwd());
    if (!repo) { console.error("Not a connected git repo."); process.exit(1); }
    disableRepo(repo.fullName); console.error(`Capture disabled for ${repo.fullName}.`); return;
  }
  if (cmd === "list") {
    const repos = listEnabledRepos();
    console.error(repos.length ? `Capture enabled for:\n${repos.map((r) => `  ${r}`).join("\n")}` : "No repos enabled.");
    return;
  }
  console.error("usage: codebrief-cli <login|logout|status|enable|disable|list>"); process.exit(1);
}
main();
