import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { codebriefApiUrl, normalizeAuthorizeUrl } from "./api-url.js";

export function genState() { return randomBytes(16).toString("hex"); }
export function buildAuthorizeUrl(apiBaseUrl, port, state) {
  const url = new URL(codebriefApiUrl(apiBaseUrl, "/cli/authorize"));
  url.searchParams.set("port", String(port));
  url.searchParams.set("state", state);
  return normalizeAuthorizeUrl(url.toString());
}
export function parseCallback(reqUrl) {
  const u = new URL(reqUrl, "http://127.0.0.1");
  if (u.pathname !== "/callback") return { code: null, state: null };
  return { code: u.searchParams.get("code"), state: u.searchParams.get("state") };
}
export async function exchangeCode({ apiBaseUrl, code, fetchImpl = fetch }) {
  if (typeof code !== "string" || !code || code.length > 4_096 || /[\u0000-\u001f\u007f]/.test(code)) {
    throw new TypeError("invalid authorization code");
  }
  const res = await fetchImpl(codebriefApiUrl(apiBaseUrl, "/api/cli/exchange"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error(`exchange failed: ${res.status}`);
  const { secret } = await res.json();
  if (!secret) throw new Error("exchange returned no secret");
  return { apiKey: secret };
}

/**
 * Branded landing the browser shows after the loopback callback. Served from 127.0.0.1 (a different
 * origin than the app), so it is fully self-contained: brand colors/fonts are inlined from the
 * Editorial Brief tokens, the logo is inline SVG, and the Newsreader webfont degrades to a serif
 * fallback if it can't load (offline). `ok` toggles the connected vs failed copy.
 */
export function resultPageHtml(ok) {
  const heading = ok ? "Connected" : "Authorization failed";
  const detail = ok
    ? "This device is now linked to Codebrief. Return to your editor — you can close this tab."
    : "Something went wrong linking this device. Re-run <code>/codebrief:login</code> from your editor.";
  const accent = ok ? "#2b50c8" : "#c0362c";
  const statusLabel = ok ? "Device authorized" : "Not authorized";
  const statusColor = ok ? "#18794e" : "#c0362c";
  const statusBg = ok ? "#e8f3ec" : "#fbeae7";
  const statusBorder = ok ? "#cde7d6" : "#f6cfc8";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${heading} — Codebrief</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Newsreader:opsz,wght@6..72,400;6..72,500;6..72,600&family=Hanken+Grotesk:wght@400;500;600&display=swap" rel="stylesheet" />
<style>
  :root {
    --paper: #fbfaf8; --card: #ffffff; --border: #e4e0d6;
    --ink: #1c1a16; --ink-2: #4d483f; --ink-3: #6b655a;
    --serif: 'Newsreader', Georgia, 'Times New Roman', serif;
    --sans: 'Hanken Grotesk', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; display: grid; place-items: center; padding: 24px;
    font-family: var(--sans); color: var(--ink); background: var(--paper);
    -webkit-font-smoothing: antialiased;
  }
  .card {
    width: 100%; max-width: 420px; padding: 40px 32px 32px; text-align: center;
    background: var(--card); border: 1px solid var(--border); border-radius: 14px;
    box-shadow: 0 12px 28px -6px rgba(28,26,22,.12), 0 4px 10px -4px rgba(28,26,22,.07);
    animation: rise .32s cubic-bezier(.22,1,.36,1) both;
  }
  @keyframes rise { from { transform: translateY(10px); opacity: 0; } to { transform: none; opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .card { animation: none; } }
  .mark { width: 48px; height: 48px; display: block; margin: 0 auto 20px; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase;
    color: ${statusColor}; background: ${statusBg}; border: 1px solid ${statusBorder};
    border-radius: 999px; padding: 4px 10px; margin-bottom: 14px;
  }
  .badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  h1 {
    font-family: var(--serif); font-weight: 500; font-size: 28px; letter-spacing: -.02em;
    line-height: 1.3; margin: 0 0 10px;
  }
  p { font-size: 15px; line-height: 1.65; color: var(--ink-2); margin: 0 auto; max-width: 34ch; }
  code {
    font-family: var(--mono); font-size: .9em; background: #f5f3ee;
    padding: 1px 6px; border-radius: 4px; color: var(--ink-2);
  }
  .accent { height: 3px; width: 40px; margin: 22px auto 0; border-radius: 999px; background: ${accent}; opacity: .85; }
</style>
</head>
<body>
  <main class="card">
    <svg class="mark" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Codebrief">
      <rect width="64" height="64" rx="15" fill="#2b50c8"></rect>
      <path d="M27 19H21C19.8954 19 19 19.8954 19 21V43C19 44.1046 19.8954 45 21 45H27" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"></path>
      <path d="M37 19H43C44.1046 19 45 19.8954 45 21V43C45 44.1046 44.1046 45 43 45H37" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"></path>
      <circle cx="32" cy="32" r="4" fill="#d9ac4f"></circle>
    </svg>
    <span class="badge"><span class="dot"></span>${statusLabel}</span>
    <h1>${heading}</h1>
    <p>${detail}</p>
    <div class="accent"></div>
  </main>
</body>
</html>`;
}

/** Open the default browser to `url` without blocking (platform-aware). */
export function openBrowser(url, spawnImpl = spawn, platform = process.platform) {
  const safeUrl = normalizeAuthorizeUrl(url);
  const [cmd, args] = platform === "darwin" ? ["open", [safeUrl]]
    : platform === "win32" ? ["cmd.exe", ["/d", "/s", "/c", `start "" "${safeUrl}"`]]
    : ["xdg-open", [safeUrl]];
  const child = spawnImpl(cmd, args, { stdio: "ignore", detached: true });
  if (child && typeof child.unref === "function") child.unref();
}

/**
 * Full loopback login: bind 127.0.0.1:<ephemeral>, open the browser to the authorize page, await the
 * single callback, verify `state`, exchange the code for a key. Returns { apiKey }. Rejects on
 * timeout / state mismatch / exchange failure. The loopback closes after one request either way.
 */
export function runLoopbackLogin({ apiBaseUrl, timeoutMs = 300_000, open = openBrowser, exchange = exchangeCode }) {
  return new Promise((resolve, reject) => {
    const state = genState();
    let settled = false;
    let callbackReceived = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error); else resolve(value);
    };
    const server = http.createServer(async (req, res) => {
      const { code, state: got } = parseCallback(req.url);
      const ok = code && got === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/html; charset=utf-8" });
      res.end(resultPageHtml(ok));
      if (callbackReceived || settled) return;
      callbackReceived = true;
      if (!ok) return finish(new Error("state mismatch or missing code"));
      server.close();
      try { finish(null, await exchange({ apiBaseUrl, code })); } catch (e) { finish(e); }
    });
    const timer = setTimeout(() => finish(new Error("login timed out")), timeoutMs);
    server.on("error", (error) => finish(error));
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      try { open(buildAuthorizeUrl(apiBaseUrl, port, state)); } catch (error) { finish(error); }
    });
  });
}
