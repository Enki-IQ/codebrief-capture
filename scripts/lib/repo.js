import { execFileSync } from "node:child_process";

/** Normalize a github remote URL to "owner/name" (or null). */
export function normalizeRemote(url) {
  if (typeof url !== "string") return null;
  let m = url.match(/^git@[^:]+:([^/]+)\/(.+?)(?:\.git)?$/);      // git@github.com:owner/name(.git)
  if (!m) m = url.match(/^(?:https?|ssh):\/\/[^/]+\/([^/]+)\/(.+?)(?:\.git)?$/); // http(s)/ssh URL
  return m ? `${m[1]}/${m[2]}` : null;
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
