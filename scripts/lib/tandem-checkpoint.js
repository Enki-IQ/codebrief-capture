import { join } from 'node:path';
import { tandemNamespace } from './tandem-state.js';
import { withPrivateStateDirectory, readPrivateStateJson, writePrivateStateJson, withPrivateStateLock } from './handoff-state.js';
import { scrubTranscriptText } from './scrub.js';
const KEYS = ['schemaVersion', 'namespace', 'actionId', 'attemptId', 'generation', 'contractVersion', 'baseSha', 'headSha', 'dirty', 'untracked', 'decisions', 'commands', 'nextSteps', 'unresolvedRisks', 'clean', 'scopeViolations', 'ownershipVerified'];
function exact(value, keys) { if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k)))
    throw new TypeError('Invalid checkpoint schema'); }
function scrubCheckpointText(value) { return scrubTranscriptText(value).replace(/\b(password|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*[^\s]+/gi, '$1=[redacted secret]'); }
function strings(value) { if (!Array.isArray(value) || value.length > 1000 || value.some(v => typeof v !== 'string' || v.length > 16384))
    throw new TypeError('Invalid checkpoint inventory'); return value.map(scrubCheckpointText); }
export function checkpointReady(c) { return c?.clean === true && c.ownershipVerified === true && Array.isArray(c.scopeViolations) && c.scopeViolations.length === 0; }
export function validateCheckpoint(identity, value) {
    exact(value, KEYS);
    if (value.schemaVersion !== 1 || value.namespace !== tandemNamespace(identity) || value.attemptId !== identity.attemptId || typeof value.actionId !== 'string' || !value.actionId || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(value.contractVersion) || value.contractVersion < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.baseSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headSha) || value.baseSha.length !== value.headSha.length || typeof value.clean !== 'boolean' || typeof value.ownershipVerified !== 'boolean')
        throw new TypeError('Invalid checkpoint binding');
    const clean = { ...value };
    for (const key of ['dirty', 'untracked', 'decisions', 'nextSteps', 'unresolvedRisks', 'scopeViolations'])
        clean[key] = strings(value[key]);
    if (!Array.isArray(value.commands) || value.commands.length > 1000)
        throw new TypeError('Invalid checkpoint commands');
    clean.commands = value.commands.map(command => { exact(command, ['command', 'exitStatus', 'time', 'revision']); if (typeof command.command !== 'string' || command.command.length > 16384 || !Number.isSafeInteger(command.exitStatus) || typeof command.time !== 'string' || !Number.isFinite(Date.parse(command.time)) || typeof command.revision !== 'string' || command.revision.length !== value.headSha.length || !/^[a-f0-9]+$/.test(command.revision))
        throw new TypeError('Invalid checkpoint command'); return { ...command, command: scrubCheckpointText(command.command) }; });
    if (Buffer.byteLength(JSON.stringify(clean)) > 128 * 1024)
        throw new TypeError('Checkpoint exceeds 128 KiB');
    return clean;
}
export async function writeCheckpoint(identity, value, options) { const clean = validateCheckpoint(identity, value); return withPrivateStateDirectory(`tandem/v2/${tandemNamespace(identity)}`, options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => writePrivateStateJson(join(directoryPath, 'checkpoint.json'), clean, verify))); }
export function readCheckpoint(identity, options) { return withPrivateStateDirectory(`tandem/v2/${tandemNamespace(identity)}`, options, { create: true }, ({ directoryPath, verify }) => { const value = readPrivateStateJson(join(directoryPath, 'checkpoint.json'), verify); return value ? validateCheckpoint(identity, value) : null; }); }
