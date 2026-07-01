import { test } from "node:test";
import assert from "node:assert";
import { postIntent, IngestError } from "./http.js";

test("postIntent posts the batch with a Bearer key and returns the report", async () => {
  let seen = null;
  const fetchImpl = async (url, opts) => {
    seen = { url, opts };
    return { status: 200, ok: true, json: async () => ({ accepted: 1, dropped: [] }) };
  };
  const out = await postIntent({
    apiBaseUrl: "http://x", apiKey: "ck_live_abc",
    repoFullName: "a/b", records: [{ kind: "decision" }], fetchImpl,
  });
  assert.equal(out.accepted, 1);
  assert.equal(seen.url, "http://x/api/intent/ingest");
  assert.equal(seen.opts.headers.authorization, "Bearer ck_live_abc");
  assert.deepEqual(JSON.parse(seen.opts.body), { repo: { fullName: "a/b" }, records: [{ kind: "decision" }] });
});

test("postIntent throws IngestError(401) when the key is invalid/revoked/expired", async () => {
  const fetchImpl = async () => ({ status: 401, ok: false, json: async () => ({ error: "unauthorized" }) });
  await assert.rejects(
    () => postIntent({ apiBaseUrl: "http://x", apiKey: "dead", repoFullName: "a/b", records: [{ kind: "plan" }], fetchImpl }),
    (e) => e instanceof IngestError && e.status === 401,
  );
});

test("postIntent throws IngestError(403) when the repo isn't connected to the key's org", async () => {
  const fetchImpl = async () => ({ status: 403, ok: false, json: async () => ({ error: "forbidden" }) });
  await assert.rejects(
    () => postIntent({ apiBaseUrl: "http://x", apiKey: "ok", repoFullName: "a/b", records: [{ kind: "plan" }], fetchImpl }),
    (e) => e instanceof IngestError && e.status === 403,
  );
});
