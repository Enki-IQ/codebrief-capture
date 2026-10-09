import {runAgentsCommand,readCheckpointInput,maintainAgentPresence} from './lib/connected-agent-client.js';
import {bootstrapConductorCapture} from './lib/conductor-bootstrap.js';
import { runTandemCommand, readConductorSession, TandemBriefBudgetError, DEPENDENCY_BASE_REQUIRED_GUIDANCE } from './lib/tandem-client.js';
import { loadCreds, saveCreds, clearCreds } from "./lib/credentials.js";
import { loadConfig, enableRepo, disableRepo, listEnabledRepos } from "./lib/config.js";
import { resolveRepo } from "./lib/repo.js";
import { isDistillerAvailable } from "./lib/preflight.js";
import { captureModelCommand, captureModelId } from "./lib/model-complete.js";
import { readLoginKey } from "./lib/read-key.js";
import { chooseLoginMode } from "./lib/login-mode.js";
import { runLoopbackLogin } from "./lib/browser-login.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { ensureStatusLineWrapped } from "./lib/statusline-wrap.js";
import {
  WorkClientError,
  cancelWork,
  claimWork,
  listWork,
} from "./lib/active-project-client.js";
import {
  clearActiveHandoff,
  loadActiveHandoff,
  saveActiveHandoff,
} from "./lib/handoff-state.js";
import { resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_DEPENDENCIES = {
  cancelWork,
  claimWork,
  clearActiveHandoff,
  disableRepo,
  enableRepo,
  ensureStatusLineWrapped,
  error: console.error,
  isDistillerAvailable,
  listEnabledRepos,
  listWork,
  loadActiveHandoff,
  loadConfig,
  loadCreds,
  log: console.log,
  now: () => new Date(),
  resolveRepo,
  saveActiveHandoff,
};

function wireStatusLine(dependencies = DEFAULT_DEPENDENCIES) {
  try {
    if (dependencies.ensureStatusLineWrapped(__dirname) === "wrapped") {
      dependencies.error("Status line now shows Codebrief capture state (chained onto your existing status line, if any).");
    }
  } catch (e) {
    dependencies.error(`Status-line setup skipped (${e instanceof Error ? e.message : "unknown error"}).`);
  }
}

function finishLogin(apiKey, apiBaseUrl, dependencies = DEFAULT_DEPENDENCIES) {
  saveCreds({ apiKey, apiBaseUrl });
  dependencies.error("Logged in.");
  // Auto-enable is best-effort: a failure here (e.g. disk full, read-only $HOME)
  // must never retract the login that already succeeded above.
  try {
    const repo = dependencies.resolveRepo(process.cwd());
    if (repo) {
      dependencies.enableRepo(repo.fullName);
      dependencies.error(`Capture enabled for ${repo.fullName}.`);
    }
  } catch (e) {
    dependencies.error(`Capture auto-enable failed (${e instanceof Error ? e.message : "unknown error"}) — run /codebrief-capture:codebrief-enable manually.`);
  }
  wireStatusLine(dependencies);
}

function workCredentials(dependencies) {
  const credentials = dependencies.loadCreds();
  if (!credentials?.apiKey) {
    dependencies.error("Not logged in. Run codebrief-cli login.");
    return null;
  }
  const config = dependencies.loadConfig();
  return {
    apiKey: credentials.apiKey,
    apiBaseUrl: credentials.apiBaseUrl ?? config.apiBaseUrl,
  };
}

function workRepo(dependencies) {
  const repo = dependencies.resolveRepo(process.cwd());
  if (!repo) dependencies.error("Work commands require a GitHub origin remote.");
  return repo;
}

function workError(error, dependencies) {
  dependencies.error(error instanceof WorkClientError
    ? error.message
    : "Codebrief work command failed.");
  return 1;
}

async function runWorkCommand(args, dependencies) {
  const [command, ...rest] = args;
  const repo = workRepo(dependencies);
  if (!repo) return 1;
  if (command === "show") {
    if (rest.length) {
      dependencies.error("usage: codebrief-cli work show");
      return 1;
    }
    const active = dependencies.loadActiveHandoff(repo.fullName);
    if (!active) {
      dependencies.error("No active Codebrief work claim for this repository.");
      return 1;
    }
    dependencies.log(JSON.stringify(active));
    return 0;
  }
  const credentials = workCredentials(dependencies);
  if (!credentials) return 1;
  try {
    if (command === "list") {
      if (rest.length) throw new TypeError("usage: codebrief-cli work list");
      const work = await dependencies.listWork({
        ...credentials,
        repoFullName: repo.fullName,
      });
      dependencies.log(JSON.stringify(work));
      return 0;
    }
    if (command === "claim") {
      const selector = rest[0];
      const hostIndex = rest.indexOf("--host");
      const host = hostIndex >= 0 ? rest[hostIndex + 1] : "";
      if (
        !selector
        || hostIndex !== 1
        || rest.length !== 3
        || (host !== "codex" && host !== "claude")
      ) {
        throw new TypeError("usage: codebrief-cli work claim <action-id-or-locator> --host <codex|claude>");
      }
      if (dependencies.loadActiveHandoff(repo.fullName)) {
        dependencies.error("An active Codebrief work claim already exists for this repository.");
        return 1;
      }
      const actionSelector = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(selector)
        ? { actionId: selector }
        : { locator: selector };
      const claimed = await dependencies.claimWork({
        ...credentials,
        repoFullName: repo.fullName,
        ...actionSelector,
        host,
      });
      try {
        dependencies.saveActiveHandoff({
          repoFullName: repo.fullName,
          handoffId: claimed.handoffId,
          actionId: claimed.actionId,
          actionVersion: claimed.actionVersion,
          host: claimed.host ?? host,
          startMarker: dependencies.now().toISOString(),
        });
      } catch {
        try {
          await dependencies.cancelWork({
            ...credentials,
            repoFullName: repo.fullName,
            handoffId: claimed.handoffId,
          });
        } catch {
          // The server lease remains bounded even if compensating cancellation is unavailable.
        }
        dependencies.error("Codebrief claimed work could not be saved locally; the claim was released when possible.");
        return 1;
      }
      dependencies.log(JSON.stringify(claimed.contract));
      return 0;
    }
    if (command === "cancel") {
      if (rest.length) throw new TypeError("usage: codebrief-cli work cancel");
      const active = dependencies.loadActiveHandoff(repo.fullName);
      if (!active) {
        dependencies.error("No active Codebrief work claim for this repository.");
        return 1;
      }
      await dependencies.cancelWork({
        ...credentials,
        repoFullName: repo.fullName,
        handoffId: active.handoffId,
      });
      dependencies.clearActiveHandoff(repo.fullName);
      dependencies.error("Codebrief work claim cancelled.");
      return 0;
    }
    dependencies.error("usage: codebrief-cli work <list|claim|show|cancel>");
    return 1;
  } catch (error) {
    return workError(error, dependencies);
  }
}

export async function main(args = process.argv.slice(2), overrides = {}) {
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  const [cmd, ...rest] = args;
  if (cmd === "agents") {
    const relay=rest.includes("--provider")&&rest[rest.indexOf("--provider")+1]==="conductor"&&["inbox","request","ack","reply","tool","rooms"].includes(rest[0]);
    const credentials=relay?null:workCredentials(dependencies),repo=workRepo(dependencies);
    if((!relay&&!credentials)||!repo)return 1;
    try {const context={credentials,repoFullName:repo.fullName,...overrides.agentsContext};if(rest[0]==='checkpoint'){if(!rest.includes('--hook-input')||!dependencies.loadConfig().enabledRepos?.includes(repo.fullName))throw new Error();context.deadline=Date.now()+5000;context.hookSessionId=await readCheckpointInput();}const result=await runAgentsCommand(rest,context);dependencies.log(JSON.stringify(result));if(rest[0]==='serve'&&!rest.includes('--once'))await maintainAgentPresence(rest,context);return 0;}catch(error){dependencies.error(error?.message==='room_post_unknown'?"Room post is unconfirmed. Keep the original operation ID; do not create a replacement or resend automatically.":error?.message==='room_read_unavailable'?"Room read unavailable; check current session and room association.":error?.code==='native_login_required'?"native_login_required: Sign in within the official user-owned native application. Account observation does not establish subscription or integration eligibility.":"Connected agent command unavailable; check account, pairing and current claim.");return 1;}
  }
  if (cmd === "tandem") {
    if(rest[0]==="bootstrap"){try{if(rest.length!==1)throw new Error("usage: codebrief tandem bootstrap");dependencies.log(JSON.stringify(await bootstrapConductorCapture({...overrides.tandemContext})));return 0;}catch(error){dependencies.error(error?.status?`Launch preflight failed (${error.status}).`:error.message);return 1;}}
    const repo=workRepo(dependencies);
    if(!repo)return 1;
    const launchSession=readConductorSession(overrides.tandemContext?.root??process.cwd(),overrides.tandemContext?.options);
    const credentials=launchSession?.launchId?null:workCredentials(dependencies);
    if(!credentials && !launchSession?.launchId)return 1;
    try { const result=await runTandemCommand(rest,{credentials,repoFullName:repo.fullName,...overrides.tandemContext});dependencies.log(JSON.stringify(result));return 0; }
    catch(error){if(error?.status===409&&error?.code==='dependency_base_required'){dependencies.error(JSON.stringify({error:'dependency_base_required',guidance:DEPENDENCY_BASE_REQUIRED_GUIDANCE}));return 1;}if(error instanceof TandemBriefBudgetError){dependencies.error(JSON.stringify({error:error.code,expansionReferences:error.expansionReferences}));return 1;}dependencies.error(error?.status ? `Tandem failed (${error.status}).` : error.message);return 1;}
  }
  if (cmd === "work") return runWorkCommand(rest, dependencies);
  if (cmd === "login") {
    const { apiBaseUrl } = dependencies.loadConfig();
    if (chooseLoginMode(rest) === "browser") {
      try {
        dependencies.error("Opening your browser to authorize this device…");
        const { apiKey } = await runLoopbackLogin({ apiBaseUrl });
        finishLogin(apiKey, apiBaseUrl, dependencies);
        return 0;
      } catch (e) {
        dependencies.error(`Browser login didn't complete (${e instanceof Error ? e.message : "unknown"}). Falling back to manual paste.`);
        // fall through to paste
      }
    }
    const apiKey = await readLoginKey(rest);
    if (!apiKey) { dependencies.error("No key provided. Create one in Settings → Connected CLIs, then run: codebrief-cli login (it prompts securely)."); return 1; }
    finishLogin(apiKey, apiBaseUrl, dependencies);
    return 0;
  }
  if (cmd === "logout") { clearCreds(); dependencies.error("Logged out."); return 0; }
  if (cmd === "status") {
    const c = dependencies.loadCreds();
    dependencies.error(c?.apiKey ? "Logged in." : "Not logged in.");
    const command = captureModelCommand();
    const model = captureModelId(dependencies.loadConfig().distillModel);
    dependencies.error(dependencies.isDistillerAvailable()
      ? `model CLI: found (${command}).`
      : `model CLI: NOT found (${command}) — distillation will produce nothing. Install that CLI or set CODEBRIEF_DISTILL_COMMAND.`);
    dependencies.error(`Distillation model: ${model}.`);
    const repos = dependencies.listEnabledRepos();
    dependencies.error(repos.length ? `Enabled repos: ${repos.join(", ")}` : "Enabled repos: none.");
    return 0;
  }
  if (cmd === "enable") {
    const repo = dependencies.resolveRepo(process.cwd());
    if (!repo) { dependencies.error("Not a connected git repo."); return 1; }
    dependencies.enableRepo(repo.fullName); dependencies.error(`Capture enabled for ${repo.fullName}.`);
    wireStatusLine(dependencies);
    return 0;
  }
  if (cmd === "disable") {
    const repo = dependencies.resolveRepo(process.cwd());
    if (!repo) { dependencies.error("Not a connected git repo."); return 1; }
    dependencies.disableRepo(repo.fullName); dependencies.error(`Capture disabled for ${repo.fullName}.`); return 0;
  }
  if (cmd === "list") {
    const repos = dependencies.listEnabledRepos();
    dependencies.error(repos.length ? `Capture enabled for:\n${repos.map((r) => `  ${r}`).join("\n")}` : "No repos enabled.");
    return 0;
  }
  dependencies.error("usage: codebrief-cli <login|logout|status|enable|disable|list|work>");
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
