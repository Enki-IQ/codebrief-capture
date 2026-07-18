import { test } from "node:test";
import assert from "node:assert";
import { CODEBRIEF_API_BASE_URL, codebriefApiUrl, normalizeAuthorizeUrl, normalizeCodebriefApiBaseUrl } from "./api-url.js";

test("allows only the production Codebrief origin by default", () => {
  assert.equal(normalizeCodebriefApiBaseUrl("https://app.codebrief.ai/"), CODEBRIEF_API_BASE_URL);
  assert.throws(() => normalizeCodebriefApiBaseUrl("https://app.x"));
  assert.throws(() => normalizeCodebriefApiBaseUrl("https://app.codebrief.ai@app.x"));
  assert.throws(() => normalizeCodebriefApiBaseUrl("https://app.codebrief.ai/unexpected"));
});

test("allows a reconstructed loopback origin only when explicitly enabled", () => {
  assert.throws(() => normalizeCodebriefApiBaseUrl("http://127.0.0.1:3000"));
  assert.equal(
    normalizeCodebriefApiBaseUrl("http://127.0.0.1:3000", { allowLocalhost: true }),
    "http://127.0.0.1:3000",
  );
  assert.throws(() => normalizeCodebriefApiBaseUrl("http://remote:3000", { allowLocalhost: true }));
});

test("constructs only known API paths and validates browser authorization parameters", () => {
  assert.equal(
    codebriefApiUrl(CODEBRIEF_API_BASE_URL, "/api/intent/ingest"),
    "https://app.codebrief.ai/api/intent/ingest",
  );
  assert.throws(() => codebriefApiUrl(CODEBRIEF_API_BASE_URL, "/arbitrary"));
  const safe = `https://app.codebrief.ai/cli/authorize?port=49152&state=${"a".repeat(32)}`;
  assert.equal(normalizeAuthorizeUrl(safe), safe);
  assert.throws(() => normalizeAuthorizeUrl("https://app.x/cli/authorize?port=49152&state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.throws(() => normalizeAuthorizeUrl("https://app.codebrief.ai/cli/authorize?port=49152&state=bad;open"));
});
