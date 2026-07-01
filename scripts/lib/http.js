/** Carries the HTTP status so the caller can distinguish 401 (dead key) from 403 (repo not connected). */
export class IngestError extends Error {
  constructor(status, body) {
    super(`ingest failed: ${status}`);
    this.name = "IngestError";
    this.status = status;
    this.body = body;
  }
}

/** POST a scrubbed intent batch authenticated by the Clerk API key. No refresh — Clerk keys don't rotate. */
export async function postIntent({ apiBaseUrl, apiKey, repoFullName, records, fetchImpl = fetch, timeoutMs = 10_000 }) {
  // Bound the request so a network hang can't stall session-end indefinitely.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${apiBaseUrl}/api/intent/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ repo: { fullName: repoFullName }, records }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new IngestError(res.status, body);
    }
    return res.json(); // { accepted, dropped }
  } finally {
    clearTimeout(timer);
  }
}
