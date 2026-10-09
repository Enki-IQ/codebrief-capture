import {parseRoomCommand,executeRoomCommand} from './room-discussion.js';
import {readRoomToolInput} from './room-tools.js';
import {readAgentMessageInput} from './agent-inbox.js';
import {launchRelayRequest} from './conductor-bootstrap.js';
import { randomUUID, randomBytes } from 'node:crypto';
import { normalizeCodebriefApiBaseUrl } from './api-url.js';
import { localConnectionKey, loadConnectedState, runtimeNamespace, updateCompanion, loadCompanion, saveFencedConnectedState, preserveNativeReceipt } from './connected-agent-state.js';
import { observeNative, createOwnedThread } from './native-agent-runtime.js';
import { readConductorSession } from './tandem-client.js';
import { withSubmissionLock } from './handoff-state.js';
import { worktreeIdentity } from './tandem-state.js';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
export class ConnectedAgentClientError extends Error {
    constructor(code = 'connected_agent_unavailable') { super(code); this.code = code; }
}

function requireCompanion(context) {
 if(!context.companion)return;
 const current=loadCompanion(context.companion.key,context.options);
 if(!current||current.id!==context.companion.id||current.generation!==context.companion.generation||current.active!==context.companion.active)throw new ConnectedAgentClientError('companion_stale');
}
function companionWire(context) { return context.companion?{id:context.companion.id,generation:context.companion.generation}:undefined; }
function saveState(key,state,context) { try{requireCompanion(context);return saveFencedConnectedState(key,state,context.options,context.companion,context.legacyEpoch);}catch(error){preserveNativeReceipt(key,state,context.options);throw error;} }
function acquireCompanion(key,context) {
 const state=loadConnectedState(key,context.options);if(!state?.runtimeId)throw new ConnectedAgentClientError('runtime_not_connected');
 const owner=updateCompanion(key,context.options,current=>{
  if(current?.active){let live=true;try{process.kill(current.pid,0);}catch(error){if(error.code==='ESRCH')live=false;}if(live)throw new ConnectedAgentClientError('companion_in_flight');}
  const generation=(current?.generation??0)+1;if(!Number.isSafeInteger(generation))throw new ConnectedAgentClientError('companion_unavailable');
  return{id:randomUUID(),generation,pid:process.pid,active:true,runtimeId:state.runtimeId};
 });return{...owner,key};
}
function invalidateCompanion(key,context) {
 const owner=updateCompanion(key,context.options,(current,writeState,readState)=>{
  if(context.companion&&(current?.id!==context.companion.id||current?.generation!==context.companion.generation||!current.active))throw new ConnectedAgentClientError('companion_stale');
  const generation=context.companion?current.generation:(current?.generation??0)+1;if(!Number.isSafeInteger(generation))throw new ConnectedAgentClientError('companion_unavailable');
  const state=readState();if(state)writeState({...state,paused:true});
  return{...current,id:context.companion?current.id:randomUUID(),generation,active:false,pid:process.pid};
 });context.companion={...owner,key};context.companionReady=true;context.invalidate=!context.processTeardown;
}
async function request(context, path, body, state) { const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(10000, (context.deadline ?? Date.now() + 10000) - Date.now()))); try {
    requireCompanion(context);
    const response = await (context.fetchImpl ?? fetch)(`${normalizeCodebriefApiBaseUrl(context.credentials.apiBaseUrl)}/api/capture/${path.startsWith('rooms/')?path:'connected-agents/'+path}`, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { authorization: `Bearer ${context.credentials.apiKey}`, 'content-type': 'application/json', ...(state ? { 'x-codebrief-runtime-credential': state.nonce } : {}), ...(body.claim ? { 'x-codebrief-tandem-credential': context.tandemCredential } : {}) }, body: JSON.stringify({ repo: { fullName: context.repoFullName }, ...body, ...(context.companion&&(path==='sessions'||context.companionReady)?{companion:companionWire(context)}:{}), ...(context.invalidate?{invalidate:true}:{}) }) });
    if (!response.ok)
        throw new ConnectedAgentClientError('connected_agent_rejected');
    const reader = response.body?.getReader();
    if (!reader)
        throw new ConnectedAgentClientError();
    let bytes = 0;
    const chunks = [];
    try {
        while (true) {
            const part = await reader.read();
            if (part.done)
                break;
            bytes += part.value.length;
            if (bytes > (path.startsWith('rooms/tools/')?262144:path.startsWith('rooms/')?102400:['inbox','request','ack','reply'].includes(path)?131072:32768)) {
                await reader.cancel();
                throw new ConnectedAgentClientError();
            }
            chunks.push(part.value);
        }
    }
    finally {
        reader.releaseLock();
    }
    requireCompanion(context);
    return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}
catch (error) {
    if (error instanceof ConnectedAgentClientError)
        throw error;
    throw new ConnectedAgentClientError();
}
finally {
    clearTimeout(timer);
} }
async function runAgentsCommandUnlocked(args, context) {
    const [command, ...rest] = args, option = name => { const i = rest.indexOf(name); return i < 0 ? null : rest[i + 1]; }, provider = option('--provider');
    if (!['claude', 'codex'].includes(provider))
        throw new ConnectedAgentClientError('native_provider_required');
    if (!context.credentials?.apiKey)
        throw new ConnectedAgentClientError('capture_login_required');
    const key = localConnectionKey(context.credentials.apiKey, provider), options = context.options;
    let state = loadConnectedState(key, options);
    if (command === 'connect' && provider === 'codex' && rest.includes('--login'))
        throw new ConnectedAgentClientError('native_login_required');
    if (command === 'connect') {
        const pairingId = option('--pairing');
        if (!UUID.test(pairingId ?? ''))
            throw new ConnectedAgentClientError('pairing_required');
        if (state?.pairingId !== pairingId) {
            state = { pairingId, requestId: randomUUID(), nonce: randomBytes(32).toString('base64url'), provider };
            saveState(key, state, context);
        }
        const response = await request(context, 'exchange', { pairingId, requestId: state.requestId, nonce: state.nonce });
        if (!response || Object.keys(response).sort().join(',')!=='expiresAt,identity,runtimeId'||!response.identity||Object.keys(response.identity).sort().join(',')!=='accountId,orgId'||!UUID.test(response.runtimeId ?? '') || !UUID.test(response.identity?.accountId ?? '') || !UUID.test(response.identity?.orgId ?? '') || !Number.isFinite(Date.parse(response.expiresAt)))
            throw new ConnectedAgentClientError('exchange_receipt_invalid');
        state = { ...state, runtimeId:response.runtimeId,expiresAt:response.expiresAt,identity: {accountId:response.identity.accountId,orgId:response.identity.orgId, provider, runtimeId: response.runtimeId } };
        runtimeNamespace(state.identity);
        saveState(key, state, context);
        const observation = await observeNative(provider);
        await request(context, 'observe', { runtimeId: state.runtimeId, observation }, state);
        return { runtimeId: state.runtimeId, observation };
    }
    if (!state?.runtimeId || state.provider !== provider)
        throw new ConnectedAgentClientError('runtime_not_connected');
    if (['inbox','request','ack','reply','tool','rooms'].includes(command)) {
        const session=readConductorSession(context.root??process.cwd(),options);
        if(!session?.claim||session.identity.accountId!==state.identity.accountId||session.identity.orgId!==state.identity.orgId||session.identity.worktreeId!==worktreeIdentity(context.root??process.cwd(),options))throw new ConnectedAgentClientError('current_claim_required');
        const discussion=command==='rooms'?parseRoomCommand(args):undefined;
        const tool=command==='tool'?readRoomToolInput(option('--input')):undefined;
        const input=command==='inbox'||tool||discussion?undefined:readAgentMessageInput(command,option('--input'));
        const cursor=option('--cursor');if(cursor&&!discussion&&!UUID.test(cursor))throw new ConnectedAgentClientError('cursor_invalid');
        if(discussion){
          const transport=()=>session.launchId?launchRelayRequest({session,operation:'room_'+discussion.operation,payload:{claim:session.claim,roomId:discussion.roomId,input:discussion.input},fetchImpl:context.fetchImpl}):request({...context,tandemCredential:session.credential},'rooms/'+discussion.operation,{runtimeId:state.runtimeId,sessionId:state.startups?.[JSON.stringify([session.claim.attemptId,session.claim.instanceId,session.claim.generation])]?.sessionId,claim:session.claim,workspaceId:session.workspaceId??session.identity.worktreeId,roomId:discussion.roomId,input:discussion.input},state);
          if(!session.launchId){
            const startup=state.startups?.[JSON.stringify([session.claim.attemptId,session.claim.instanceId,session.claim.generation])];
            if(state.paused||startup?.phase!=='registered'||!startup.nativeSessionId)throw new ConnectedAgentClientError('session_unavailable');
            if(context.hookSessionId&&startup.nativeSessionId!==context.hookSessionId)throw new ConnectedAgentClientError('checkpoint_session_conflict');
          }
          return executeRoomCommand(discussion,transport);
        }
        if(session.launchId)return launchRelayRequest({session,operation:tool?'room_tool':command,payload:{claim:session.claim,...(tool?{tool}:command==='inbox'?{cursor:cursor??null}:{input})},fetchImpl:context.fetchImpl});
        const startup=state.startups?.[JSON.stringify([session.claim.attemptId,session.claim.instanceId,session.claim.generation])];
        if(state.paused)throw new ConnectedAgentClientError('session_unavailable');
        if(startup?.phase!=='registered'||!startup.nativeSessionId)throw new ConnectedAgentClientError(context.hookSessionId&&!startup?'checkpoint_session_required':'session_unavailable');
        if(context.hookSessionId&&startup.nativeSessionId!==context.hookSessionId)throw new ConnectedAgentClientError('checkpoint_session_conflict');
        return request({...context,tandemCredential:session.credential},tool?'rooms/tools/'+tool.operation:command,{runtimeId:state.runtimeId,sessionId:startup.sessionId,claim:session.claim,workspaceId:session.workspaceId??session.identity.worktreeId,...(tool?{roomId:tool.roomId,...(tool.operation==='invoke'?{input:tool.input}:{operationId:tool.operationId})}:command==='inbox'?{...(cursor?{cursor}:{}),...(context.hookSessionId?{nativeSessionId:context.hookSessionId}:{})}:{input})},state);
    }
    if (command === 'status') {
        const observation = await observeNative(provider);
        await request(context, 'observe', { runtimeId: state.runtimeId, observation }, state);
        return { runtimeId: state.runtimeId, observation };
    }
    if (command === 'stop' || command === 'disconnect') {
        state.paused = true;
        saveState(key, state, context);
        await request(context, 'observe', { runtimeId: state.runtimeId, operation: command === 'stop' ? 'pause' : 'disconnect' }, state);
        return { runtimeId: state.runtimeId, availability: command === 'stop' ? 'paused' : 'disconnected' };
    }
    if (command === 'serve' || command === 'checkpoint' || command === 'heartbeat') {
        const mode = command === 'checkpoint' ? 'checkpoint' : option('--mode');
        if ((provider === 'codex' && mode !== 'owned-thread') || (provider === 'claude' && mode !== 'checkpoint'))
            throw new ConnectedAgentClientError('delivery_mode_invalid');
        const nativeObservation = await observeNative(provider, command === 'checkpoint' ? 2000 : 10000);
        if (nativeObservation.authState !== 'signed_in')
            throw new ConnectedAgentClientError('native_login_required');
        await request(context, 'observe', { runtimeId: state.runtimeId, observation: nativeObservation }, state);
        const session = readConductorSession(context.root ?? process.cwd(), options);
        if (!session?.claim || session.identity.accountId !== state.identity.accountId || session.identity.orgId !== state.identity.orgId || session.identity.worktreeId !== worktreeIdentity(context.root ?? process.cwd(), options))
            throw new ConnectedAgentClientError('current_claim_required');
        context = { ...context, tandemCredential: session.credential };
        const binding = { runtimeId: state.runtimeId, claim: session.claim, workspaceId: session.workspaceId ?? session.identity.worktreeId };
        if (command === 'checkpoint' && provider !== 'claude')
            throw new ConnectedAgentClientError('checkpoint_provider_invalid');
        const startupKey = JSON.stringify([session.claim.attemptId, session.claim.instanceId, session.claim.generation]);
        let startup = state.startups?.[startupKey];
        if (provider === 'claude') {
            if (command === 'checkpoint') {
                if (typeof context.hookSessionId !== 'string' || !context.hookSessionId || context.hookSessionId.length > 255 || /[\x00-\x1f\x7f]/.test(context.hookSessionId))
                    throw new ConnectedAgentClientError('checkpoint_session_required');
                if (startup?.nativeSessionId && startup.nativeSessionId !== context.hookSessionId)
                    throw new ConnectedAgentClientError('checkpoint_session_conflict');
            }
            else if (startup?.phase !== 'registered')
                throw new ConnectedAgentClientError('checkpoint_session_required');
        }
        if (command === 'heartbeat' && (state.paused || startup?.phase !== 'registered'))
            throw new ConnectedAgentClientError('session_unavailable');
        const admission = command === 'heartbeat' ? { sessionId: startup.sessionId, createAllowed: false } : await request(context, 'sessions', { operation: 'admit', ...binding, mode: mode === 'owned-thread' ? 'owned_thread' : 'checkpoint', label: 'Task session', ...(command === 'serve' ? { resume: true } : {}) }, state);
        if(context.companion)context.companionReady=true;
        if(!UUID.test(admission.sessionId??'')||typeof admission.createAllowed!=='boolean'||(startup&&admission.sessionId!==startup.sessionId))throw new ConnectedAgentClientError('session_receipt_invalid');
        if (!startup) {
            startup = { sessionId: admission.sessionId, phase: 'issued', nativeSessionId: null };
            state = { ...state, startups: { ...state.startups, [startupKey]: startup } };
            saveState(key, state, context);
            if (provider === 'codex') {
                if (admission.createAllowed !== true)
                    throw new ConnectedAgentClientError('native_create_unknown');
                try {
                    startup.nativeSessionId = await createOwnedThread();
                }
                catch {
                    startup.phase = 'unknown';
                    saveState(key, state, context);
                    throw new ConnectedAgentClientError('native_create_unknown');
                }
            }
            else {
                const nativeSessionId = context.hookSessionId;
                if (command !== 'checkpoint' || typeof nativeSessionId !== 'string' || !nativeSessionId || nativeSessionId.length > 255 || /[\x00-\x1f]/.test(nativeSessionId))
                    throw new ConnectedAgentClientError('checkpoint_session_required');
                startup.nativeSessionId = nativeSessionId;
            }
            startup.phase = 'created';
            saveState(key, state, context);
        }
        if (!startup.nativeSessionId)
            throw new ConnectedAgentClientError('native_create_unknown');
        const registered=await request(context, 'sessions', { operation: 'register', ...binding, sessionId: startup.sessionId, nativeSessionId: startup.nativeSessionId }, state);if(registered.sessionId!==startup.sessionId||registered.registered!==true)throw new ConnectedAgentClientError('session_receipt_invalid');
        startup.phase = 'registered';
        if (command !== 'heartbeat')
            state.paused = false;
        saveState(key, state, context);
        return { runtimeId: state.runtimeId, sessionId: startup.sessionId, mode, availability: provider === 'claude' ? 'checkpoint_wait' : 'ready' };
    }
    throw new ConnectedAgentClientError('agents_command_invalid');
}
export async function runAgentsCommand(args, context) {
 const providerIndex=args.indexOf('--provider');
 if(args[providerIndex+1]==='conductor'){
  if(!['inbox','request','ack','reply','tool','rooms'].includes(args[0]))throw new ConnectedAgentClientError('agents_command_invalid');
  const session=readConductorSession(context.root??process.cwd(),context.options);if(!session?.launchId||!session.claim||!session.credential)throw new ConnectedAgentClientError('current_claim_required');
  if(args[0]==='rooms'){const command=parseRoomCommand(args);return executeRoomCommand(command,()=>launchRelayRequest({session,operation:'room_'+command.operation,payload:{claim:session.claim,roomId:command.roomId,input:command.input},fetchImpl:context.fetchImpl}));}
  const option=name=>args[args.indexOf(name)+1];const cursor=args.includes('--cursor')?option('--cursor'):null;if(cursor&&!UUID.test(cursor))throw new ConnectedAgentClientError('cursor_invalid');
  const tool=args[0]==='tool'?readRoomToolInput(option('--input')):undefined;
  const input=args[0]==='inbox'||tool?undefined:readAgentMessageInput(args[0],option('--input'));
  return launchRelayRequest({session,operation:tool?'room_tool':args[0],payload:{claim:session.claim,...(tool?{tool}:args[0]==='inbox'?{cursor}:{input})},fetchImpl:context.fetchImpl});
 }
 const i=args.indexOf('--provider'),provider=args[i+1];if(!context.credentials?.apiKey||!['claude','codex'].includes(provider))throw new ConnectedAgentClientError('capture_login_and_provider_required');
 const key=localConnectionKey(context.credentials.apiKey,provider),id=`${key.slice(0,8)}-${key.slice(8,12)}-4${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`;
 const lifetime=args[0]==='serve'&&!args.includes('--once');
 if(lifetime&&!context.companion)context.companion=acquireCompanion(key,context);
 if(args[0]==='stop'||args[0]==='disconnect')invalidateCompanion(key,context);
 requireCompanion(context);
 const owner=loadCompanion(key,context.options);context.legacyEpoch=owner;if(!context.companion&&owner?.active&&['serve','heartbeat','connect'].includes(args[0]))throw new ConnectedAgentClientError('companion_in_flight');
 try {
  const result=context.companion?await runAgentsCommandUnlocked(args,context):await withSubmissionLock(id,()=>runAgentsCommandUnlocked(args,context),context.options);
  if(result?.status==='skipped:in-flight')throw new ConnectedAgentClientError('runtime_command_in_flight');
  if(lifetime)context.companionReady=true;
  return result;
 } catch(error) {
  if(lifetime&&context.companion)updateCompanion(key,context.options,current=>current?.id===context.companion.id&&current.generation===context.companion.generation?{...current,active:false}:undefined);
  throw error;
 }
}
export async function readCheckpointInput(stream = process.stdin) { return new Promise((resolve, reject) => { let bytes = 0; const chunks = []; const finish = (error, value) => { clearTimeout(timer); stream.removeListener('data', data); stream.removeListener('end', end); stream.removeListener('error', failed); stream.pause(); error ? reject(new ConnectedAgentClientError('checkpoint_input_invalid')) : resolve(value); }; const failed = () => finish(true); const data = chunk => { bytes += Buffer.byteLength(chunk); if (bytes > 16384)
    return failed(); chunks.push(Buffer.from(chunk)); }; const end = () => { try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    if (!value || Array.isArray(value) || typeof value.session_id !== 'string' || !value.session_id || value.session_id.length > 255 || /[\x00-\x1f\x7f]/.test(value.session_id))
        return failed();
    finish(false, value.session_id);
}
catch {
    failed();
} }; const timer = setTimeout(failed, 1000); stream.on('data', data); stream.once('end', end); stream.once('error', failed); }); }
export async function maintainAgentPresence(args, context) { const i = args.indexOf('--provider'), provider = args[i + 1], key = localConnectionKey(context.credentials.apiKey, provider); let stopped = false, delay = 5000, wake = null; const stop = () => { stopped = true; wake?.(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); try {
    while (!stopped) {
        await new Promise(resolve => { const timer = setTimeout(() => { wake = null; resolve(); }, delay); wake = () => { clearTimeout(timer); wake = null; resolve(); }; });
        if (stopped)
            break;
        const state = loadConnectedState(key, context.options);
        try{requireCompanion(context);}catch{break;}
        if (!state || state.paused)
            break;
        try {
            await runAgentsCommand(['heartbeat', '--provider', provider, '--mode', args[args.indexOf('--mode') + 1]], context);
            delay = 5000;
        }
        catch {
            delay = Math.min(60000, Math.ceil(delay * 1.7 + Math.random() * 1000));
        }
    }
}
finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (stopped) {
        try {
            await runAgentsCommand(['stop', '--provider', provider], {...context,processTeardown:true});
        }
        catch { /* Local shutdown never invents remote cancellation. */ }
    }
} }
