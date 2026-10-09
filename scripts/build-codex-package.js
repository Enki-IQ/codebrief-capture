import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "scripts", "lib");
const targetRoot = join(packageRoot, "codex", "codebrief-capture", "scripts", "lib");
const sharedFiles = [
  "agent-inbox.js",
  "room-tools.js",
  "room-discussion.js",
  "connected-agent-state.js",
  "connected-agent-client.js",
  "native-agent-runtime.js",
  "conductor-bootstrap.js",
  "release-installation.js",
  "tandem-state.js",
  "tandem-scope.js",
  "tandem-checkpoint.js",
  "tandem-client.js",
  "api-url.js",
  "active-project-client.js",
  "browser-login.js",
  "capture.js",
  "capture-state.js",
  "command-trigger.js",
  "config.js",
  "credentials.js",
  "http.js",
  "hook-input.js",
  "handoff-result.js",
  "handoff-state.js",
  "login-mode.js",
  "model-complete.js",
  "preflight.js",
  "read-key.js",
  "repo.js",
  "scrub.js",
];

const checkOnly = process.argv.includes("--check");
const stale = [];
const generatedFiles = [
  ...sharedFiles.map((filename) => ({
    source: join(sourceRoot, filename),
    target: join(targetRoot, filename),
    label: filename,
  })),
  {
    source: join(packageRoot, "schemas", "active-project-result.schema.json"),
    target: join(
      packageRoot,
      "codex",
      "codebrief-capture",
      "schemas",
      "active-project-result.schema.json",
    ),
    label: "active-project-result.schema.json",
  },
];

for (const { source, target, label } of generatedFiles) {
  if (!checkOnly) mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
  if (checkOnly) {
    try {
      if (!readFileSync(source).equals(readFileSync(target))) stale.push(label);
    } catch {
      stale.push(label);
    }
  } else {
    copyFileSync(source, target);
  }
}

if (stale.length) {
  console.error(`Codex package shared files are stale: ${stale.join(", ")}`);
  console.error("Run: node scripts/build-codex-package.js");
  process.exit(1);
}
