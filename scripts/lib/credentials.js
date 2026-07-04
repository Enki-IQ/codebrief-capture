import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";

const SERVICE = "codebrief-capture";
const ACCOUNT = "default";

/** 0600 JSON file store (cross-platform fallback). */
export class FileStore {
  constructor(path = join(homedir(), ".codebrief", "credentials.json")) { this.path = path; }
  load() { try { return JSON.parse(readFileSync(this.path, "utf8")); } catch { return null; } }
  save(creds) {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(creds), { mode: 0o600 });
    chmodSync(this.path, 0o600); // `mode` only applies to NEW files; enforce 0600 on a pre-existing one too
  }
  clear() { try { rmSync(this.path); } catch { /* already gone */ } }
}

/** macOS Keychain store via the `security` CLI (no native dep). */
class MacKeychainStore {
  load() {
    try { return JSON.parse(execFileSync("security", ["find-generic-password", "-s", SERVICE, "-a", ACCOUNT, "-w"], { encoding: "utf8" }).trim()); }
    catch { return null; }
  }
  save(creds) {
    const secret = JSON.stringify(creds);
    // Pass the secret on STDIN (security prompts: password + retype), never argv, so it can't be seen
    // in the process table. `-w` must be the LAST option to trigger the prompt that reads stdin.
    execFileSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", ACCOUNT, "-w"], { input: `${secret}\n${secret}\n` });
  }
  clear() { try { execFileSync("security", ["delete-generic-password", "-s", SERVICE, "-a", ACCOUNT]); } catch { /* gone */ } }
}

/** Pick the best available store: macOS keychain, else 0600 file (spec spike #2). */
export function getStore() {
  if (process.platform === "darwin") { try { execFileSync("security", ["-h"], { stdio: "ignore" }); return new MacKeychainStore(); } catch { /* fall through */ } }
  return new FileStore();
}

export function loadCreds() { return getStore().load(); }
export function saveCreds(c) { getStore().save(c); }
export function clearCreds() { getStore().clear(); }
