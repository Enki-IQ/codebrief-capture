import { resolveRepo as realResolveRepo } from "./lib/repo.js";
import { isRepoEnabled as realIsEnabled, loadConfig as realLoadConfig } from "./lib/config.js";
import { loadCreds as realLoadCreds } from "./lib/credentials.js";
import { distill as realDistill } from "./lib/distill.js";
import { postIntent as realPostIntent, IngestError } from "./lib/http.js";
import { preScrubRecords } from "./lib/scrub.js";
import { isClaudeAvailable as realIsClaudeAvailable } from "./lib/preflight.js";

/** Pure-ish orchestrator with injectable deps for testing. Returns a status object (never throws). */
export async function runCapture({ input, deps = {} }) {
  const d = {
    resolveRepo: realResolveRepo, isRepoEnabled: realIsEnabled, loadConfig: realLoadConfig,
    loadCreds: realLoadCreds, distill: realDistill, postIntent: realPostIntent,
    isClaudeAvailable: realIsClaudeAvailable, ...deps,
  };
  try {
    const repo = d.resolveRepo(input.cwd);
    if (!repo) return { status: "skipped:not-a-repo" };
    if (!d.isRepoEnabled(repo.fullName)) return { status: "skipped:not-enabled" };
    const creds = d.loadCreds();
    if (!creds?.apiKey) { console.error("[codebrief] not logged in — run /codebrief:login"); return { status: "skipped:no-auth" }; }
    const cfg = d.loadConfig();
    const raw = d.distill({ transcriptPath: input.transcript_path, fullName: repo.fullName, commitSha: repo.commitSha, sessionId: input.session_id, model: cfg.distillModel });
    const records = preScrubRecords(raw).map((r) => ({ ...r, commitSha: repo.commitSha, sourceType: r.sourceType ?? "session", sourceRef: r.sourceRef ?? input.session_id }));
    if (records.length === 0) {
      if ((raw?.length ?? 0) === 0 && !d.isClaudeAvailable()) {
        console.error("[codebrief] `claude` CLI not found on PATH — cannot distill intent. Install Claude Code or add it to PATH.");
        return { status: "skipped:no-claude" };
      }
      return { status: "skipped:no-intent" };
    }
    try {
      const report = await d.postIntent({ apiBaseUrl: cfg.apiBaseUrl, apiKey: creds.apiKey, repoFullName: repo.fullName, records });
      return { status: "sent", report };
    } catch (e) {
      if (e instanceof IngestError && e.status === 401) {
        console.error("[codebrief] CLI key rejected (invalid/revoked/expired) — create a new key in Settings → Connected CLIs, then run /codebrief:login");
        return { status: "error:auth" };
      }
      if (e instanceof IngestError && e.status === 403) {
        console.error(`[codebrief] ${repo.fullName} isn't connected to your Codebrief workspace (or the key lacks intent:write)`);
        return { status: "error:repo" };
      }
      throw e;
    }
  } catch (e) {
    // Redact: never log raw exception text (may carry untrusted/sensitive content) — error name only.
    console.error(`[codebrief] capture error (${e instanceof Error ? e.name : "unknown"})`);
    return { status: "error" };
  }
}

// Entrypoint: read the hook JSON from stdin, run, exit 0 regardless (never block session end).
if (import.meta.url === `file://${process.argv[1]}`) {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", async () => {
    let input = {};
    try { input = JSON.parse(buf); } catch { /* no input */ }
    const out = await runCapture({ input });
    if (process.env.CODEBRIEF_DEBUG) console.error(`[codebrief] ${out.status}`);
    process.exit(0);
  });
}
