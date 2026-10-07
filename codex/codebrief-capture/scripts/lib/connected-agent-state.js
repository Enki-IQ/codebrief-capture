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
   if(prior&&prior.sessionId===receipt.sessionId&&prior.nativeSessionId===null&&typeof receipt.nativeSessionId==='string'&&receipt.nativeSessionId)current.startups[key]={...prior,nativeSessionId:receipt.nativeSessionId,phase:'created'};
  }
  writePrivateStateJson(path,current,verify);
 });
}
