import { resolveRepo as realResolveRepo } from "./repo.js";
import { isRepoEnabled as realIsEnabled, loadConfig as realLoadConfig } from "./config.js";
import { loadCreds as realLoadCreds } from "./credentials.js";
import { postIntent as realPostIntent, IngestError } from "./http.js";
import { preScrubMetadata, preScrubRecords } from "./scrub.js";

/**
 * Host-neutral capture orchestration. The host adapter supplies its distiller and
 * availability probe; security-sensitive repo/auth/scrub/ingest behavior stays shared.
 */
export async function runCaptureCore({ input = {}, distiller, deps = {} }) {
  const d = {
    resolveRepo: realResolveRepo,
    isRepoEnabled: realIsEnabled,
    loadConfig: realLoadConfig,
    loadCreds: realLoadCreds,
    postIntent: realPostIntent,
    distill: distiller.distill,
    isDistillerAvailable: distiller.isAvailable,
    ...deps,
  };

  try {
    const repo = d.resolveRepo(input.cwd);
    if (!repo) return { status: "skipped:not-a-repo" };
    if (!d.isRepoEnabled(repo.fullName)) return { status: "skipped:not-enabled" };

    const creds = d.loadCreds();
    if (!creds?.apiKey) {
      console.error("[codebrief] not logged in - run the Codebrief login skill");
      return { status: "skipped:no-auth" };
    }

    const cfg = d.loadConfig();
    const fallbackSourceRef = preScrubMetadata(input.session_id, 200) ?? "unknown";
    const raw = await d.distill({
      transcriptPath: input.transcript_path,
      fullName: repo.fullName,
      commitSha: repo.commitSha,
      sessionId: input.session_id,
      ...distiller.optionsFromConfig(cfg),
    });
    const records = preScrubRecords(raw).map((record) => ({
      ...record,
      commitSha: repo.commitSha,
      sourceType: record.sourceType ?? "session",
      sourceRef: record.sourceRef ?? fallbackSourceRef,
    }));

    if (records.length === 0) {
      if ((raw?.length ?? 0) === 0 && !d.isDistillerAvailable()) {
        console.error(distiller.unavailableMessage);
        return { status: distiller.unavailableStatus };
      }
      return { status: "skipped:no-intent" };
    }

    try {
      const report = await d.postIntent({
        apiBaseUrl: cfg.apiBaseUrl,
        apiKey: creds.apiKey,
        repoFullName: repo.fullName,
        records,
      });
      return { status: "sent", report };
    } catch (error) {
      if (error instanceof IngestError && error.status === 401) {
        console.error("[codebrief] CLI key rejected (invalid/revoked/expired) - create a new key in Settings > Connected CLIs, then run the Codebrief login skill");
        return { status: "error:auth" };
      }
      if (error instanceof IngestError && error.status === 403) {
        console.error(`[codebrief] ${repo.fullName} is not connected to your Codebrief workspace (or the key lacks intent:write)`);
        return { status: "error:repo" };
      }
      throw error;
    }
  } catch (error) {
    // Never log exception text: it can contain untrusted transcript or provider output.
    console.error(`[codebrief] capture error (${error instanceof Error ? error.name : "unknown"})`);
    return { status: "error" };
  }
}
