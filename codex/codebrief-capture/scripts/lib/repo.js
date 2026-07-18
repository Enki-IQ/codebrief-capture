import { execFileSync } from "node:child_process";

const GITHUB_HOST = "github.com";
const REPO_PART = /^[A-Za-z0-9_.-]+$/;

function repoIdentity(pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].endsWith(".git") ? parts[1].slice(0, -4) : parts[1];
  return owner && name && REPO_PART.test(owner) && REPO_PART.test(name) ? `${owner}/${name}` : null;
}

/** Normalize a github.com remote URL to "owner/name" (or null). */
export function normalizeRemote(url) {
  if (typeof url !== "string") return null;
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) return scp[1].toLowerCase() === GITHUB_HOST ? repoIdentity(scp[2]) : null;
  try {
    const parsed = new URL(url);
    if (!["https:", "ssh:"].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== GITHUB_HOST
        || parsed.password || parsed.search || parsed.hash) return null;
    return repoIdentity(parsed.pathname);
  } catch { return null; }
}

/** Resolve the connected repo identity for a working dir, or null if not a git repo. */
export function resolveRepo(cwd) {
  try {
    const remote = execFileSync("git", ["-C", cwd, "remote", "get-url", "origin"], { encoding: "utf8" }).trim();
    const fullName = normalizeRemote(remote);
    if (!fullName) return null;
    const commitSha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    return { fullName, commitSha };
  } catch { return null; }
}
