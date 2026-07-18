import { test } from "node:test";
import assert from "node:assert";
import { runCapture } from "./session-end-hook.js";
import { IngestError } from "./lib/http.js";

test("no-op when repo is not enabled", async () => {
  let posted = false;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: { resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => false,
      loadCreds: () => ({ apiKey: "t" }), distill: () => [{ kind: "plan", summary: "x" }],
      postIntent: async () => { posted = true; return { accepted: 1, dropped: [] }; }, loadConfig: () => ({ apiBaseUrl: "http://x" }) },
  });
  assert.equal(out.status, "skipped:not-enabled");
  assert.equal(posted, false);
});

test("no-op (with hint) when not logged in", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: { resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => null, distill: () => [], postIntent: async () => ({}), loadConfig: () => ({ apiBaseUrl: "http://x" }) },
  });
  assert.equal(out.status, "skipped:no-auth");
});

test("happy path distills, pre-scrubs, and posts", async () => {
  let sent = null;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "t" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }, { kind: "plan", summary: "```code```" }],
      postIntent: async ({ records }) => { sent = records; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(sent.length, 1); // the code-fenced record dropped by pre-scrub
});

test("surfaces a new-key hint when the CLI key is rejected (401)", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "dead" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      postIntent: async () => { throw new IngestError(401, { error: "unauthorized" }); },
    },
  });
  assert.equal(out.status, "error:auth");
});

test("surfaces a repo-not-connected hint on 403", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      postIntent: async () => { throw new IngestError(403, { error: "forbidden" }); },
    },
  });
  assert.equal(out.status, "error:repo");
});

test("flags missing claude when distill yields nothing and claude is absent", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [], isClaudeAvailable: () => false,
      postIntent: async () => ({ accepted: 0, dropped: [] }),
    },
  });
  assert.equal(out.status, "skipped:no-claude");
});

test("empty distill with claude present is plain no-intent (not no-claude)", async () => {
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "s" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [], isClaudeAvailable: () => true,
      postIntent: async () => ({ accepted: 0, dropped: [] }),
    },
  });
  assert.equal(out.status, "skipped:no-intent");
});

test("does not forward an unsafe hook session id as sourceRef", async () => {
  let sent;
  const out = await runCapture({
    input: { cwd: "/x", transcript_path: "/t", session_id: "session\nleak" },
    deps: {
      resolveRepo: () => ({ fullName: "a/b", commitSha: "abc" }), isRepoEnabled: () => true,
      loadCreds: () => ({ apiKey: "ok" }), loadConfig: () => ({ apiBaseUrl: "http://x" }),
      distill: () => [{ kind: "plan", summary: "Ship login" }],
      postIntent: async ({ records }) => { sent = records; return { accepted: 1, dropped: [] }; },
    },
  });
  assert.equal(out.status, "sent");
  assert.equal(sent[0].sourceRef, "unknown");
});
