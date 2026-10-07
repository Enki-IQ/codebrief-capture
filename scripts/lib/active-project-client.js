import { normalizeCodebriefApiBaseUrl } from "./api-url.js";
import { validateHandoffResult } from "./handoff-result.js";

const WORK_PATHS = new Set([
  "/api/capture/active-project/list",
  "/api/capture/active-project/claim",
  "/api/capture/active-project/renew",
  "/api/capture/active-project/cancel",
  "/api/capture/active-project/result",
]);
const REPO_PART = /^[A-Za-z0-9_.-]+$/;
const MAX_RESPONSE_BYTES = 256 * 1024;

export class WorkClientError extends Error {
  constructor(status, message = statusMessage(status)) {
    super(message);
    this.name = "WorkClientError";
    this.status = status;
  }
}

function statusMessage(status) {
  if (status === 401) {
    return "Codebrief work request failed (401). Run codebrief-cli login to reauthorize.";
  }
  if (status === 403) {
    return "Codebrief work request failed (403). Reauthorize Capture with Active Project access.";
  }
  if (status === 404) return "Codebrief work not found (404).";
  if (status === 409) return "Codebrief work claim conflicted (409). Refresh the work list.";
  if (status === 410) return "Codebrief work claim expired (410). Refresh the work list.";
  if (status === 0) return "Codebrief work request could not reach the service.";
  return `Codebrief work request failed (${Number.isInteger(status) ? status : "unknown"}).`;
}

function repoFullName(value) {
  if (typeof value !== "string") throw new TypeError("invalid GitHub repository");
  const parts = value.split("/");
  if (parts.length !== 2 || parts.some((part) => !REPO_PART.test(part))) {
    throw new TypeError("invalid GitHub repository");
  }
  return value;
}

function workUrl(apiBaseUrl, path) {
  if (!WORK_PATHS.has(path)) throw new TypeError("unsupported work API path");
  return `${normalizeCodebriefApiBaseUrl(apiBaseUrl)}${path}`;
}

function declaredContentLength(response) {
  const raw = response.headers?.get?.("content-length");
  const encoding = response.headers?.get?.("content-encoding");
  if (
    typeof raw !== "string"
    || !/^(?:0|[1-9]\d*)$/.test(raw)
    || (encoding && encoding.toLowerCase() !== "identity")
  ) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

function cancelBestEffort(cancel) {
  try {
    const pending = cancel?.();
    pending?.catch?.(() => {});
  } catch {
    // Cancellation is advisory; the hard deadline does not wait for it.
  }
}

async function boundedResponseText(response, registerBodyCancel) {
  const declared = declaredContentLength(response);
  if (declared !== null && declared > MAX_RESPONSE_BYTES) {
    cancelBestEffort(() => response.body?.cancel?.());
    throw new WorkClientError(502);
  }
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    registerBodyCancel(() => cancelBestEffort(() => reader.cancel()));
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "";
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array)) throw new WorkClientError(502);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          cancelBestEffort(() => reader.cancel());
          throw new WorkClientError(502);
        }
        raw += decoder.decode(value, { stream: true });
      }
      raw += decoder.decode();
      if (declared !== null && bytes !== declared) throw new WorkClientError(502);
      return raw;
    } finally {
      registerBodyCancel(null);
      try { reader.releaseLock(); } catch { /* already detached */ }
    }
  }
  if (typeof response.text === "function") {
    // Without a stream Node cannot prevent a custom adapter from allocating inside
    // text(). Require an exact, uncompressed Content-Length and fail closed otherwise.
    if (declared === null || declared > MAX_RESPONSE_BYTES) throw new WorkClientError(502);
    try {
      const raw = await response.text();
      if (
        typeof raw !== "string"
        || Buffer.byteLength(raw, "utf8") !== declared
      ) {
        throw new WorkClientError(502);
      }
      return raw;
    } catch (error) {
      if (error instanceof WorkClientError) throw error;
      throw new WorkClientError(0);
    }
  }
  throw new WorkClientError(502);
}

async function successJson(response, registerBodyCancel) {
  let value;
  try {
    value = JSON.parse(await boundedResponseText(response, registerBodyCancel));
  } catch (error) {
    if (error instanceof WorkClientError) throw error;
    throw new WorkClientError(502);
  }
  if (!value || typeof value !== "object") throw new WorkClientError(502);
  return value;
}

async function postJson({
  path,
  apiBaseUrl,
  apiKey,
  body,
  fetchImpl,
  timeoutMs = 10_000,
}) {
  if (typeof apiKey !== "string" || !apiKey) throw new WorkClientError(401);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("invalid work request timeout");
  }
  const controller = new AbortController();
  let bodyCancel = null;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      cancelBestEffort(bodyCancel);
      reject(new WorkClientError(0));
    }, timeoutMs);
  });
  const beforeDeadline = (operation) => Promise.race([Promise.resolve(operation), deadline]);
  try {
    let response;
    try {
      response = await beforeDeadline(Promise.resolve().then(() => fetchImpl(
        workUrl(apiBaseUrl, path),
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      )));
    } catch (error) {
      if (error instanceof WorkClientError) throw error;
      throw new WorkClientError(0);
    }
    if (!response?.ok) throw new WorkClientError(response?.status);
    try {
      return await beforeDeadline(successJson(response, (cancel) => {
        bodyCancel = cancel;
      }));
    } catch (error) {
      if (error instanceof WorkClientError) throw error;
      throw new WorkClientError(0);
    }
  } finally {
    clearTimeout(timer);
    bodyCancel = null;
  }
}

function commonBody(repo) {
  return { repo: { fullName: repoFullName(repo) } };
}

function unwrapWork(response, expectsList) {
  const work = response?.work;
  if (
    expectsList
      ? !Array.isArray(work)
      : !work || typeof work !== "object" || Array.isArray(work)
  ) {
    throw new WorkClientError(502);
  }
  return work;
}

export async function listWork({
  apiBaseUrl,
  apiKey,
  repoFullName: repo,
  fetchImpl = fetch,
  timeoutMs,
}) {
  const response = await postJson({
    path: "/api/capture/active-project/list",
    apiBaseUrl,
    apiKey,
    body: commonBody(repo),
    fetchImpl,
    timeoutMs,
  });
  return unwrapWork(response, true);
}

export async function claimWork({
  apiBaseUrl,
  apiKey,
  repoFullName: repo,
  actionId,
  locator,
  host,
  fetchImpl = fetch,
  timeoutMs,
}) {
  if ((typeof actionId === "string") === (typeof locator === "string")) {
    throw new TypeError("claim requires exactly one selector");
  }
  if (host !== "codex" && host !== "claude") throw new TypeError("invalid work host");
  const selector = actionId === undefined
    ? { locator: locator.trim() }
    : { actionId: actionId.trim() };
  if (!Object.values(selector)[0] || Object.values(selector)[0].length > 256) {
    throw new TypeError("invalid work selector");
  }
  const response = await postJson({
    path: "/api/capture/active-project/claim",
    apiBaseUrl,
    apiKey,
    body: { ...commonBody(repo), ...selector, host },
    fetchImpl,
    timeoutMs,
  });
  return unwrapWork(response, false);
}

function handoffBody(repo, handoffId) {
  if (typeof handoffId !== "string" || !handoffId || handoffId.length > 128) {
    throw new TypeError("invalid handoffId");
  }
  return { ...commonBody(repo), handoffId };
}

export async function renewWork({
  apiBaseUrl,
  apiKey,
  repoFullName: repo,
  handoffId,
  fetchImpl = fetch,
  timeoutMs,
}) {
  return postJson({
    path: "/api/capture/active-project/renew",
    apiBaseUrl,
    apiKey,
    body: handoffBody(repo, handoffId),
    fetchImpl,
    timeoutMs,
  });
}

export async function cancelWork({
  apiBaseUrl,
  apiKey,
  repoFullName: repo,
  handoffId,
  fetchImpl = fetch,
  timeoutMs,
}) {
  return postJson({
    path: "/api/capture/active-project/cancel",
    apiBaseUrl,
    apiKey,
    body: handoffBody(repo, handoffId),
    fetchImpl,
    timeoutMs,
  });
}

export async function returnWorkResult({
  apiBaseUrl,
  apiKey,
  repoFullName: repo,
  handoffId,
  result,
  fetchImpl = fetch,
  timeoutMs,
}) {
  return postJson({
    path: "/api/capture/active-project/result",
    apiBaseUrl,
    apiKey,
    body: { ...handoffBody(repo, handoffId), result: validateHandoffResult(result) },
    fetchImpl,
    timeoutMs,
  });
}
