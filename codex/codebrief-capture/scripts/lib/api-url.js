export const CODEBRIEF_API_BASE_URL = "https://app.codebrief.ai";

function localhostAllowed(explicit) {
  return explicit ?? process.env.CODEBRIEF_ALLOW_LOCAL_API === "1";
}

/** Allow only production Codebrief, or an explicitly enabled loopback development server. */
export function normalizeCodebriefApiBaseUrl(value, { allowLocalhost } = {}) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("invalid Codebrief API URL"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/"].includes(parsed.pathname)) {
    throw new TypeError("invalid Codebrief API origin");
  }
  if (parsed.origin === CODEBRIEF_API_BASE_URL) return CODEBRIEF_API_BASE_URL;
  const localHost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  const port = Number(parsed.port);
  if (localhostAllowed(allowLocalhost) && parsed.protocol === "http:" && localHost
      && Number.isInteger(port) && port >= 1 && port <= 65_535) {
    const host = parsed.hostname === "localhost" ? "localhost" : "127.0.0.1";
    return `http://${host}:${port}`;
  }
  throw new TypeError("untrusted Codebrief API origin");
}

const API_PATHS = new Set(["/cli/authorize", "/api/cli/exchange", "/api/intent/ingest"]);

export function codebriefApiUrl(apiBaseUrl, path) {
  if (!API_PATHS.has(path)) throw new TypeError("unsupported Codebrief API path");
  return `${normalizeCodebriefApiBaseUrl(apiBaseUrl)}${path}`;
}

/** Rebuild the browser target from validated scalar fields before passing it to an OS command. */
export function normalizeAuthorizeUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError("invalid authorize URL"); }
  const apiBaseUrl = normalizeCodebriefApiBaseUrl(parsed.origin);
  const callbackPort = Number(parsed.searchParams.get("port"));
  const state = parsed.searchParams.get("state") ?? "";
  const keys = [...parsed.searchParams.keys()].sort().join(",");
  if (parsed.pathname !== "/cli/authorize" || keys !== "port,state"
      || !Number.isInteger(callbackPort) || callbackPort < 1_024 || callbackPort > 65_535
      || !/^[0-9a-f]{32}$/.test(state)) {
    throw new TypeError("invalid authorize URL parameters");
  }
  return `${apiBaseUrl}/cli/authorize?port=${callbackPort}&state=${state}`;
}
