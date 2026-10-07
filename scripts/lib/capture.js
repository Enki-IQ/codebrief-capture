import { resolveRepo as realResolveRepo } from "./repo.js";
import { isRepoEnabled as realIsEnabled, loadConfig as realLoadConfig } from "./config.js";
import { loadCreds as realLoadCreds } from "./credentials.js";
import { postIntent as realPostIntent, IngestError } from "./http.js";
import { normalizeSourceRef, preScrubRecords } from "./scrub.js";
import { randomUUID } from "node:crypto";

/**
 * Host-neutral capture orchestration. The host adapter supplies its distiller and
 * availability probe; security-sensitive repo/auth/scrub/ingest behavior stays shared.
 */
export async function runCaptureCore({ input = {}, distiller, captureHost = "unknown", deps = {} }) {
  const d = {
    resolveRepo: realResolveRepo,
    isRepoEnabled: realIsEnabled,
    loadConfig: realLoadConfig,
    loadCreds: realLoadCreds,
    postIntent: realPostIntent,
    distill: distiller.distill,
    isDistillerAvailable: distiller.isAvailable,
    createCaptureId: () => `capture-${randomUUID()}`,
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
    // A rolling adapter-issued capture id is authoritative. Provider session ids and model
    // output are provenance inputs, never allowed to split one rolling capture into new Sessions.
    const captureSourceRef = normalizeSourceRef(input.capture_id)
      ?? normalizeSourceRef(input.session_id)
      ?? d.createCaptureId();
    const raw = input.capture_metadata_only ? [] : await d.distill({
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
      sourceRef: captureSourceRef,
    }));

    if (records.length === 0) {
      if (!input.capture_metadata_only && (raw?.length ?? 0) === 0 && !d.isDistillerAvailable()) {
        console.error(distiller.unavailableMessage);
        return { status: distiller.unavailableStatus };
      }
      // Completion is durable metadata even when this fingerprint introduced no new intent.
      if (input.capture_state !== "complete") return { status: "skipped:no-intent" };
    }

    try {
      const report = await d.postIntent({
        apiBaseUrl: cfg.apiBaseUrl,
        apiKey: creds.apiKey,
        repoFullName: repo.fullName,
        records,
        capture: {
          version: 1,
          sourceRef: captureSourceRef,
          host: captureHost,
          state: input.capture_state === "in_progress" || input.capture_state === "complete"
            ? input.capture_state
            : "unknown",
        },
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
