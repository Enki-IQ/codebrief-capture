import {runAgentsCommand,readCheckpointInput,maintainAgentPresence} from './lib/connected-agent-client.js';
import {bootstrapConductorCapture} from './lib/conductor-bootstrap.js';
import {runTandemCommand,readConductorSession,TandemBriefBudgetError,DEPENDENCY_BASE_REQUIRED_GUIDANCE} from './lib/tandem-client.js';
import { clearCreds, loadCreds, saveCreds } from "./lib/credentials.js";
import { disableRepo, enableRepo, listEnabledRepos, loadConfig } from "./lib/config.js";
import { resolveRepo } from "./lib/repo.js";
import { isDistillerAvailable } from "./lib/preflight.js";
import { captureModelCommand, captureModelId } from "./lib/model-complete.js";
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

export async function main(args = process.argv.slice(2), overrides = {}) {
  const [command, ...rest] = args;
  if(command==='agents'){
    const log=overrides.log??console.log,errorLog=overrides.error??console.error;
    const relay=rest.includes('--provider')&&rest[rest.indexOf('--provider')+1]==='conductor'&&['inbox','request','ack','reply','tool','rooms'].includes(rest[0]);
    const repo=(overrides.resolveRepo??resolveRepo)(process.cwd()),creds=relay?null:(overrides.loadCreds??loadCreds)();if(!repo||(!relay&&!creds?.apiKey))return 1;
    try{const context={credentials:relay?null:{...creds,apiBaseUrl:creds.apiBaseUrl??loadConfig().apiBaseUrl},repoFullName:repo.fullName,...overrides.agentsContext};if(rest[0]==='checkpoint'){if(!rest.includes('--hook-input')||!(overrides.loadConfig??loadConfig)().enabledRepos?.includes(repo.fullName))throw new Error();context.deadline=Date.now()+5000;context.hookSessionId=await readCheckpointInput();}log(JSON.stringify(await runAgentsCommand(rest,context)));if(rest[0]==='serve'&&!rest.includes('--once'))await maintainAgentPresence(rest,context);return 0;}catch(error){errorLog(error?.message==='room_post_unknown'?"Room post is unconfirmed. Keep the original operation ID; do not create a replacement or resend automatically.":error?.message==='room_read_unavailable'?"Room read unavailable; check current session and room association.":error?.code==='native_login_required'?"native_login_required: Sign in within the official user-owned native application. Account observation does not establish subscription or integration eligibility.":"Connected agent command unavailable; check account, pairing and current claim.");return 1;}
  }
  if(command==='tandem'){
    const log=overrides.log??console.log,errorLog=overrides.error??console.error;
    if(rest[0]==='bootstrap'){try{if(rest.length!==1)throw new Error('usage: codebrief tandem bootstrap');log(JSON.stringify(await bootstrapConductorCapture({...overrides.tandemContext})));return 0;}catch(error){errorLog(error?.status?`Launch preflight failed (${error.status}).`:error.message);return 1;}}
    const repo=(overrides.resolveRepo??resolveRepo)(process.cwd());if(!repo)return 1;
    const launchSession=readConductorSession(overrides.tandemContext?.root??process.cwd(),overrides.tandemContext?.options);
    const creds=launchSession?.launchId?null:(overrides.loadCreds??loadCreds)();if(!creds?.apiKey&&!launchSession?.launchId)return 1;
    try{log(JSON.stringify(await runTandemCommand(rest,{credentials:creds?{...creds,apiBaseUrl:creds.apiBaseUrl??loadConfig().apiBaseUrl}:null,repoFullName:repo.fullName,...overrides.tandemContext})));return 0;}catch(error){if(error?.status===409&&error?.code==='dependency_base_required'){errorLog(JSON.stringify({error:'dependency_base_required',guidance:DEPENDENCY_BASE_REQUIRED_GUIDANCE}));return 1;}if(error instanceof TandemBriefBudgetError){errorLog(JSON.stringify({error:error.code,expansionReferences:error.expansionReferences}));return 1;}errorLog(error?.status?`Tandem failed (${error.status}).`:error.message);return 1;}
  }

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
    const command = captureModelCommand();
    console.error(isDistillerAvailable()
      ? `model CLI: found (${command}).`
      : `model CLI: NOT found (${command}) - distillation will produce nothing. Install that CLI or set CODEBRIEF_DISTILL_COMMAND.`);
    console.error(`Distillation model: ${captureModelId(cfg.distillModel)}.`);
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
