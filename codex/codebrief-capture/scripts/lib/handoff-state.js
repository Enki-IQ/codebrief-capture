import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve, sep } from "node:path";
import { configDir } from "./config.js";
import { validateHandoffResult } from "./handoff-result.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HASH = /^[0-9a-f]{64}$/;
const HOSTS = new Set(["codex", "claude"]);
const ACTIVE_KEYS = new Set([
  "schemaVersion",
  "repoHash",
  "handoffId",
  "actionId",
  "actionVersion",
  "host",
  "startMarker",
]);
const OUTBOX_KEYS = new Set(["schemaVersion", "handoffId", "result"]);
const MAX_OUTBOX_ENTRIES = 100;
const MAX_OUTBOX_DIRECTORY_SCAN = 1_000;
const MAX_LOCAL_JSON_BYTES = 128 * 1024;
const MAX_LOCK_BYTES = 512;
const LOCK_STALE_MS = 5 * 60 * 1_000;
const LOCK_KEYS = new Set(["pid", "uid", "createdAtMs", "nonce"]);
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY
  | (constants.O_DIRECTORY ?? 0)
  | (constants.O_NOFOLLOW ?? 0);
const FILE_READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const FILE_CREATE_FLAGS = constants.O_WRONLY
  | constants.O_CREAT
  | constants.O_EXCL
  | (constants.O_NOFOLLOW ?? 0);

function base(options) {
  return resolve(options?.baseDir ?? configDir());
}

function exactKeys(value, expected) {
  return Object.keys(value).length === expected.size
    && Object.keys(value).every((key) => expected.has(key));
}

function validUuid(value, field) {
  if (typeof value !== "string" || !UUID.test(value)) throw new TypeError(`invalid ${field}`);
  return value.toLowerCase();
}

function validActionVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("invalid actionVersion");
  return value;
}

function validStartMarker(value) {
  if (
    typeof value !== "string"
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new TypeError("invalid startMarker");
  }
  return value;
}

export function repoHash(repoFullName) {
  if (typeof repoFullName !== "string" || !REPO.test(repoFullName)) {
    throw new TypeError("invalid repoFullName");
  }
  return createHash("sha256").update(repoFullName, "utf8").digest("hex");
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function verifyDirectory(guard) {
  const pathStat = lstatSync(guard.path);
  const descriptorStat = fstatSync(guard.descriptor);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isDirectory()
    || !descriptorStat.isDirectory()
    || !sameNode(pathStat, descriptorStat)
  ) {
    throw new Error("unsafe handoff directory");
  }
}

function openVerifiedDirectory(path, { mode } = {}) {
  let descriptor;
  try {
    descriptor = openSync(path, DIRECTORY_OPEN_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP" || error?.code === "ENOTDIR") {
      throw new Error("unsafe handoff directory", { cause: error });
    }
    throw error;
  }
  const guard = { descriptor, path };
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory()) throw new Error("unsafe handoff directory");
    verifyDirectory(guard);
    if (mode !== undefined) fchmodSync(descriptor, mode);
    verifyDirectory(guard);
    return guard;
  } catch (error) {
    closeSync(descriptor);
    throw error;
  }
}

function openDirectoryWithAncestors(path, parentGuards, { mode } = {}) {
  parentGuards.forEach(verifyDirectory);
  const guard = openVerifiedDirectory(path);
  try {
    [...parentGuards, guard].forEach(verifyDirectory);
    if (mode !== undefined) fchmodSync(guard.descriptor, mode);
    [...parentGuards, guard].forEach(verifyDirectory);
    return guard;
  } catch (error) {
    closeSync(guard.descriptor);
    throw error;
  }
}

function absoluteDirectoryPaths(path) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const parts = absolute.slice(root.length).split(sep).filter(Boolean);
  const paths = [root];
  for (const part of parts) paths.push(join(paths.at(-1), part));
  return paths;
}

// Node has no portable openat/renameat API. Keep every ancestor descriptor open,
// verify identities around each path syscall, and use O_NOFOLLOW on final entries.
function openAncestorChain(path) {
  const guards = [];
  try {
    for (const component of absoluteDirectoryPaths(path)) {
      guards.push(openDirectoryWithAncestors(component, guards));
    }
    return guards;
  } catch (error) {
    for (const guard of guards.reverse()) {
      try { closeSync(guard.descriptor); } catch { /* already closed */ }
    }
    throw error;
  }
}

function ensureDirectory(path, parentGuards, create, mode) {
  try {
    return openDirectoryWithAncestors(path, parentGuards, { mode });
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
  }
  parentGuards.forEach(verifyDirectory);
  try {
    mkdirSync(path, { mode });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  parentGuards.forEach(verifyDirectory);
  return openDirectoryWithAncestors(path, parentGuards, { mode });
}

function withManagedDirectory(name, options, { create }, operation) {
  const basePath = base(options);
  const parentPath = dirname(basePath);
  if (basePath === parentPath) throw new Error("unsafe handoff base directory");
  const guards = [];
  try {
    try {
      guards.push(...openAncestorChain(parentPath));
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }

    let baseGuard;
    try {
      baseGuard = ensureDirectory(basePath, guards, create, 0o700);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    guards.push(baseGuard);

    let directoryPath = basePath;
    const components = name.split('/');
    for (const component of components.slice(0, -1)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(component) || component === '.' || component === '..') throw new Error('unsafe handoff directory');
      directoryPath = join(directoryPath, component);
      guards.push(ensureDirectory(directoryPath, guards, create, 0o700));
    }
    const finalComponent = components.at(-1);
    if (!/^[A-Za-z0-9_.-]+$/.test(finalComponent) || finalComponent === '.' || finalComponent === '..') throw new Error('unsafe handoff directory');
    directoryPath = join(directoryPath, finalComponent);
    let directory;
    try {
      directory = ensureDirectory(directoryPath, guards, create, 0o700);
    } catch (error) {
      if (!create && error?.code === "ENOENT") return null;
      throw error;
    }
    guards.push(directory);
    const verify = () => guards.forEach(verifyDirectory);
    verify();
    const output = operation({ directoryPath, verify });
    verify();
    return output;
  } finally {
    for (const guard of guards.reverse()) {
      try { closeSync(guard.descriptor); } catch { /* already closed */ }
    }
  }
}

function verifyRegularFile(path, descriptor, maxBytes = MAX_LOCAL_JSON_BYTES) {
  const pathStat = lstatSync(path);
  const descriptorStat = fstatSync(descriptor);
  if (
    pathStat.isSymbolicLink()
    || !pathStat.isFile()
    || !descriptorStat.isFile()
    || descriptorStat.nlink !== 1
    || descriptorStat.size > maxBytes
    || !sameNode(pathStat, descriptorStat)
  ) {
    throw new Error("unsafe handoff file");
  }
  return descriptorStat;
}

function secureReadJson(path, verifyDirectoryPath) {
  let descriptor;
  try {
    verifyDirectoryPath();
    descriptor = openSync(path, FILE_READ_FLAGS);
    verifyDirectoryPath();
    verifyRegularFile(path, descriptor);
    fchmodSync(descriptor, 0o600);
    verifyRegularFile(path, descriptor);
    const raw = readFileSync(descriptor, "utf8");
    verifyRegularFile(path, descriptor);
    verifyDirectoryPath();
    return JSON.parse(raw);
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

function secureRegularFileExists(path, verifyDirectoryPath) {
  let descriptor;
  try {
    verifyDirectoryPath();
    descriptor = openSync(path, FILE_READ_FLAGS);
    verifyDirectoryPath();
    verifyRegularFile(path, descriptor);
    fchmodSync(descriptor, 0o600);
    verifyRegularFile(path, descriptor);
    verifyDirectoryPath();
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

function removeTemporary(path) {
  try {
    rmSync(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function atomicPrivateJson(path, value, verifyDirectoryPath, { exclusive = false } = {}) {
  const directory = dirname(path);
  const temporary = join(directory, `.${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor;
  try {
    verifyDirectoryPath();
    descriptor = openSync(temporary, FILE_CREATE_FLAGS, 0o600);
    verifyDirectoryPath();
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    verifyDirectoryPath();

    if (exclusive) {
      try {
        linkSync(temporary, path);
      } catch (error) {
        if (error?.code === "EEXIST") throw new Error("active handoff already exists");
        throw error;
      }
      verifyDirectoryPath();
      removeTemporary(temporary);
      verifyDirectoryPath();
    } else {
      try {
        const existing = lstatSync(path);
        if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1) {
          throw new Error("unsafe handoff file");
        }
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      verifyDirectoryPath();
      renameSync(temporary, path);
    }

    verifyDirectoryPath();
    const directoryFd = openSync(directory, DIRECTORY_OPEN_FLAGS);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    const installed = openSync(path, FILE_READ_FLAGS);
    try {
      verifyRegularFile(path, installed);
      fchmodSync(installed, 0o600);
      verifyRegularFile(path, installed);
    } finally {
      closeSync(installed);
    }
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    try { removeTemporary(temporary); } catch { /* preserve the primary error */ }
  }
}

function activeDir(options) {
  return join(base(options), "active-project");
}

export function activeHandoffPath(repoFullName, options) {
  return join(activeDir(options), `${repoHash(repoFullName)}.json`);
}

function normalizeActiveState(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid active handoff");
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new TypeError("invalid schemaVersion");
  const host = input.host;
  if (!HOSTS.has(host)) throw new TypeError("invalid host");
  return {
    schemaVersion: 1,
    repoHash: repoHash(input.repoFullName),
    handoffId: validUuid(input.handoffId, "handoffId"),
    actionId: validUuid(input.actionId, "actionId"),
    actionVersion: validActionVersion(input.actionVersion),
    host,
    startMarker: validStartMarker(input.startMarker),
  };
}

function parseActiveState(value, expectedRepoHash) {
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactKeys(value, ACTIVE_KEYS)
      || value.schemaVersion !== 1
      || value.repoHash !== expectedRepoHash
      || !HASH.test(value.repoHash)
      || !HOSTS.has(value.host)
    ) {
      return null;
    }
    return {
      schemaVersion: 1,
      repoHash: value.repoHash,
      handoffId: validUuid(value.handoffId, "handoffId"),
      actionId: validUuid(value.actionId, "actionId"),
      actionVersion: validActionVersion(value.actionVersion),
      host: value.host,
      startMarker: validStartMarker(value.startMarker),
    };
  } catch {
    return null;
  }
}

export function saveActiveHandoff(input, options) {
  const state = normalizeActiveState(input);
  return withManagedDirectory("active-project", options, { create: true }, ({ directoryPath, verify }) => {
    atomicPrivateJson(
      join(directoryPath, `${state.repoHash}.json`),
      state,
      verify,
      { exclusive: true },
    );
    return state;
  });
}

export function loadActiveHandoff(repoFullName, options) {
  const hash = repoHash(repoFullName);
  const value = withManagedDirectory(
    "active-project",
    options,
    { create: false },
    ({ directoryPath, verify }) => secureReadJson(join(directoryPath, `${hash}.json`), verify),
  );
  return parseActiveState(value, hash);
}

function secureRemove(path, verifyDirectoryPath) {
  try {
    verifyDirectoryPath();
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe handoff file");
    verifyDirectoryPath();
    rmSync(path);
    verifyDirectoryPath();
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function clearActiveHandoff(repoFullName, options) {
  const hash = repoHash(repoFullName);
  return withManagedDirectory(
    "active-project",
    options,
    { create: false },
    ({ directoryPath, verify }) => secureRemove(join(directoryPath, `${hash}.json`), verify),
  );
}

function normalizeOutbox(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("invalid outbox entry");
  return {
    schemaVersion: 1,
    handoffId: validUuid(input.handoffId, "handoffId"),
    result: validateHandoffResult(input.result),
  };
}

function parseOutbox(value, expectedHandoffId) {
  try {
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || !exactKeys(value, OUTBOX_KEYS)
      || value.schemaVersion !== 1
      || value.handoffId !== expectedHandoffId
    ) {
      return null;
    }
    return normalizeOutbox(value);
  } catch {
    return null;
  }
}

function assertOutboxCapacity(directoryPath) {
  const handle = opendirSync(directoryPath);
  try {
    let entries = 0;
    let scanned = 0;
    while (scanned < MAX_OUTBOX_DIRECTORY_SCAN) {
      const entry = handle.readSync();
      if (!entry) return;
      scanned += 1;
      if (entry.name.endsWith(".json") && UUID.test(entry.name.slice(0, -5))) {
        entries += 1;
        if (entries >= MAX_OUTBOX_ENTRIES) throw new Error("Codebrief handoff outbox is full");
      }
    }
    if (handle.readSync()) throw new Error("Codebrief handoff outbox scan limit exceeded");
  } finally {
    handle.closeSync();
  }
}

function currentUid() {
  const uid = process.getuid?.();
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function validLockOwner(value) {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && exactKeys(value, LOCK_KEYS)
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && Number.isSafeInteger(value.uid)
    && value.uid >= 0
    && Number.isFinite(value.createdAtMs)
    && value.createdAtMs > 0
    && typeof value.nonce === "string"
    && /^[0-9a-f]{32}$/.test(value.nonce);
}

function restoreUnexpectedQuarantine(quarantinePath, lockPath) {
  try {
    renameSync(quarantinePath, lockPath);
  } catch {
    // Preserve a replacement at the canonical path and fail closed.
  }
}

function reclaimStaleLock(lockPath, verifyDirectoryPath, staleMs = LOCK_STALE_MS) {
  let descriptor;
  const quarantinePath = join(
    dirname(lockPath),
    `.${process.pid}-${randomBytes(8).toString("hex")}.stale`,
  );
  try {
    verifyDirectoryPath();
    descriptor = openSync(lockPath, FILE_READ_FLAGS);
    verifyDirectoryPath();
    const stat = verifyRegularFile(lockPath, descriptor, MAX_LOCK_BYTES);
    const uid = currentUid();
    if (uid === null || stat.uid !== uid) return false;

    const raw = readFileSync(descriptor, "utf8");
    let owner;
    try { owner = JSON.parse(raw); } catch { /* malformed crash residue */ }
    const newestOwnershipEvidence = validLockOwner(owner)
      ? Math.max(owner.createdAtMs, stat.mtimeMs)
      : stat.mtimeMs;
    if (
      Date.now() - newestOwnershipEvidence < staleMs
      || (validLockOwner(owner) && owner.uid !== uid)
    ) return false;

    verifyDirectoryPath();
    verifyRegularFile(lockPath, descriptor, MAX_LOCK_BYTES);
    renameSync(lockPath, quarantinePath);
    verifyDirectoryPath();
    const moved = lstatSync(quarantinePath);
    const held = fstatSync(descriptor);
    if (
      moved.isSymbolicLink()
      || !moved.isFile()
      || !sameNode(moved, held)
      || held.uid !== uid
    ) {
      restoreUnexpectedQuarantine(quarantinePath, lockPath);
      throw new Error("handoff lock changed during recovery");
    }
    rmSync(quarantinePath);
    verifyDirectoryPath();
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    if (error?.code === "ELOOP") throw new Error("unsafe handoff lock");
    throw error;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
  }
}

function createAtomicLock(lockPath, verifyDirectoryPath) {
  const uid = currentUid();
  if (uid === null) throw new Error("secure handoff locks require user ownership support");
  const temporaryPath = join(
    dirname(lockPath),
    `.${process.pid}-${randomBytes(8).toString("hex")}.lock`,
  );
  let descriptor;
  let installed = false;
  try {
    verifyDirectoryPath();
    descriptor = openSync(temporaryPath, FILE_CREATE_FLAGS, 0o600);
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      uid,
      createdAtMs: Date.now(),
      nonce: randomBytes(16).toString("hex"),
    }), "utf8");
    fsyncSync(descriptor);
    verifyRegularFile(temporaryPath, descriptor, MAX_LOCK_BYTES);
    verifyDirectoryPath();
    linkSync(temporaryPath, lockPath);
    installed = true;
    verifyDirectoryPath();
    removeTemporary(temporaryPath);
    verifyRegularFile(lockPath, descriptor, MAX_LOCK_BYTES);
    verifyDirectoryPath();
    const stat = fstatSync(descriptor);
    return {
      descriptor,
      path: lockPath,
      dev: stat.dev,
      ino: stat.ino,
    };
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* already closed */ }
    }
    if (error?.code === "EEXIST" && !installed) return null;
    throw error;
  } finally {
    try { removeTemporary(temporaryPath); } catch { /* preserve the primary error */ }
  }
}

function acquireLock(lockPath, verifyDirectoryPath, busyMessage, staleMs = LOCK_STALE_MS) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const lock = createAtomicLock(lockPath, verifyDirectoryPath);
    if (lock) return lock;
    if (attempt === 0 && reclaimStaleLock(lockPath, verifyDirectoryPath, staleMs)) continue;
    if (busyMessage) throw new Error(busyMessage);
    return null;
  }
  if (busyMessage) throw new Error(busyMessage);
  return null;
}

function releaseOwnedLock(lock, verifyDirectoryPath) {
  verifyDirectoryPath();
  let current;
  try {
    current = lstatSync(lock.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (current.isSymbolicLink()) throw new Error("unsafe handoff lock");
  if (!current.isFile() || current.dev !== lock.dev || current.ino !== lock.ino) return;
  verifyRegularFile(lock.path, lock.descriptor, MAX_LOCK_BYTES);
  verifyDirectoryPath();
  rmSync(lock.path);
  verifyDirectoryPath();
}

function withOutboxWriteLock(directoryPath, verifyDirectoryPath, operation) {
  const lockPath = join(directoryPath, ".write.lock");
  let lock;
  try {
    lock = acquireLock(
      lockPath,
      verifyDirectoryPath,
      "Codebrief handoff outbox is busy; retry the result",
    );
    return operation();
  } finally {
    if (lock) {
      try {
        releaseOwnedLock(lock, verifyDirectoryPath);
      } finally {
        try { closeSync(lock.descriptor); } catch { /* already closed */ }
      }
    }
  }
}

export async function withSubmissionLock(handoffId, operation, options) {
  const normalizedId = validUuid(handoffId, "handoffId");
  const lock = withManagedDirectory(
    "active-project-locks",
    options,
    { create: true },
    ({ directoryPath, verify }) => acquireLock(
      join(directoryPath, `${normalizedId}.lock`),
      verify,
      null,
      options?.staleMs ?? LOCK_STALE_MS,
    ),
  );
  if (!lock) return { status: "skipped:in-flight" };
  try {
    return await operation();
  } finally {
    try {
      withManagedDirectory(
        "active-project-locks",
        options,
        { create: false },
        ({ verify }) => releaseOwnedLock(lock, verify),
      );
    } finally {
      try { closeSync(lock.descriptor); } catch { /* already closed */ }
    }
  }
}

export function saveHandoffOutbox(input, options) {
  const entry = normalizeOutbox(input);
  return withManagedDirectory("outbox", options, { create: true }, ({ directoryPath, verify }) => {
    return withOutboxWriteLock(directoryPath, verify, () => {
      const path = join(directoryPath, `${entry.handoffId}.json`);
      const replacing = secureRegularFileExists(path, verify);
      if (!replacing) {
        verify();
        assertOutboxCapacity(directoryPath);
        verify();
      }
      atomicPrivateJson(path, entry, verify);
      return entry;
    });
  });
}

export function loadHandoffOutbox(handoffId, options) {
  const normalizedId = validUuid(handoffId, "handoffId");
  const value = withManagedDirectory(
    "outbox",
    options,
    { create: false },
    ({ directoryPath, verify }) => secureReadJson(
      join(directoryPath, `${normalizedId}.json`),
      verify,
    ),
  );
  return parseOutbox(value, normalizedId);
}

export function listHandoffOutbox(options) {
  try {
    return withManagedDirectory("outbox", options, { create: true }, ({ directoryPath, verify }) => {
      const names = [];
      const handle = opendirSync(directoryPath);
      try {
        let scanned = 0;
        while (names.length < MAX_OUTBOX_ENTRIES && scanned < MAX_OUTBOX_DIRECTORY_SCAN) {
          const entry = handle.readSync();
          if (!entry) break;
          scanned += 1;
          if (entry.isFile() && entry.name.endsWith(".json") && UUID.test(entry.name.slice(0, -5))) {
            names.push(entry.name);
          }
        }
      } finally {
        handle.closeSync();
      }
      verify();
      return names
        .sort()
        .map((name) => {
          const handoffId = name.slice(0, -5).toLowerCase();
          return parseOutbox(secureReadJson(join(directoryPath, name), verify), handoffId);
        })
        .filter(Boolean);
    }) ?? [];
  } catch {
    return [];
  }
}

export function removeHandoffOutbox(handoffId, options) {
  const normalizedId = validUuid(handoffId, "handoffId");
  return withManagedDirectory(
    "outbox",
    options,
    { create: false },
    ({ directoryPath, verify }) => secureRemove(
      join(directoryPath, `${normalizedId}.json`),
      verify,
    ),
  );
}

// Shared descriptor-based local storage primitives; all callers retain the same guards.
export {
  withManagedDirectory as withPrivateStateDirectory,
  secureReadJson as readPrivateStateJson,
  atomicPrivateJson as writePrivateStateJson,
  secureRegularFileExists as privateStateFileExists,
  withOutboxWriteLock as withPrivateStateLock,
};
