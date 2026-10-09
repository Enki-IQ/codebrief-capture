import {realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {parseRoomCommand,executeRoomCommand} from './room-discussion.js';
import {readRoomToolInput,validateRoomToolResponse} from './room-tools.js';
import {readAgentMessageInput} from './agent-inbox.js';
import {launchRelayRequest} from './conductor-bootstrap.js';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { normalizeCodebriefApiBaseUrl } from './api-url.js';
import { localConnectionKey, loadConnectedState, runtimeNamespace, updateCompanion, loadCompanion, saveFencedConnectedState, preserveNativeReceipt, createNativeEffectJournal } from './connected-agent-state.js';
import {createNativeTurnAdapter} from './native-turn-adapter.js';
import {createNativeTurnConsumer} from './native-turn-consumer.js';
import { observeNative, createBoundOwnedThread, readBoundOwnedThread, verifyOwnedThreadProtocol } from './native-agent-runtime.js';
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
            if(provider==='codex')await readBoundOwnedThread(startup.threadBinding);
          }
          return executeRoomCommand(discussion,transport);
        }
        if(session.launchId){const result=await launchRelayRequest({session,operation:tool?'room_tool':command,payload:{claim:session.claim,...(tool?{tool}:command==='inbox'?{cursor:cursor??null}:{input})},fetchImpl:context.fetchImpl});return tool?validateRoomToolResponse(result):result;}
        const startup=state.startups?.[JSON.stringify([session.claim.attemptId,session.claim.instanceId,session.claim.generation])];
        if(state.paused)throw new ConnectedAgentClientError('session_unavailable');
        if(startup?.phase!=='registered'||!startup.nativeSessionId)throw new ConnectedAgentClientError(context.hookSessionId&&!startup?'checkpoint_session_required':'session_unavailable');
        if(context.hookSessionId&&startup.nativeSessionId!==context.hookSessionId)throw new ConnectedAgentClientError('checkpoint_session_conflict');
        if(provider==='codex')await readBoundOwnedThread(startup.threadBinding);
        const result=await request({...context,tandemCredential:session.credential},tool?'rooms/tools/'+tool.operation:command,{runtimeId:state.runtimeId,sessionId:startup.sessionId,claim:session.claim,workspaceId:session.workspaceId??session.identity.worktreeId,...(tool?{roomId:tool.roomId,...(tool.operation==='invoke'?{input:tool.input}:{operationId:tool.operationId})}:command==='inbox'?{...(cursor?{cursor}:{}),...(context.hookSessionId?{nativeSessionId:context.hookSessionId}:{})}:{input})},state);return tool?validateRoomToolResponse(result):result;
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
        const ownedThread=provider==='codex'?{cwd:realpathSync(execFileSync('git',['-C',context.root??process.cwd(),'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim()),worktreeId:session.identity.worktreeId,protocolVersion:await verifyOwnedThreadProtocol()}:undefined;
        const binding = { runtimeId: state.runtimeId, claim: session.claim, workspaceId: session.workspaceId ?? session.identity.worktreeId };
        if (command === 'checkpoint' && provider !== 'claude')
            throw new ConnectedAgentClientError('checkpoint_provider_invalid');
        const startupKey = JSON.stringify([session.claim.attemptId, session.claim.instanceId, session.claim.generation]);
        let startup = state.startups?.[startupKey];
        if(ownedThread&&startup&&JSON.stringify(startup.ownedThread)!==JSON.stringify(ownedThread))throw new ConnectedAgentClientError('native_session_conflict');
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
        const admission = command === 'heartbeat' ? { sessionId: startup.sessionId, createAllowed: false } : await request(context, 'sessions', { operation: 'admit', ...binding, mode: mode === 'owned-thread' ? 'owned_thread' : 'checkpoint', label: 'Task session', ...(ownedThread?{ownedThread}:{}), ...(command === 'serve' ? { resume: true } : {}) }, state);
        if(context.companion)context.companionReady=true;
        if(!UUID.test(admission.sessionId??'')||typeof admission.createAllowed!=='boolean'||(startup&&admission.sessionId!==startup.sessionId))throw new ConnectedAgentClientError('session_receipt_invalid');
        if (!startup) {
            startup = { sessionId: admission.sessionId, phase: 'issued', nativeSessionId: null, ...(ownedThread?{ownedThread,threadBinding:null}:{}) };
            state = { ...state, startups: { ...state.startups, [startupKey]: startup } };
            saveState(key, state, context);
            if (provider === 'codex') {
                if (admission.createAllowed !== true)
                    throw new ConnectedAgentClientError('native_create_unknown');
                try {
                    startup.threadBinding = await createBoundOwnedThread({cwd:ownedThread.cwd});
                    startup.nativeSessionId = startup.threadBinding.threadId;
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
        if(provider==='codex')await readBoundOwnedThread(startup.threadBinding);
        const registered=await request(context, 'sessions', { operation: 'register', ...binding, sessionId: startup.sessionId, nativeSessionId: startup.nativeSessionId,...(provider==='codex'?{threadBinding:startup.threadBinding}:{}) }, state);if(registered.sessionId!==startup.sessionId||registered.registered!==true)throw new ConnectedAgentClientError('session_receipt_invalid');
        startup.phase = 'registered';
        if (command !== 'heartbeat')
            state.paused = false;
        saveState(key, state, context);
        return { runtimeId: state.runtimeId, sessionId: startup.sessionId, mode, availability: provider === 'claude' ? 'checkpoint_wait' : 'ready',deliveryCapability:'pull_only' };
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
  const result=await launchRelayRequest({session,operation:tool?'room_tool':args[0],payload:{claim:session.claim,...(tool?{tool}:args[0]==='inbox'?{cursor}:{input})},fetchImpl:context.fetchImpl});return tool?validateRoomToolResponse(result):result;
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
export async function maintainAgentPresence(args, context) { const i = args.indexOf('--provider'), provider = args[i + 1], key = localConnectionKey(context.credentials.apiKey, provider); let stopped = false, delay = 5000, wake = null, nativePump = null; const stop = () => { stopped = true; wake?.(); }; process.once('SIGINT', stop); process.once('SIGTERM', stop); try {
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
            // Automatic delivery is unavailable: supported inherited-tool isolation is unproven.
            // Presence remains manual/pull-only and never constructs an automatic pump.
            delay = 5000;
        }
        catch {
            await nativePump?.stop();
            delay = Math.min(60000, Math.ceil(delay * 1.7 + Math.random() * 1000));
        }
    }
}
finally {
    await nativePump?.stop();
    nativePump?.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (stopped) {
        try {
            await runAgentsCommand(['stop', '--provider', provider], {...context,processTeardown:true});
        }
        catch { /* Local shutdown never invents remote cancellation. */ }
    }
} }

/** Authenticated native-turn closures. Construction performs no provider or model operation. */
export function createConnectedNativeTurnClient(){throw new ConnectedAgentClientError('native_integration_unavailable');}

/** Synthetic protocol harness only; not a supported runtime capability. */
export function createProtocolTestNativeTurnClient(context){
 if(typeof context?.fetchImpl!=='function')throw new ConnectedAgentClientError('native_integration_unavailable');
 const key=localConnectionKey(context.credentials?.apiKey,'codex'),state=loadConnectedState(key,context.options);
 const session=readConductorSession(context.root??process.cwd(),context.options);
 if(!state?.runtimeId||state.provider!=='codex'||!session?.claim||session.identity.accountId!==state.identity.accountId||session.identity.orgId!==state.identity.orgId||session.identity.worktreeId!==worktreeIdentity(context.root??process.cwd(),context.options))throw new ConnectedAgentClientError('current_claim_required');
 const startupKey=JSON.stringify([session.claim.attemptId,session.claim.instanceId,session.claim.generation]),startup=state.startups?.[startupKey];
 if(startup?.phase!=='registered'||!startup.threadBinding||startup.nativeSessionId!==startup.threadBinding.threadId)throw new ConnectedAgentClientError('session_unavailable');
 const bound={repo:{fullName:context.repoFullName},runtimeId:state.runtimeId,sessionId:startup.sessionId,claim:structuredClone(session.claim),workspaceId:session.workspaceId??session.identity.worktreeId,threadId:startup.threadBinding.threadId};
 const transportContext={...context,tandemCredential:session.credential};
 const assertCurrent=()=>{requireCompanion(context);const current=loadConnectedState(key,context.options),claim=readConductorSession(context.root??process.cwd(),context.options);if(current?.paused||current?.runtimeId!==state.runtimeId||JSON.stringify(current.startups?.[startupKey]?.threadBinding)!==JSON.stringify(startup.threadBinding)||JSON.stringify(claim?.claim)!==JSON.stringify(session.claim)||claim?.identity?.accountId!==state.identity.accountId||claim?.identity?.orgId!==state.identity.orgId)throw new ConnectedAgentClientError('session_unavailable');};
 const wire=(ref,lease=false,report=false)=>({runtimeId:ref.runtimeId,sessionId:ref.sessionId,claim:ref.claim,workspaceId:ref.workspaceId,requestId:ref.requestId,digest:ref.digest,...(lease?{effectId:ref.effectId,leaseToken:ref.leaseToken,leaseGeneration:ref.leaseGeneration}:{}),...(report?{turnId:ref.turnId,state:ref.state}:{})});
 const call=(operation,ref)=>request(transportContext,'native-turns/'+operation,wire(ref,['issue','report'].includes(operation),operation==='report'),state);
 return{bound,threadBinding:structuredClone(startup.threadBinding),journal:createNativeEffectJournal(key,bound,context.options),assertCurrent,
  pending:async()=>{assertCurrent();return request(transportContext,'native-turns/pending',{runtimeId:bound.runtimeId,sessionId:bound.sessionId,claim:bound.claim,workspaceId:bound.workspaceId},state);},
  reserve:ref=>call('reserve',ref),issue:ref=>call('issue',ref),read:async ref=>{const value=await call('read',ref);if(value?.replyState==='confirmed'){const proof=value.reply;if(value.effectId!==ref.requestId||!proof||Object.keys(proof).sort().join()!=='replyDigest,replyId,requestId,sessionId'||proof.replyId!==value.replyId||proof.requestId!==ref.requestId||proof.sessionId!==bound.sessionId||!/^[a-f0-9]{64}$/.test(proof.replyDigest??''))throw new ConnectedAgentClientError('native_receipt_invalid');const original=createNativeEffectJournal(key,bound,context.options).loadEffect(ref.requestId);if(!original||original.lease.replyId!==proof.replyId)throw new ConnectedAgentClientError('native_receipt_invalid');}return value;},report:ref=>call('report',ref),requestStop:ref=>call('stop',ref),
  reply:async({effectId,replyId,text})=>{assertCurrent();const row=createNativeEffectJournal(key,bound,context.options).loadEffect(effectId);if(!row||row.lease.replyId!==replyId)throw new ConnectedAgentClientError('native_effect_conflict');const result=await request(transportContext,'reply',{runtimeId:bound.runtimeId,sessionId:bound.sessionId,claim:bound.claim,workspaceId:bound.workspaceId,input:{requestId:effectId,replyId,digest:row.ref.digest,text}},state);if(result?.requestId!==effectId||result?.recipientSessionId!==bound.sessionId||result?.generation!==bound.claim.generation)throw new ConnectedAgentClientError('native_receipt_invalid');const verified=await call('read',row.ref);const proof=verified?.reply;const expected=createHash('sha256').update(JSON.stringify({requestId:effectId,replyId,digest:row.ref.digest,text})).digest('hex');if(verified?.effectId!==effectId||verified?.replyId!==replyId||verified?.replyState!=='confirmed'||!proof||Object.keys(proof).sort().join()!=='replyDigest,replyId,requestId,sessionId'||proof.replyId!==replyId||proof.requestId!==effectId||proof.sessionId!==bound.sessionId||proof.replyDigest!==expected)throw new ConnectedAgentClientError('native_receipt_invalid');return{replyId};}
 };
}

/** Presence-loop scheduler: never retries an original turn, and keeps heartbeat independent of model latency. */
export function createNativeTurnPump(client,{adapterFactory=createNativeTurnAdapter,consumerFactory=createNativeTurnConsumer}={}){
 if(adapterFactory===createNativeTurnAdapter)throw new ConnectedAgentClientError('native_integration_unavailable');
 let consumer=null,initializing=null,active=null,closed=false;
 const ensure=async()=>{if(consumer)return consumer;if(!initializing)initializing=(async()=>{const adapter=await adapterFactory(client.threadBinding);if(closed){adapter.close();throw new ConnectedAgentClientError('session_unavailable');}consumer=consumerFactory(client.bound,{adapter,journal:client.journal,reserve:client.reserve,issue:client.issue,report:client.report,read:client.read,requestStop:client.requestStop,reply:client.reply,assertCurrent:client.assertCurrent});return consumer;})();return initializing;};
 const stop=async()=>{const row=client.journal.loadActive(client.bound);const ref=active??row?.ref;if(!ref)return;try{await (await ensure()).stop(ref);}catch{/* Missing or unavailable original turn remains unresolved. */}};
 return{
  async tick(){if(closed)throw new ConnectedAgentClientError('session_unavailable');try{client.assertCurrent();}catch(error){await stop();throw error;}
   const row=client.journal.loadActive(client.bound);
   if(row){try{const receipt=await client.read(row.ref);if(receipt?.effectId!==row.lease.effectId)throw new ConnectedAgentClientError('native_receipt_invalid');if(['completed','failed','stopped'].includes(receipt.state)){const turn=receipt.turn;if(receipt.replyId!==row.lease.replyId||!turn||Object.keys(turn).sort().join()!=='threadId,turnId'||turn.threadId!==client.bound.threadId||!UUID.test(turn.turnId??'')||(row.turnId!==null&&row.turnId!==turn.turnId))throw new ConnectedAgentClientError('native_receipt_invalid');client.assertCurrent();await client.journal.save(row.ref,{...row,state:receipt.state,turnId:turn.turnId});consumer?.close();consumer=null;initializing=null;}else if(['stop_requested','stopped_unknown','cancelled','erased'].includes(receipt.state))await stop();}catch(error){await stop();throw error;}return;}
   if(active)return;
   const value=await client.pending();if(!value||Object.keys(value).length!==1||!Array.isArray(value.requests)||value.requests.length>20)throw new ConnectedAgentClientError('native_receipt_invalid');
   const next=value.requests[0];if(!next)return;if(Object.keys(next).sort().join(',')!=='digest,requestId'||!UUID.test(next.requestId??'')||!/^[a-f0-9]{64}$/.test(next.digest??''))throw new ConnectedAgentClientError('native_receipt_invalid');
   const ref={...structuredClone(client.bound),...next};client.assertCurrent();const instance=await ensure();active=ref;
   void instance.run(ref).catch(()=>{}).finally(()=>{active=null;});
  },stop,close(){closed=true;consumer?.close();}
 };
}
