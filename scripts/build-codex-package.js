import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = join(packageRoot, "scripts", "lib");
const targetRoot = join(packageRoot, "codex", "codebrief-capture", "scripts", "lib");
const sharedFiles = [
  "api-url.js",
  "browser-login.js",
  "capture.js",
  "command-trigger.js",
  "config.js",
  "credentials.js",
  "http.js",
  "login-mode.js",
  "preflight.js",
  "read-key.js",
  "repo.js",
  "scrub.js",
];

const checkOnly = process.argv.includes("--check");
const stale = [];

if (!checkOnly) mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
for (const filename of sharedFiles) {
  const source = join(sourceRoot, filename);
  const target = join(targetRoot, filename);
  if (checkOnly) {
    try {
      if (!readFileSync(source).equals(readFileSync(target))) stale.push(filename);
    } catch {
      stale.push(filename);
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
