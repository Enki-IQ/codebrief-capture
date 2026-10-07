import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { configDir } from './config.js';
import { withPrivateStateDirectory, readPrivateStateJson, writePrivateStateJson, privateStateFileExists, withPrivateStateLock } from './handoff-state.js';
const MAX_LOCAL_JSON_BYTES = 128 * 1024;
/** Identity must come from authenticated upstream; no remote URL inference. */
export function tandemNamespace(identity) {
    const keys = ["accountId", "orgId", "repoId", "worktreeId", "attemptId"];
    if (!identity || keys.some(k => typeof identity[k] !== "string" || !identity[k] || identity[k].length > 1024))
        throw new TypeError("invalid Tandem identity");
    return createHash("sha256").update(JSON.stringify([2, ...keys.map(k => identity[k])])).digest("hex");
}
function managed(identity, options, operation) {
    return withPrivateStateDirectory(`tandem/v2/${tandemNamespace(identity)}`, options, { create: true }, operation);
}
export function saveTandemState(identity, state, options) {
    const envelope = { schemaVersion: 2, namespace: tandemNamespace(identity), state };
    const raw = JSON.stringify(envelope);
    if (!raw || Buffer.byteLength(raw) > MAX_LOCAL_JSON_BYTES)
        throw new TypeError("Tandem state too large");
    return managed(identity, options, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => {
        writePrivateStateJson(join(directoryPath, "state.json"), envelope, verify);
        return state;
    }));
}
export function loadTandemState(identity, options) {
    return managed(identity, options, ({ directoryPath, verify }) => {
        const v = readPrivateStateJson(join(directoryPath, "state.json"), verify);
        return v?.schemaVersion === 2 && v.namespace === tandemNamespace(identity) ? v.state : null;
    });
}
export function worktreeIdentity(root, options) {
    const git = (...args) => execFileSync("git", ["-C", root, "rev-parse", "--path-format=absolute", ...args], { encoding: "utf8" }).trim();
    const commonDir = realpathSync(git("--git-common-dir"));
    const gitDir = realpathSync(git("--git-dir"));
    const worktreeRoot = realpathSync(git("--show-toplevel"));
    const stateRoot = resolve(options?.baseDir ?? configDir());
    if (stateRoot === worktreeRoot || stateRoot.startsWith(worktreeRoot + sep))
        throw new Error("worktree identity must be stored outside repository");
    const binding = createHash("sha256").update(JSON.stringify([commonDir, gitDir])).digest("hex");
    return withPrivateStateDirectory("tandem/worktrees", options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => {
        const path = join(directoryPath, `${binding}.json`);
        const existing = readPrivateStateJson(path, verify);
        if (existing) {
            if (existing.binding !== binding || !/^[0-9a-f]{32}$/.test(existing.worktreeId))
                throw new Error("invalid worktree identity");
            return existing.worktreeId;
        }
        if (privateStateFileExists(path, verify))
            throw new Error("unreadable worktree identity");
        const worktreeId = randomBytes(16).toString("hex");
        writePrivateStateJson(path, { binding, worktreeId }, verify, { exclusive: true });
        return worktreeId;
    }));
}
/** The verifier must query the authenticated service for this handoff/worktree. */
export async function migrateLegacyHandoff(identity, repoFullName, verifyAuthenticatedMatch, options) {
    identity = Object.freeze({ ...identity });
    const { loadActiveHandoff, repoHash } = await import('./handoff-state.js');
    const legacy = loadActiveHandoff(repoFullName, options);
    if (!legacy)
        return { status: 'absent' };
    if (typeof verifyAuthenticatedMatch !== 'function' || (await verifyAuthenticatedMatch({ identity: { ...identity }, handoffId: legacy.handoffId })) !== true) {
        return { status: 'recovery_required', notice: 'Legacy handoff preserved; authenticated worktree match required' };
    }
    const namespace = tandemNamespace(identity);
    return withPrivateStateDirectory('tandem/legacy', options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => {
        const path = join(directoryPath, `${repoHash(repoFullName)}.json`);
        const consumed = readPrivateStateJson(path, verify);
        if (consumed && (consumed.namespace !== namespace || consumed.handoffId !== legacy.handoffId))
            return { status: 'recovery_required', notice: 'Legacy handoff already assigned to another worktree' };
        if (!consumed) {
            if (privateStateFileExists(path, verify))
                throw new Error('unsafe legacy consumption marker');
            // Reserve destination durably first: a crash may require repair, never fan out.
            writePrivateStateJson(path, { namespace, handoffId: legacy.handoffId }, verify, { exclusive: true });
        }
        managed(identity, options, ({ directoryPath: destinationDirectory, verify: verifyDestination }) => withPrivateStateLock(destinationDirectory, verifyDestination, () => {
            const destination = join(destinationDirectory, "state.json");
            if (privateStateFileExists(destination, verifyDestination)) {
                const existing = readPrivateStateJson(destination, verifyDestination);
                if (!existing || Array.isArray(existing) || existing.schemaVersion !== 2 || existing.namespace !== namespace || Object.keys(existing).length !== 3 || !Object.hasOwn(existing, "state"))
                    throw new Error("invalid Tandem migration destination");
                // A migration retry must never replace a newer execution checkpoint.
                return;
            }
            writePrivateStateJson(destination, { schemaVersion: 2, namespace, state: { legacyHandoff: legacy } }, verifyDestination, { exclusive: true });
        }));
        return { status: 'migrated' };
    }));
}
