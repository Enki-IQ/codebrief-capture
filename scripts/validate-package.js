import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];

function readJson(relativePath) {
  try {
    return JSON.parse(readFileSync(join(root, relativePath), "utf8"));
  } catch (error) {
    errors.push(`${relativePath}: ${error instanceof Error ? error.name : "invalid JSON"}`);
    return {};
  }
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) errors.push(`${label} must be a non-empty string`);
}

function walkFiles(path) {
  return readdirSync(path).flatMap((name) => {
    const child = join(path, name);
    return statSync(child).isDirectory() ? walkFiles(child) : [child];
  });
}

const packageJson = readJson("package.json");
const claudeManifest = readJson(".claude-plugin/plugin.json");
const claudeMarketplace = readJson(".claude-plugin/marketplace.json");
const codexPackage = readJson("codex/codebrief-capture/package.json");
const codexManifest = readJson("codex/codebrief-capture/.codex-plugin/plugin.json");
const codexMarketplace = readJson(".agents/plugins/marketplace.json");
const codexHooks = readJson("codex/codebrief-capture/hooks/hooks.json");
const claudeHooks = readJson("hooks/hooks.json");

const versions = {
  package: packageJson.version,
  claudeManifest: claudeManifest.version,
  claudeMarketplace: claudeMarketplace.plugins?.[0]?.version,
  codexPackage: codexPackage.version,
  codexManifest: codexManifest.version,
};
const uniqueVersions = new Set(Object.values(versions));
if (uniqueVersions.size !== 1 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(packageJson.version ?? "")) {
  errors.push(`package versions must match strict semver: ${JSON.stringify(versions)}`);
}
const expectedVersion = process.argv[2];
if (expectedVersion && packageJson.version !== expectedVersion) {
  errors.push(`expected version ${expectedVersion}, found ${packageJson.version}`);
}

const allowedCodexFields = new Set([
  "id", "name", "version", "description", "skills", "apps", "mcpServers", "interface",
  "author", "homepage", "repository", "license", "keywords",
]);
for (const field of Object.keys(codexManifest)) {
  if (!allowedCodexFields.has(field)) errors.push(`Codex manifest field is unsupported: ${field}`);
}
for (const field of ["name", "version", "description"]) requireString(codexManifest[field], `Codex manifest ${field}`);
requireString(codexManifest.author?.name, "Codex manifest author.name");
for (const field of ["displayName", "shortDescription", "longDescription", "developerName", "category", "defaultPrompt"]) {
  requireString(codexManifest.interface?.[field], `Codex interface ${field}`);
}
if (!Array.isArray(codexManifest.interface?.capabilities) || !codexManifest.interface.capabilities.length) {
  errors.push("Codex interface capabilities must be a non-empty array");
}
if (codexManifest.skills !== "skills") errors.push("Codex manifest skills must resolve to skills");

const marketEntry = codexMarketplace.plugins?.find((plugin) => plugin.name === "codebrief-capture");
if (codexMarketplace.name !== "codebrief") errors.push("Codex marketplace name must be codebrief");
if (marketEntry?.source?.source !== "local" || marketEntry?.source?.path !== "./codex/codebrief-capture") {
  errors.push("Codex marketplace must point to ./codex/codebrief-capture");
}
if (marketEntry?.policy?.installation !== "AVAILABLE" || marketEntry?.policy?.authentication !== "ON_INSTALL") {
  errors.push("Codex marketplace policy is incomplete");
}

const skillRoots = [
  ["Claude", join(root, "skills")],
  ["Codex", join(root, "codex", "codebrief-capture", "skills")],
];
const requiredSkills = ["codebrief-work", "codebrief-return"];
for (const [host, skillsRoot] of skillRoots) {
  for (const name of requiredSkills) {
    if (!existsSync(join(skillsRoot, name, "SKILL.md"))) {
      errors.push(`${host} ${name} is required`);
    }
  }
  for (const name of readdirSync(skillsRoot)) {
    const path = join(skillsRoot, name, "SKILL.md");
    let text;
    try { text = readFileSync(path, "utf8"); } catch {
      errors.push(`${host} ${name} is missing SKILL.md`);
      continue;
    }
    const declaredName = text.match(/^name:\s*([A-Za-z0-9-]+)\s*$/m)?.[1];
    if (!text.startsWith("---\n") || !declaredName || !/^description:\s*\S+/m.test(text)) {
      errors.push(`${host} ${name}/SKILL.md has invalid frontmatter`);
    } else if (declaredName !== name) {
      errors.push(`${host} ${name}: skill frontmatter name must match directory`);
    }
  }
}

for (const relativePath of [
  "scripts/active-project-return.js",
  "scripts/session-end-hook.js",
  "scripts/push-capture-hook.js",
  "codex/codebrief-capture/scripts/codex-active-project-return.js",
  "codex/codebrief-capture/scripts/codex-stop-hook.js",
  "codex/codebrief-capture/scripts/codex-post-tool-hook.js",
]) {
  if (!existsSync(join(root, relativePath))) {
    errors.push(`${relativePath}: required script is missing`);
  }
}

const generatedSharedFiles = [
  "agent-inbox.js",
  "connected-agent-state.js",
  "connected-agent-client.js",
  "native-agent-runtime.js",
  "api-url.js",
  "active-project-client.js",
  "browser-login.js",
  "capture.js",
  "capture-state.js",
  "command-trigger.js",
  "config.js",
  "credentials.js",
  "http.js",
  "handoff-result.js",
  "handoff-state.js",
  "login-mode.js",
  "model-complete.js",
  "preflight.js",
  "read-key.js",
  "repo.js",
  "scrub.js",
];
for (const filename of generatedSharedFiles) {
  try {
    const canonical = readFileSync(join(root, "scripts", "lib", filename));
    const generated = readFileSync(
      join(root, "codex", "codebrief-capture", "scripts", "lib", filename),
    );
    if (!canonical.equals(generated)) {
      errors.push(`${filename}: generated shared file is stale`);
    }
  } catch {
    errors.push(`${filename}: generated shared file is stale or missing`);
  }
}
try {
  const canonical = readFileSync(join(root, "schemas", "active-project-result.schema.json"));
  const generated = readFileSync(
    join(root, "codex", "codebrief-capture", "schemas", "active-project-result.schema.json"),
  );
  if (!canonical.equals(generated)) {
    errors.push("active-project-result.schema.json: generated schema is stale");
  }
} catch {
  errors.push("active-project-result.schema.json: generated schema is stale or missing");
}

const codexPostToolUse = codexHooks.hooks?.PostToolUse;
if (!Array.isArray(codexHooks.hooks?.Stop) || !Array.isArray(codexPostToolUse)) {
  errors.push("Codex hooks must define Stop and PostToolUse");
}
if (codexPostToolUse?.length !== 1 || codexPostToolUse.some((entry) => entry.matcher !== "Bash")) {
  errors.push("Codex PostToolUse matcher must be Bash");
}
const claudePostToolUse = claudeHooks.hooks?.PostToolUse;
const claudePostHandlers = Array.isArray(claudePostToolUse)
  ? claudePostToolUse.flatMap((entry) => Array.isArray(entry?.hooks) ? entry.hooks : [])
  : [];
if (claudePostToolUse?.length !== 2 || claudePostHandlers.length !== 2
    || claudePostHandlers.some(handler=>"if" in handler)
    || claudePostToolUse[0].matcher!=="Bash"
    || !claudePostHandlers[0].command.endsWith('/scripts/push-capture-hook.js"')
    || !claudePostHandlers[1].command.endsWith('/scripts/agent-message-hook.js"')
    || claudePostHandlers[1].timeout!==6) {
  errors.push("Claude PostToolUse must preserve Bash capture and one bounded request-ID checkpoint handler");
}
for(const event of ["SessionStart","UserPromptSubmit"]){
 const handlers=claudeHooks.hooks?.[event]?.flatMap(entry=>entry.hooks??[]);
 if(handlers?.length!==1||handlers[0].timeout!==6||!handlers[0].command.endsWith('/scripts/agent-message-hook.js"'))errors.push(`${event}: bounded request-ID notification hook missing`);
}

for (const path of walkFiles(join(root, "codex", "codebrief-capture"))) {
  if (readFileSync(path, "utf8").includes("CLAUDE_PLUGIN_ROOT")) {
    errors.push(`Codex package contains Claude-only root variable: ${path.slice(root.length + 1)}`);
  }
}

if (errors.length) {
  console.error("Codebrief Capture package validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Codebrief Capture package validation passed (${packageJson.version})`);
