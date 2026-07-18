import { test } from "node:test";
import assert from "node:assert";
import { get } from "node:http";
import { genState, buildAuthorizeUrl, parseCallback, exchangeCode, openBrowser, runLoopbackLogin } from "./browser-login.js";

test("genState returns a long random hex string", () => {
  const a = genState(), b = genState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
test("buildAuthorizeUrl carries port + state", () => {
  const state = "a".repeat(32);
  assert.equal(buildAuthorizeUrl("https://app.codebrief.ai", 49152, state), `https://app.codebrief.ai/cli/authorize?port=49152&state=${state}`);
  assert.throws(() => buildAuthorizeUrl("https://app.x", 49152, state));
});
test("openBrowser validates and reconstructs the URL before spawning", () => {
  const safe = `https://app.codebrief.ai/cli/authorize?port=49152&state=${"a".repeat(32)}`;
  let seen = null;
  openBrowser(safe, (command, args, options) => {
    seen = { command, args, options };
    return { unref() {} };
  });
  assert.ok(seen.args.includes(safe));
  assert.equal(seen.options.detached, true);
  assert.throws(() => openBrowser(
    `https://app.x/cli/authorize?port=49152&state=${"a".repeat(32)}`,
    () => assert.fail("spawn must not run for an untrusted URL"),
  ));
});
test("openBrowser quotes the complete authorize URL for Windows start", () => {
  const safe = `https://app.codebrief.ai/cli/authorize?port=49152&state=${"a".repeat(32)}`;
  let seen = null;
  openBrowser(safe, (command, args) => {
    seen = { command, args };
    return { unref() {} };
  }, "win32");
  assert.equal(seen.command, "cmd.exe");
  assert.deepEqual(seen.args, ["/d", "/s", "/c", `start "" "${safe}"`]);
});
test("parseCallback extracts code + state from the loopback request URL", () => {
  assert.deepEqual(parseCallback("/callback?code=C1&state=S1"), { code: "C1", state: "S1" });
  assert.deepEqual(parseCallback("/favicon.ico"), { code: null, state: null });
});
test("exchangeCode posts the code and returns the secret as apiKey", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ secret: "ak_x" }) }; };
  const out = await exchangeCode({ apiBaseUrl: "https://app.codebrief.ai", code: "C1", fetchImpl });
  assert.equal(out.apiKey, "ak_x");
  assert.equal(seen.url, "https://app.codebrief.ai/api/cli/exchange");
  assert.deepEqual(seen.body, { code: "C1" });
});
test("exchangeCode throws on a non-2xx response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid or expired code" }) });
  await assert.rejects(() => exchangeCode({ apiBaseUrl: "https://app.codebrief.ai", code: "bad", fetchImpl }));
});

test("the loopback timeout remains active while the code exchange is pending", async () => {
  const open = (authorizeUrl) => {
    const url = new URL(authorizeUrl);
    const request = get({
      hostname: "127.0.0.1",
      port: url.searchParams.get("port"),
      path: `/callback?code=C1&state=${url.searchParams.get("state")}`,
    }, (response) => response.resume());
    request.on("error", () => {});
  };
  await assert.rejects(() => runLoopbackLogin({
    apiBaseUrl: "https://app.codebrief.ai",
    timeoutMs: 50,
    open,
    exchange: async () => new Promise(() => {}),
  }), /login timed out/);
});
