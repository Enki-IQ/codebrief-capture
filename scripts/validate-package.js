import { readFileSync, readdirSync, statSync } from "node:fs";
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

const skillsRoot = join(root, "codex", "codebrief-capture", "skills");
for (const name of readdirSync(skillsRoot)) {
  const path = join(skillsRoot, name, "SKILL.md");
  let text;
  try { text = readFileSync(path, "utf8"); } catch { errors.push(`${name} is missing SKILL.md`); continue; }
  if (!text.startsWith("---\n") || !/^name:\s*\S+/m.test(text) || !/^description:\s*\S+/m.test(text)) {
    errors.push(`${name}/SKILL.md has invalid frontmatter`);
  }
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
if (claudePostToolUse?.length !== 1 || claudePostHandlers.length !== 1
    || claudePostHandlers.some((handler) => "if" in handler)) {
  errors.push("Claude PostToolUse must have one in-process-filtered handler and no unsupported if field");
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
