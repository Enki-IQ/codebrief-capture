import { test } from "node:test";
import assert from "node:assert";
import { genState, buildAuthorizeUrl, parseCallback, exchangeCode } from "./browser-login.js";

test("genState returns a long random hex string", () => {
  const a = genState(), b = genState();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});
test("buildAuthorizeUrl carries port + state", () => {
  assert.equal(buildAuthorizeUrl("https://app.x", 49152, "abc"), "https://app.x/cli/authorize?port=49152&state=abc");
});
test("parseCallback extracts code + state from the loopback request URL", () => {
  assert.deepEqual(parseCallback("/callback?code=C1&state=S1"), { code: "C1", state: "S1" });
  assert.deepEqual(parseCallback("/favicon.ico"), { code: null, state: null });
});
test("exchangeCode posts the code and returns the secret as apiKey", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => { seen = { url, body: JSON.parse(opts.body) }; return { ok: true, json: async () => ({ secret: "ak_x" }) }; };
  const out = await exchangeCode({ apiBaseUrl: "https://app.x", code: "C1", fetchImpl });
  assert.equal(out.apiKey, "ak_x");
  assert.equal(seen.url, "https://app.x/api/cli/exchange");
  assert.deepEqual(seen.body, { code: "C1" });
});
test("exchangeCode throws on a non-2xx response", async () => {
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid or expired code" }) });
  await assert.rejects(() => exchangeCode({ apiBaseUrl: "https://app.x", code: "bad", fetchImpl }));
});
