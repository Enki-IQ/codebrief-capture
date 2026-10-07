import {launchRelayRequest} from './conductor-bootstrap.js';
import { execFileSync } from 'node:child_process';
import { normalizeCodebriefApiBaseUrl } from './api-url.js';
const OPERATIONS = new Set(['register', 'claim', 'renew', 'return', 'review', 'recover', 'brief']);
export const DEPENDENCY_BASE_REQUIRED_GUIDANCE = 'Run the installed Tandem claim command with input.json containing dependencyBase {branch, sha} matching the local Git branch and HEAD.';
export class TandemClientError extends Error {
    constructor(status, message) { super(message ?? `Tandem request failed (${status})`); this.status = status; }
}
export function validateBriefExpansionReferences(value) {
    if (!Array.isArray(value) || value.length > 10 || value.some(v => typeof v !== 'string' || !/^\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/atlas\/project$/i.test(v))) throw new TandemClientError(502);
    return [...value];
}
export class TandemBriefBudgetError extends TandemClientError {
    constructor(references) { super(422); this.code = 'required_brief_exceeds_budget'; this.expansionReferences = validateBriefExpansionReferences(references); }
}
export function validateTandemBriefResponse(brief, baseSha) {
    const keys = ['text','truncated','freshness','indexedSha','baseSha','actionVersion','contractDigest','expansionReferences'];
    if (!brief || Object.keys(brief).length !== keys.length || keys.some(k => !Object.hasOwn(brief,k)) || typeof brief.text !== 'string' || typeof brief.truncated !== 'boolean' || brief.baseSha !== baseSha || !Number.isSafeInteger(brief.actionVersion) || brief.actionVersion < 1 || !/^[a-f0-9]{64}$/.test(brief.contractDigest) || Array.from(brief.text).length > 9000 || Buffer.byteLength(brief.text) > 36000 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(brief.text)) throw new TandemClientError(502);
    const sha = brief.indexedSha;
    if (sha !== null && (typeof sha !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))) throw new TandemClientError(502);
    if (brief.freshness !== (sha === null ? 'missing' : sha === baseSha ? 'current' : 'stale')) throw new TandemClientError(502);
    return {...brief, expansionReferences:validateBriefExpansionReferences(brief.expansionReferences)};
}
async function request(url, options, fetchImpl, briefRequest = false, dependencyClaim = false) { const controller = new AbortController(); let timer; try {
    return await Promise.race([(async () => { const response = await fetchImpl(url, { ...options, signal: controller.signal }); if (!response.ok && !(briefRequest && response.status === 422) && !(dependencyClaim && response.status === 409))
            throw new TandemClientError(response.status); if (!response.body?.getReader)
            throw new TandemClientError(502); const reader = response.body.getReader(); let bytes = 0; const chunks = []; try {
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                bytes += value.byteLength;
                if (bytes > (response.ok ? 131072 : 8192)) {
                    void reader.cancel();
                    throw new TandemClientError(502);
                }
                chunks.push(value);
            }
            try {
                const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                if (!response.ok) {
                    if(dependencyClaim && response.status===409 && value && Object.keys(value).length===1 && value.error==='dependency_base_required') { const error=new TandemClientError(409,DEPENDENCY_BASE_REQUIRED_GUIDANCE);error.code='dependency_base_required';return Promise.reject(error); }
                    if (value && Object.keys(value).length === 2 && value.error === 'required_brief_exceeds_budget' && Object.hasOwn(value,'expansionReferences')) {
                        try { return Promise.reject(new TandemBriefBudgetError(value.expansionReferences)); } catch { /* Reject unsafe references without echoing the body. */ }
                    }
                    throw new TandemClientError(response.status);
                }
                return value;
            }
            catch {
                throw new TandemClientError(response.ok ? 502 : response.status);
            }
        }
        finally {
            reader.releaseLock();
        } })(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new TandemClientError(0)); }, 10000); })]);
}
finally {
    clearTimeout(timer);
} }
export async function tandemRequest({ apiBaseUrl, apiKey, repoFullName, operation, payload, credential, fetchImpl = fetch }) { if (!OPERATIONS.has(operation))
    throw new TypeError('Unsupported Tandem command'); if (!apiKey)
    throw new TandemClientError(401); const base = normalizeCodebriefApiBaseUrl(apiBaseUrl); const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}`, ...(credential ? { 'x-codebrief-tandem-credential': credential } : {}) }; let protocol; try {
    protocol = await request(`${base}/api/capture/tandem/register`, { method: 'GET', headers }, fetchImpl);
}
catch (e) {
    if (e.status === 404 || e.status === 405)
        throw new TandemClientError(e.status, 'Tandem protocol unsupported by this server; ordinary Capture remains available.');
    throw e;
} if (protocol.protocolVersion !== 1)
    throw new TandemClientError(426, 'Tandem protocol unsupported by this server'); return request(`${base}/api/capture/tandem/${operation}`, { method: 'POST', headers, body: JSON.stringify({ protocolVersion: 1, repo: { fullName: repoFullName }, ...payload }) }, fetchImpl, operation === 'brief', operation === 'claim'); }
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import { tandemNamespace } from './tandem-state.js';
import { withPrivateStateDirectory, readPrivateStateJson, writePrivateStateJson, withPrivateStateLock, withSubmissionLock } from './handoff-state.js';
import { validateHandoffResult } from './handoff-result.js';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function validateAuthorReceipt(v) { const keys = ['schemaVersion', 'attemptId', 'actionVersion', 'authorInstanceId', 'generation', 'baseSha', 'headSha', 'contractDigest', 'evidenceDigest']; if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k)) || v.schemaVersion !== 1 || !UUID.test(v.attemptId) || !UUID.test(v.authorInstanceId) || !Number.isSafeInteger(v.actionVersion) || v.actionVersion < 1 || !Number.isSafeInteger(v.generation) || v.generation < 1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.baseSha) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(v.headSha) || v.baseSha.length !== v.headSha.length || !/^[a-f0-9]{64}$/.test(v.contractDigest) || !/^[a-f0-9]{64}$/.test(v.evidenceDigest))
    throw new TypeError('Invalid author receipt'); return { ...v }; }
function checkedOutboxIndex(value) {
    const index = value ?? { pending: [], acknowledged: [] };
    if (!index || Object.keys(index).length !== 2 || !Array.isArray(index.pending) || !Array.isArray(index.acknowledged) || index.pending.length > 100 || [...index.pending, ...index.acknowledged].some(id => typeof id !== 'string' || !UUID.test(id)) || new Set([...index.pending, ...index.acknowledged]).size !== index.pending.length + index.acknowledged.length) throw new TypeError('Invalid Tandem outbox index');
    return index;
}
function outboxDirectory(identity, options, fn) { return withPrivateStateDirectory(`tandem/v2/${tandemNamespace(identity)}/outbox`, options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => fn(directoryPath, verify))); }
export function queueTandemResult(identity, value, options) { if (!UUID.test(value?.requestId) || Object.keys(value).some(k => !['requestId', 'claim', 'mutation', 'result', 'receipt'].includes(k)))
    throw new TypeError('Invalid result outbox'); const clean = { ...value, result: validateHandoffResult(value.result), receipt: validateAuthorReceipt(value.receipt) }; if (Buffer.byteLength(JSON.stringify(clean)) > 131072)
    throw new TypeError('Result outbox too large'); return outboxDirectory(identity, options, (directory, verify) => { const indexPath = join(directory, 'index.json'); const index = checkedOutboxIndex(readPrivateStateJson(indexPath, verify)); const path = join(directory, `${value.requestId}.json`); const prior = readPrivateStateJson(path, verify); if (prior && JSON.stringify(prior) !== JSON.stringify(clean))
    throw new TypeError('Result request changed'); if (!prior)
    writePrivateStateJson(path, clean, verify, { exclusive: true }); if (index.pending.includes(value.requestId) || index.acknowledged.includes(value.requestId))
    return; if (index.pending.length >= 100)
    throw new Error('Tandem outbox full; new result preserved on disk, explicit recovery required'); index.pending.push(value.requestId); writePrivateStateJson(indexPath, index, verify); }); }
export function readTandemOutbox(identity, options) { return outboxDirectory(identity, options, (directory, verify) => { const index = checkedOutboxIndex(readPrivateStateJson(join(directory, 'index.json'), verify)); const known = new Set([...index.pending, ...index.acknowledged]); const recovery = readdirSync(directory).filter(n => n.endsWith('.json') && UUID.test(n.slice(0, -5)) && !known.has(n.slice(0, -5))).map(n => readPrivateStateJson(join(directory, n), verify)); return { pending: index.pending.map(id => readPrivateStateJson(join(directory, `${id}.json`), verify)), recovery }; }); }
export function acknowledgeTandemResult(identity, requestId, options) { return outboxDirectory(identity, options, (directory, verify) => { const path = join(directory, 'index.json'); const index = checkedOutboxIndex(readPrivateStateJson(path, verify)); if (!index || !index.pending.includes(requestId))
    throw new Error('Unknown Tandem outbox receipt'); index.pending = index.pending.filter(id => id !== requestId); index.acknowledged.push(requestId); writePrivateStateJson(path, index, verify); }); }
import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { worktreeIdentity, migrateLegacyHandoff } from './tandem-state.js';
import { inspectScope, inspectReviewRevision, preflightReviewWorktree } from './tandem-scope.js';
import { writeCheckpoint, readCheckpoint, checkpointReady } from './tandem-checkpoint.js';
function readInput(path) { const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 131072)
        throw new TypeError('Invalid Tandem input file');
    try {
        return JSON.parse(readFileSync(fd, 'utf8'));
    }
    catch {
        throw new TypeError('Invalid bounded Tandem input JSON');
    }
}
finally {
    closeSync(fd);
} }
function localSession(worktreeId, options, operation) { return withPrivateStateDirectory('tandem/sessions', options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => operation({ load: () => readPrivateStateJson(join(directoryPath, `${worktreeId}.json`), verify), save: value => writePrivateStateJson(join(directoryPath, `${worktreeId}.json`), value, verify) }))); }
function checkedClaim(value) { const keys = ['attemptId', 'handoffId', 'actionId', 'actionVersion', 'instanceId', 'generation', 'version', 'leaseExpiresAt']; if (!value || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k)) || ['attemptId', 'handoffId', 'actionId', 'instanceId'].some(k => !UUID.test(value[k])) || ['actionVersion', 'generation', 'version'].some(k => !Number.isSafeInteger(value[k]) || value[k] < 1) || !Number.isFinite(Date.parse(value.leaseExpiresAt)))
    throw new TandemClientError(502, 'Invalid server claim'); return { ...value }; }
/** Only explicit invocations perform heartbeats; no timer, polling, or Capture hook calls this. */
async function runTandemCommandUnlocked(args, context) {
    const [command, path] = args;
    if (!['brief', 'claim', 'heartbeat', 'checkpoint', 'return', 'review', 'recover'].includes(command) || args.length > 2)
        throw new TypeError('usage: codebrief tandem brief|claim|heartbeat|checkpoint|return|review|recover [input.json]');
    const options = context.options, root = context.root ?? process.cwd(), worktreeId = (context.worktreeIdentity ?? worktreeIdentity)(root, options);
    const invoke = context.tandemRequest ?? tandemRequest;
    const input = path ? (context.readInput ?? readInput)(path) : {};
    const request = (operation, payload, credential) => session?.launchId ? launchRelayRequest({session,operation,payload,fetchImpl:context.fetchImpl}) : invoke({ ...context.credentials, repoFullName: context.repoFullName, operation, payload, credential });
    const load = () => localSession(worktreeId, options, s => s.load());
    const save = value => { context.beforeSessionSave?.(value); return localSession(worktreeId, options, s => s.save(value)); };
    let session = load();
    if (command === 'brief') {
        if (Object.keys(input).some(k=>!['handoffId','baseSha'].includes(k))) throw new TypeError('brief requires only handoffId/baseSha');
        const handoffId=input.handoffId ?? session?.claim?.handoffId;
        if (!UUID.test(handoffId)) throw new TypeError('brief requires handoffId');
        const ref=input.baseSha ?? 'HEAD';
        if (ref !== 'HEAD' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(ref)) throw new TypeError('invalid baseSha');
        const baseSha=(context.resolveBriefBase ?? ((value)=>execFileSync('git',['-C',root,'rev-parse','--verify',`${value}^{commit}`],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:65536,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'}}).trim()))(ref);
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha) || (ref!=='HEAD' && ref!==baseSha)) throw new TypeError('baseSha unavailable');
        const brief=validateTandemBriefResponse(await request(command,{handoffId,baseSha},session?.credential),baseSha);
        const localCheckpointReferences=[];
        if (session?.claim?.handoffId===handoffId && session.credential && session.identity) {
            const verification=await request('register',{verify:{claim:session.claim,workspaceId:worktreeId}},session.credential);
            if (verification?.ownershipVerified===true) {
                const identity={...session.identity,worktreeId,attemptId:session.claim.attemptId};
                const checkpoint=readCheckpoint(identity,options);
                if (checkpoint && checkpoint.actionId===session.claim.actionId && checkpoint.generation===session.claim.generation && checkpoint.contractVersion===brief.actionVersion && checkpoint.baseSha===baseSha) localCheckpointReferences.push({namespace:tandemNamespace(identity),kind:'local_checkpoint'});
            }
        }
        return {...brief,localCheckpointReferences};
    }
    if (command === 'review') {
        if (input.phase === 'claim') {
            const {host,phase,...claimInput} = input;
            if (!['claude','codex','cursor'].includes(host) || Object.keys(claimInput).some(k=>!['attemptId','requestId','expectedActionVersion'].includes(k))) throw new TypeError('review claim requires host and exact author attempt');
            await (context.preflightReviewWorktree??preflightReviewWorktree)(root);
            if (session?.claim) throw new Error('Existing worktree attempt requires hosted resolution; use a separate review worktree');
            if (!session) {
                const registered = await request('register',{workspaceId:worktreeId,host});
                if (!registered?.identity || ['accountId','orgId','repoId'].some(k=>!UUID.test(registered.identity[k])) || !UUID.test(registered.instanceId) || !/^[A-Za-z0-9_-]{43}$/.test(registered.credential)) throw new TandemClientError(502,'Invalid registration');
                session={...registered,worktreeId}; save(session);
            }
            if (!session.pendingReviewClaim) {session={...session,pendingReviewClaim:{phase,...claimInput}};save(session);}
            const response=await request('review',session.pendingReviewClaim,session.credential);
            session={...session,claim:checkedClaim(response.claim),reviewRevision:response.revision}; delete session.pendingReviewClaim;
            session.identity={...session.identity,worktreeId,attemptId:session.claim.attemptId}; save(session);
            await (context.inspectReviewRevision??inspectReviewRevision)(root,session.reviewRevision);
            return {claim:session.claim,revision:session.reviewRevision};
        }
        if (input.phase !== 'submit' || !session?.claim || !session.reviewRevision) throw new Error('review submit requires authenticated isolated review claim');
        if (session.pendingRenewal || session.pendingRecovery) throw new Error('Pending mutation requires replay or recovery');
        const verified=await request('register',{verify:{claim:session.claim,workspaceId:worktreeId}},session.credential);
        if (!session.pendingReview && verified.ownershipVerified !== true) throw new Error('Review ownership is no longer current');
        await (context.inspectReviewRevision??inspectReviewRevision)(root,session.reviewRevision);
        const receipt=input.receipt;
        const frozen=session.reviewRevision;
        if (!receipt || receipt.reviewerInstanceId !== session.instanceId || receipt.evidenceSource !== 'agent_reported' || !['approved','changes_requested'].includes(receipt.verdict) || ['attemptId','actionVersion','authorInstanceId','baseSha','headSha','contractDigest','evidenceDigest','schemaVersion'].some(k=>receipt[k] !== frozen[k])) throw new Error('Review receipt differs from frozen author revision');
        if (!session.pendingReview) { session={...session,pendingReview:{phase:'submit',receipt,mutation:{requestId:randomUUID(),expectedVersion:session.claim.version,generation:session.claim.generation}}}; save(session); }
        else if (JSON.stringify(session.pendingReview.receipt) !== JSON.stringify(receipt)) throw new Error('Pending review requires exact replay');
        const response=await request('review',session.pendingReview,session.credential);
        session={...session,reviewId:response.reviewId}; delete session.pendingReview; save(session);
        return response;
    }
    if (command === 'claim') {
        if (session?.claim) {
            if (session.pendingRenewal || session.pendingRecovery) throw new Error('Pending Tandem mutation requires heartbeat or recovery');
            const status = await request('register', { verify: { claim: session.claim, workspaceId: worktreeId } }, session.credential);
            if (status.terminalClosed !== true) throw new Error('Existing Tandem attempt requires hosted resolution');
            session = { ...session }; delete session.claim; delete session.proposalId;
            save(session);
        }
        const { host, ...claimInput } = input;
        if (claimInput.dependencyBase !== undefined) {
            const base=claimInput.dependencyBase;
            if (!base || Object.keys(base).sort().join()!=='branch,sha' || typeof base.branch!=='string' || !/^[0-9a-f]{40}$/.test(base.sha)) throw new TypeError('Invalid dependencyBase');
            const actual=(context.resolveDependencyBase ?? (()=>({branch:execFileSync('git',['-C',root,'symbolic-ref','--quiet','--short','HEAD'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:65536,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'}}).trim(),sha:execFileSync('git',['-C',root,'rev-parse','--verify','HEAD^{commit}'],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:5000,maxBuffer:65536,env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'}}).trim()})))();
            if (actual.branch!==base.branch || actual.sha!==base.sha) throw new Error('dependencyBase must match actual local Git branch and HEAD');
        }
        if (!['claude', 'codex', 'cursor'].includes(host))
            throw new TypeError('claim requires host');
        if (!session) {
            const registered = await request('register', { workspaceId: worktreeId, host });
            if (!registered?.identity || ['accountId', 'orgId', 'repoId'].some(k => !UUID.test(registered.identity[k])) || !UUID.test(registered.instanceId) || !/^[A-Za-z0-9_-]{43}$/.test(registered.credential))
                throw new TandemClientError(502, 'Invalid registration');
            session = { ...registered, worktreeId, canonicalScope: claimInput.canonicalScope };
            save(session);
        }
        const response = await request('claim', { ...claimInput, instanceId: session.instanceId }, session.credential);
        session = { ...session, claim: checkedClaim(response.claim), canonicalScope: claimInput.canonicalScope };
        session.identity = { ...session.identity, worktreeId, attemptId: session.claim.attemptId };
        save(session);
        return { claim: session.claim };
    }
    if (!session?.claim)
        throw new Error('No authenticated Tandem attempt for this worktree');
    const mutation = () => ({ requestId: randomUUID(), expectedVersion: session.claim.version, generation: session.claim.generation });
    async function replayRenewal() {
        const response = await request('renew', session.pendingRenewal, session.credential);
        const next = { ...session, claim: checkedClaim(response.claim) }; delete next.pendingRenewal;
        save(next); session = next;
    }
    if (command === 'heartbeat') {
        if (session.pendingRecovery) throw new Error('Pending recovery requires recovery replay');
        if (!session.pendingRenewal) { session = { ...session, pendingRenewal: { claim: session.claim, mutation: mutation() } }; save(session); }
        await replayRenewal();
        return { claim: session.claim };
    }
    if (session.pendingRenewal) {
        if (command !== 'recover') throw new Error('Pending renewal requires heartbeat replay');
    }
    if (command === 'recover') {
        if (session.launchId && !session.pendingRecovery && input.disposition !== 'resume') throw new Error('Launch recovery supports resume only; replacement requires a separately authorized new launch');
        if (!session.pendingRecovery) {
            session = { ...session, pendingRecovery: { ...input, ...(session.pendingRenewal ? {pendingRenewal:session.pendingRenewal} : {}), attemptId: session.claim.attemptId, expectedVersion: session.claim.version, requestId: randomUUID() } };
            save(session);
        }
        const response = await request('recover', session.pendingRecovery, session.credential);
        if (session.launchId ? response.credential !== session.credential : !/^[A-Za-z0-9_-]{43}$/.test(response.credential))
            throw new TandemClientError(502);
        session = { ...session, claim: checkedClaim(response.claim), credential: response.credential };
        delete session.pendingRecovery;
        delete session.pendingRenewal;
        session.identity = { ...session.identity, attemptId: session.claim.attemptId };
        save(session);
        return { claim: session.claim };
    }
    if (command === 'checkpoint') {
        let ownershipVerified = false;
        try {
            const response = await request('register', { verify: { claim: session.claim, workspaceId: worktreeId } }, session.credential);
            ownershipVerified = response.ownershipVerified === true;
        }
        catch { }
        const inspection = await (context.inspectScope ?? inspectScope)(root, input.baseSha, session.canonicalScope);
        const checkpoint = { ...input, schemaVersion: 1, namespace: tandemNamespace(session.identity), actionId: session.claim.actionId, attemptId: session.claim.attemptId, generation: session.claim.generation, contractVersion: session.claim.actionVersion, headSha: inspection.headSha, dirty: inspection.dirty ?? [], untracked: inspection.untracked ?? [], clean: inspection.clean, scopeViolations: inspection.violations, ownershipVerified };
        await writeCheckpoint(session.identity, checkpoint, options);
        await migrateLegacyHandoff(session.identity, context.repoFullName, async ({ identity, handoffId }) => ownershipVerified && identity.worktreeId === worktreeId && session.claim.handoffId === handoffId, options);
        return { ready: checkpointReady(checkpoint) };
    }
    const checkpoint = readCheckpoint(session.identity, options);
    const inspection = await (context.inspectScope ?? inspectScope)(root, checkpoint?.baseSha, session.canonicalScope);
    if (!checkpointReady(checkpoint) || !inspection.clean || inspection.headSha !== checkpoint.headSha || checkpoint.generation !== session.claim.generation)
        throw new Error('Tandem return requires a current clean verified checkpoint');
    const receipt = validateAuthorReceipt(input.receipt), result = validateHandoffResult(input.result);
    if (receipt.attemptId !== session.claim.attemptId || receipt.authorInstanceId !== session.claim.instanceId || receipt.generation !== session.claim.generation || receipt.baseSha !== checkpoint.baseSha || receipt.headSha !== checkpoint.headSha)
        throw new Error('Author receipt differs from checkpoint');
    const existing = [...readTandemOutbox(session.identity, options).pending, ...readTandemOutbox(session.identity, options).recovery].find(v => JSON.stringify(v.result) === JSON.stringify(result) && JSON.stringify(v.receipt) === JSON.stringify(receipt));
    const item = existing ?? { requestId: randomUUID(), claim: session.claim, mutation: mutation(), result, receipt };
    item.mutation.requestId = item.requestId;
    queueTandemResult(session.identity, item, options);
    const response = await request('return', { claim: item.claim, mutation: item.mutation, result: item.result, receipt: item.receipt }, session.credential);
    session = { ...session, claim: checkedClaim(response.claim), proposalId: response.proposalId };
    save(session);
    acknowledgeTandemResult(session.identity, item.requestId, options);
    return { claim: session.claim, proposalId: session.proposalId };
}
export async function runTandemCommand(args, context) { const worktreeId = (context.worktreeIdentity ?? worktreeIdentity)(context.root ?? process.cwd(), context.options); const binding = tandemNamespace({ accountId: 'session-lock', orgId: 'session-lock', repoId: 'session-lock', worktreeId, attemptId: 'session-lock' }).slice(0, 32); const id = `${binding.slice(0, 8)}-${binding.slice(8, 12)}-4${binding.slice(13, 16)}-8${binding.slice(17, 20)}-${binding.slice(20)}`; const result = await withSubmissionLock(id, () => runTandemCommandUnlocked(args, { ...context, worktreeIdentity: () => worktreeId }), context.options); if (result?.status === 'skipped:in-flight')
    throw new Error('Tandem command in flight; retry'); return result; }

export function readConductorSession(root,options){return localSession(worktreeIdentity(root,options),options,s=>s.load());}
export function installConductorSession(root,value,options){const id=worktreeIdentity(root,options);return localSession(id,options,s=>{const prior=s.load();if(prior&&(!prior.launchId||prior.launchId!==value.launchId))throw new Error("Existing Capture worktree binding requires separate worktree");if(prior){if(prior.claim?.attemptId!==value.claim?.attemptId||prior.claim?.instanceId!==value.claim?.instanceId||prior.claim?.generation<value.claim?.generation||prior.credential!==value.credential||prior.workspaceId!==value.workspaceId||prior.sessionId!==value.sessionId)throw new Error("Existing launch Capture binding differs");if(prior.claim.generation===value.claim.generation&&prior.claim.version<value.claim.version&&!prior.pendingRenewal&&!prior.pendingRecovery){const updated={...prior,claim:value.claim};s.save(updated);return updated;}return prior;}const installed={...value,worktreeId:id,identity:{...value.identity,worktreeId:id,attemptId:value.claim.attemptId}};s.save(installed);return installed;});}
