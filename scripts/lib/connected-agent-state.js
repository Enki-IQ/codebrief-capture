import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { withPrivateStateDirectory, readPrivateStateJson, writePrivateStateJson, withPrivateStateLock } from './handoff-state.js';
export function runtimeNamespace(identity) { if (!identity || ['accountId', 'orgId', 'provider', 'runtimeId'].some(key => typeof identity[key] !== 'string' || !identity[key] || identity[key].length > 255))
    throw new Error('runtime_identity_invalid'); return createHash('sha256').update(JSON.stringify(['connected-agent-v1', identity.accountId, identity.orgId, identity.provider, identity.runtimeId])).digest('hex'); }
export function localConnectionKey(apiKey, provider) { if (typeof apiKey !== 'string' || !apiKey || !['claude', 'codex'].includes(provider))
    throw new Error('runtime_identity_invalid'); return createHash('sha256').update(JSON.stringify(['connected-agent-key-v1', apiKey, provider])).digest('hex'); }
function managed(key, options, callback) { if (!/^[0-9a-f]{64}$/.test(key))
    throw new Error('runtime_identity_invalid'); return withPrivateStateDirectory(`connected-agents/v1/${key}`, options, { create: true }, ({ directoryPath, verify }) => withPrivateStateLock(directoryPath, verify, () => callback(join(directoryPath, 'state.json'), verify))); }
export function loadConnectedState(key, options) { return managed(key, options, (path, verify) => readPrivateStateJson(path, verify)); }
export function saveConnectedState(key, value, options) { if (Buffer.byteLength(JSON.stringify(value)) > 65536)
    throw new Error('runtime_state_invalid'); return managed(key, options, (path, verify) => { writePrivateStateJson(path, value, verify); return value; }); }

// This short private-state lock is never held across HTTP or a companion lifetime.
export function updateCompanion(key, options, operation) {
 return managed(key,options,(path,verify)=>{const companionPath=join(path,'..','companion.json');const result=operation(readPrivateStateJson(companionPath,verify), value=>writePrivateStateJson(path,value,verify), ()=>readPrivateStateJson(path,verify));if(result!==undefined)writePrivateStateJson(companionPath,result,verify);return result;});
}
export function loadCompanion(key, options) { return managed(key,options,(path,verify)=>readPrivateStateJson(join(path,'..','companion.json'),verify)); }
export function saveFencedConnectedState(key,value,options,companion,legacyEpoch) {
 return managed(key,options,(path,verify)=>{
  const current=readPrivateStateJson(join(path,'..','companion.json'),verify);
  if(!companion&&current&&(current.active||current.id!==legacyEpoch?.id||current.generation!==legacyEpoch?.generation))throw new Error('companion_stale');
  if(companion&&(!current||current.id!==companion.id||current.generation!==companion.generation||current.active!==companion.active))throw new Error('companion_stale');
  writePrivateStateJson(path,value,verify);return value;
 });
}

export function preserveNativeReceipt(key,value,options) {
 return managed(key,options,(path,verify)=>{
  const current=readPrivateStateJson(path,verify);if(!current||current.runtimeId!==value.runtimeId)return;
  for(const [key,receipt] of Object.entries(value.startups??{})) {
   const prior=current.startups?.[key];
   if(prior&&prior.sessionId===receipt.sessionId&&prior.nativeSessionId===null&&typeof receipt.nativeSessionId==='string'&&receipt.nativeSessionId)current.startups[key]={...prior,nativeSessionId:receipt.nativeSessionId,...(receipt.threadBinding?{threadBinding:receipt.threadBinding}:{}),phase:'created'};
  }
  writePrivateStateJson(path,current,verify);
 });
}

const EFFECT_UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EFFECT_STATES=['reserved','issued_unknown','running','completed','failed','stopped','stop_requested','stopped_unknown','not_issued','cancelled','erased'];
function exactKeys(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==[...keys].sort().join())throw new Error('native_journal_invalid');}
function effectRef(value){
 exactKeys(value,['repo','runtimeId','sessionId','claim','workspaceId','threadId','requestId','digest']);exactKeys(value.repo,['fullName']);exactKeys(value.claim,['actionId','attemptId','instanceId','handoffId','generation','actionVersion','version','leaseExpiresAt']);
 if(typeof value.repo.fullName!=='string'||!/^[-\w.]+\/[-\w.]+$/.test(value.repo.fullName)||value.repo.fullName.length>255||typeof value.workspaceId!=='string'||!value.workspaceId||value.workspaceId.length>255||/[\x00-\x1f\x7f]/.test(value.workspaceId))throw new Error('native_journal_invalid');
 for(const id of [value.runtimeId,value.sessionId,value.threadId,value.requestId,value.claim.actionId,value.claim.attemptId,value.claim.instanceId,value.claim.handoffId])if(!EFFECT_UUID.test(id??''))throw new Error('native_journal_invalid');
 if(![value.claim.actionVersion,value.claim.version].every(n=>Number.isSafeInteger(n)&&n>=1)||typeof value.claim.leaseExpiresAt!=='string'||!Number.isFinite(Date.parse(value.claim.leaseExpiresAt))||!Number.isSafeInteger(value.claim.generation)||value.claim.generation<1||!/^[0-9a-f]{64}$/.test(value.digest??''))throw new Error('native_journal_invalid');
 return JSON.parse(JSON.stringify(value));
}
const effectCanonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function effectScope(ref){const value=effectRef(ref);delete value.requestId;delete value.digest;return effectCanonical(value);}
function effectRow(value){
 exactKeys(value,['version','ref','lease','threadId','turnId','state']);exactKeys(value.lease,['effectId','leaseToken','leaseGeneration','replyId']);
 const ref=effectRef(value.ref);if(value.version!==1||value.threadId!==ref.threadId||value.lease.effectId!==ref.requestId||!EFFECT_STATES.includes(value.state)||(value.turnId!==null&&!EFFECT_UUID.test(value.turnId??'')))throw new Error('native_journal_invalid');
 for(const id of [value.lease.effectId,value.lease.leaseToken,value.lease.replyId])if(!EFFECT_UUID.test(id??''))throw new Error('native_journal_invalid');
 if(!Number.isSafeInteger(value.lease.leaseGeneration)||value.lease.leaseGeneration<1)throw new Error('native_journal_invalid');
 return JSON.parse(JSON.stringify(value));
}
/** Private source-free journal; locks cover disk operations only, never HTTP/model work. */
export function createNativeEffectJournal(key,bound,options){
 exactKeys(bound,['repo','runtimeId','sessionId','claim','workspaceId','threadId']);
 const scope=effectScope({...bound,requestId:bound.sessionId,digest:'0'.repeat(64)});
 const access=operation=>managed(key,options,(path,verify)=>{const journalPath=join(path,'..','native-effects.json');const raw=readPrivateStateJson(journalPath,verify)??{version:1,rows:[]};exactKeys(raw,['version','rows']);if(raw.version!==1||!Array.isArray(raw.rows)||raw.rows.length>64)throw new Error('native_journal_invalid');const rows=raw.rows.map(effectRow);return operation(rows,value=>writePrivateStateJson(journalPath,{version:1,rows:value},verify));});
 const validate=ref=>{const value=effectRef(ref);if(effectScope(value)!==scope)throw new Error('native_journal_scope_conflict');return value;};
 return{
  loadEffect:id=>{if(!EFFECT_UUID.test(id??''))throw new Error('native_journal_invalid');return access(rows=>{const row=rows.find(row=>row.lease.effectId===id);if(row&&effectScope(row.ref)!==scope)throw new Error('native_journal_scope_conflict');return row??null;});},
  load:ref=>{const value=validate(ref);return access(rows=>{const row=rows.find(row=>row.ref.requestId===value.requestId);if(row&&effectCanonical(row.ref)!==effectCanonical(value))throw new Error('native_journal_scope_conflict');return row??null;});},
  loadActive:value=>{if(effectCanonical(value)!==effectCanonical(bound))throw new Error('native_journal_scope_conflict');return access(rows=>{const active=rows.filter(row=>effectScope(row.ref)===scope&&!['completed','failed','stopped','not_issued','cancelled','erased'].includes(row.state));if(active.length>1)throw new Error('native_journal_invalid');return active[0]??null;});},
  save:(ref,value)=>{validate(ref);const row=effectRow(value);if(effectCanonical(row.ref)!==effectCanonical(ref))throw new Error('native_journal_scope_conflict');return access((rows,write)=>{const index=rows.findIndex(prior=>prior.ref.requestId===ref.requestId);if(index>=0){const prior=rows[index];if(effectCanonical(prior.ref)!==effectCanonical(row.ref)||effectCanonical(prior.lease)!==effectCanonical(row.lease)||(prior.turnId!==null&&prior.turnId!==row.turnId)||(['completed','failed','stopped','not_issued','cancelled','erased'].includes(prior.state)&&prior.state!==row.state))throw new Error('native_journal_scope_conflict');rows[index]=row;}else{if(rows.length>=64)throw new Error('native_journal_full');rows.push(row);}write(rows);return row;});}
 };
}
