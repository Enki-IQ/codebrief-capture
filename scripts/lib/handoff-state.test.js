import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  activeHandoffPath,
  clearActiveHandoff,
  listHandoffOutbox,
  loadActiveHandoff,
  loadHandoffOutbox,
  repoHash,
  removeHandoffOutbox,
  saveActiveHandoff,
  saveHandoffOutbox,
} from "./handoff-state.js";

const handoffId = "10000000-0000-4000-8000-000000000001";
const actionId = "20000000-0000-4000-8000-000000000002";

function tempBase() {
  return realpathSync(mkdtempSync(join(tmpdir(), "codebrief-handoff-")));
}

function result(extra = {}) {
  return {
    schemaVersion: 2,
    outcome: "completed",
    checks: [],
    references: [],
    blockers: [],
    ...extra,
  };
}

test("active state stores only the restrictive allowlist and hashes the repository name", () => {
  const baseDir = tempBase();
  saveActiveHandoff({
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 3,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
    contract: { sourceText: "must never persist" },
    transcript: "must never persist",
    apiKey: "must never persist",
  }, { baseDir });

  const path = activeHandoffPath("Acme/Widget", { baseDir });
  const raw = readFileSync(path, "utf8");
  assert.deepEqual(JSON.parse(raw), {
    schemaVersion: 1,
    repoHash: repoHash("Acme/Widget"),
    handoffId,
    actionId,
    actionVersion: 3,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  });
  assert.doesNotMatch(raw, /Acme|Widget|sourceText|transcript|apiKey|must never persist/);
  assert.deepEqual(loadActiveHandoff("Acme/Widget", { baseDir }), JSON.parse(raw));
});

test("state and outbox use 0700 directories and 0600 files, repairing broad existing modes", () => {
  const baseDir = tempBase();
  const activeDir = join(baseDir, "active-project");
  const outboxDir = join(baseDir, "outbox");
  mkdirSync(activeDir, { mode: 0o755 });
  mkdirSync(outboxDir, { mode: 0o755 });

  saveActiveHandoff({
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 1,
    host: "claude",
    startMarker: "2026-07-27T10:00:00.000Z",
  }, { baseDir });
  saveHandoffOutbox({ handoffId, result: result() }, { baseDir });

  const statePath = activeHandoffPath("Acme/Widget", { baseDir });
  const outboxPath = join(outboxDir, `${handoffId}.json`);
  chmodSync(statePath, 0o644);
  chmodSync(outboxPath, 0o644);
  assert.equal(loadActiveHandoff("Acme/Widget", { baseDir }).handoffId, handoffId);
  saveHandoffOutbox({
    handoffId,
    result: result({ checks: [{ kind: "tests", status: "passed" }] }),
  }, { baseDir });

  assert.equal(statSync(activeDir).mode & 0o777, 0o700);
  assert.equal(statSync(outboxDir).mode & 0o777, 0o700);
  assert.equal(statSync(statePath).mode & 0o777, 0o600);
  assert.equal(statSync(outboxPath).mode & 0o777, 0o600);
});

test("active marker installation is exclusive and leaves no temp files", () => {
  const baseDir = tempBase();
  const input = {
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 1,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  };
  saveActiveHandoff(input, { baseDir });
  assert.throws(
    () => saveActiveHandoff({ ...input, actionVersion: 2 }, { baseDir }),
    /active handoff/i,
  );

  const dir = dirname(activeHandoffPath(input.repoFullName, { baseDir }));
  assert.deepEqual(readdirSync(dir), [`${repoHash(input.repoFullName)}.json`]);
  assert.equal(loadActiveHandoff(input.repoFullName, { baseDir }).actionVersion, 1);
});

test("corrupt or over-permissive active state fails closed", () => {
  const baseDir = tempBase();
  const path = activeHandoffPath("Acme/Widget", { baseDir });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    schemaVersion: 1,
    repoHash: repoHash("Acme/Widget"),
    handoffId,
    actionId,
    actionVersion: 1,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
    transcript: "unexpected",
  }));
  assert.equal(loadActiveHandoff("Acme/Widget", { baseDir }), null);
});

test("outbox stores only an exact validated result plus handoff ID and supports bounded retry listing", () => {
  const baseDir = tempBase();
  assert.throws(() => saveHandoffOutbox({
    handoffId,
    result: result({ summary: "drop me" }),
  }, { baseDir }), /summary/);
  saveHandoffOutbox({
    handoffId,
    result: result(),
    repoFullName: "Acme/Widget",
    contract: "never persist",
  }, { baseDir });

  const entry = loadHandoffOutbox(handoffId, { baseDir });
  assert.deepEqual(entry, {
    schemaVersion: 1,
    handoffId,
    result: result(),
  });
  const raw = readFileSync(join(baseDir, "outbox", `${handoffId}.json`), "utf8");
  assert.doesNotMatch(raw, /Acme|Widget|contract|summary|drop me/);
  assert.deepEqual(listHandoffOutbox({ baseDir }), [entry]);

  removeHandoffOutbox(handoffId, { baseDir });
  assert.equal(loadHandoffOutbox(handoffId, { baseDir }), null);
  clearActiveHandoff("Acme/Widget", { baseDir });
  assert.equal(loadActiveHandoff("Acme/Widget", { baseDir }), null);
});

test("handoff IDs cannot escape the outbox directory", () => {
  const baseDir = tempBase();
  assert.throws(
    () => saveHandoffOutbox({ handoffId: "../../credentials", result: result() }, { baseDir }),
    /handoffId/,
  );
  assert.deepEqual(readdirSync(baseDir), []);
});

test("outbox discovery reads at most a bounded number of bounded files", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  mkdirSync(directory, { mode: 0o700 });
  for (let index = 0; index < 105; index += 1) {
    const id = randomUUID();
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({
      schemaVersion: 1,
      handoffId: id,
      result: result(),
    }), { mode: 0o600 });
  }
  const oversizedId = randomUUID();
  writeFileSync(
    join(directory, `${oversizedId}.json`),
    JSON.stringify({ schemaVersion: 1, handoffId: oversizedId, padding: "x".repeat(140 * 1024) }),
    { mode: 0o600 },
  );

  const entries = listHandoffOutbox({ baseDir });
  assert.ok(entries.length <= 100);
  assert.equal(loadHandoffOutbox(oversizedId, { baseDir }), null);
  assert.equal(entries.some((entry) => entry.handoffId === oversizedId), false);
});

test("state operations reject directory and file symlink substitution without touching targets", () => {
  const baseDir = tempBase();
  const directoryTarget = tempBase();
  const linkedDirectory = join(baseDir, "active-project");
  chmodSync(directoryTarget, 0o755);
  symlinkSync(directoryTarget, linkedDirectory, "dir");

  assert.throws(() => saveActiveHandoff({
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 1,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  }, { baseDir }), /symlink|directory|loop/i);
  assert.equal(statSync(directoryTarget).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(directoryTarget), []);

  rmSync(linkedDirectory);
  mkdirSync(linkedDirectory, { mode: 0o700 });
  const fileTarget = join(tempBase(), "victim.json");
  writeFileSync(fileTarget, "do not read or chmod", { mode: 0o644 });
  symlinkSync(fileTarget, activeHandoffPath("Acme/Widget", { baseDir }));

  assert.equal(loadActiveHandoff("Acme/Widget", { baseDir }), null);
  assert.throws(() => saveActiveHandoff({
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 1,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  }, { baseDir }), /active handoff|symlink|exist/i);
  assert.equal(readFileSync(fileTarget, "utf8"), "do not read or chmod");
  assert.equal(statSync(fileTarget).mode & 0o777, 0o644);

  const outboxBase = tempBase();
  const outboxTarget = tempBase();
  chmodSync(outboxTarget, 0o755);
  symlinkSync(outboxTarget, join(outboxBase, "outbox"), "dir");
  assert.throws(
    () => saveHandoffOutbox({ handoffId, result: result() }, { baseDir: outboxBase }),
    /symlink|directory|loop/i,
  );
  assert.equal(statSync(outboxTarget).mode & 0o777, 0o755);
  assert.deepEqual(readdirSync(outboxTarget), []);
});

test("state operations reject a symlink in any intermediate ancestor", () => {
  const root = tempBase();
  const target = tempBase();
  const nested = join(target, "nested");
  mkdirSync(nested);
  symlinkSync(target, join(root, "jump"), "dir");
  const baseDir = join(root, "jump", "nested", "config");

  assert.throws(() => saveActiveHandoff({
    repoFullName: "Acme/Widget",
    handoffId,
    actionId,
    actionVersion: 1,
    host: "codex",
    startMarker: "2026-07-27T10:00:00.000Z",
  }, { baseDir }), /symlink|ancestor|directory|unsafe/i);
  assert.equal(existsSync(join(nested, "config")), false);
});

test("outbox write rejects entry 101 while allowing retry overwrite of an existing handoff", () => {
  const baseDir = tempBase();
  const ids = Array.from({ length: 101 }, () => randomUUID());
  for (const id of ids.slice(0, 100)) {
    saveHandoffOutbox({ handoffId: id, result: result() }, { baseDir });
  }

  assert.throws(
    () => saveHandoffOutbox({ handoffId: ids[100], result: result() }, { baseDir }),
    /outbox.*full/i,
  );
  assert.equal(readdirSync(join(baseDir, "outbox")).length, 100);

  saveHandoffOutbox({
    handoffId: ids[0],
    result: result({ checks: [{ kind: "review", status: "passed" }] }),
  }, { baseDir });
  assert.deepEqual(loadHandoffOutbox(ids[0], { baseDir }).result.checks, [
    { kind: "review", status: "passed" },
  ]);
  assert.equal(readdirSync(join(baseDir, "outbox")).length, 100);
});

test("outbox write lock contention fails for retry without creating hidden entries", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, ".write.lock"), "", { flag: "wx", mode: 0o600 });

  assert.throws(
    () => saveHandoffOutbox({ handoffId, result: result() }, { baseDir }),
    /outbox.*busy|retry/i,
  );
  assert.deepEqual(readdirSync(directory), [".write.lock"]);
});

test("outbox safely recovers only an old same-owner lock with no live process", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  const lockPath = join(directory, ".write.lock");
  mkdirSync(directory, { mode: 0o700 });
  const old = Date.now() - 10 * 60 * 1000;
  writeFileSync(lockPath, JSON.stringify({
    pid: 99_999_999,
    uid: process.getuid(),
    createdAtMs: old,
    nonce: "a".repeat(32),
  }), { flag: "wx", mode: 0o600 });
  utimesSync(lockPath, new Date(old), new Date(old));

  saveHandoffOutbox({ handoffId, result: result() }, { baseDir });

  assert.equal(existsSync(lockPath), false);
  assert.equal(loadHandoffOutbox(handoffId, { baseDir }).handoffId, handoffId);
});

test("outbox recovers an old same-owner empty lock left by the legacy writer", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  const lockPath = join(directory, ".write.lock");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(lockPath, "", { flag: "wx", mode: 0o600 });
  const old = Date.now() - 10 * 60 * 1000;
  utimesSync(lockPath, new Date(old), new Date(old));

  saveHandoffOutbox({ handoffId, result: result() }, { baseDir });

  assert.equal(existsSync(lockPath), false);
  assert.equal(loadHandoffOutbox(handoffId, { baseDir }).handoffId, handoffId);
});

test("outbox recovers an old same-UID malformed partial lock", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  const lockPath = join(directory, ".write.lock");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(lockPath, '{"pid":', { flag: "wx", mode: 0o600 });
  const old = Date.now() - 10 * 60 * 1000;
  utimesSync(lockPath, new Date(old), new Date(old));

  saveHandoffOutbox({ handoffId, result: result() }, { baseDir });

  assert.equal(existsSync(lockPath), false);
  assert.equal(loadHandoffOutbox(handoffId, { baseDir }).handoffId, handoffId);
});

test("outbox lock age and ownership prevent PID reuse from blocking recovery", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  const lockPath = join(directory, ".write.lock");
  mkdirSync(directory, { mode: 0o700 });
  const old = Date.now() - 10 * 60 * 1000;
  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    uid: process.getuid(),
    createdAtMs: old,
    nonce: "b".repeat(32),
  }), { flag: "wx", mode: 0o600 });
  utimesSync(lockPath, new Date(old), new Date(old));

  saveHandoffOutbox({ handoffId, result: result() }, { baseDir });

  assert.equal(existsSync(lockPath), false);
  assert.equal(loadHandoffOutbox(handoffId, { baseDir }).handoffId, handoffId);
});

test("outbox never reclaims a recent same-owner lock", () => {
  const baseDir = tempBase();
  const directory = join(baseDir, "outbox");
  const lockPath = join(directory, ".write.lock");
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(lockPath, JSON.stringify({
    pid: 99_999_999,
    uid: process.getuid(),
    createdAtMs: Date.now(),
    nonce: "b".repeat(32),
  }), { flag: "wx", mode: 0o600 });

  assert.throws(
    () => saveHandoffOutbox({ handoffId, result: result() }, { baseDir }),
    /outbox.*busy|retry/i,
  );
  assert.equal(existsSync(lockPath), true);
});

test("clear active state ignores ENOENT but propagates other removal failures", () => {
  const baseDir = tempBase();
  clearActiveHandoff("Acme/Widget", { baseDir });

  const path = activeHandoffPath("Acme/Widget", { baseDir });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  mkdirSync(path);
  assert.throws(() => clearActiveHandoff("Acme/Widget", { baseDir }));
  assert.equal(statSync(path).isDirectory(), true);
});
