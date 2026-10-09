import {NativeRuntimeError} from './native-agent-runtime.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STATES=new Set(['reserved','issued_unknown','running','completed','failed','stopped','stop_requested','stopped_unknown','not_issued','cancelled','erased']);
const REPLY_STATES=new Set(['not_sent','unknown','confirmed','erased']);
const TERMINAL=new Set(['completed','failed','stopped','not_issued','cancelled','erased']);
const fail=()=>{throw new NativeRuntimeError('native_scope_invalid');};
const keys=(value,wanted)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).sort().join(',')===wanted.split(',').sort().join(',');
const safe=value=>typeof value==='string'&&value.length>0&&value.length<=255&&!/[\x00-\x1f\x7f]/.test(value);
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function scope(value){
 if(!keys(value,'repo,runtimeId,sessionId,claim,workspaceId,threadId')||!keys(value.repo,'fullName')||!safe(value.repo.fullName)||!value.repo.fullName.match(/^[\w.-]+\/[\w.-]+$/)||!safe(value.workspaceId)||['runtimeId','sessionId','threadId'].some(key=>!UUID.test(value[key]??'')))fail();
 const claim=value.claim;if(!keys(claim,'attemptId,handoffId,actionId,actionVersion,instanceId,generation,version,leaseExpiresAt')||['attemptId','handoffId','actionId','instanceId'].some(key=>!UUID.test(claim[key]??''))||['actionVersion','generation','version'].some(key=>!Number.isSafeInteger(claim[key])||claim[key]<1)||typeof claim.leaseExpiresAt!=='string'||claim.leaseExpiresAt.length>64||!Number.isFinite(Date.parse(claim.leaseExpiresAt)))fail();
 return value;
}
function reference(value,bound){
 if(!keys(value,'repo,runtimeId,sessionId,claim,workspaceId,threadId,requestId,digest')||!UUID.test(value.requestId??'')||!/^[a-f0-9]{64}$/.test(value.digest??''))fail();
 const {requestId:_,digest:__,...binding}=value;scope(binding);if(canonical(binding)!==canonical(bound))fail();return freeze(structuredClone(value));
}
function lease(value){
 const result={effectId:value?.effectId,leaseToken:value?.leaseToken,leaseGeneration:value?.leaseGeneration,replyId:value?.replyId};
 if(['effectId','leaseToken','replyId'].some(key=>!UUID.test(result[key]??''))||!Number.isSafeInteger(result.leaseGeneration)||result.leaseGeneration<1)fail();return freeze(result);
}
function checkedRow(value,bound,ref=null){
 if(!keys(value,'version,ref,lease,threadId,turnId,state')||value.version!==1||!STATES.has(value.state)||value.threadId!==bound.threadId||(value.turnId!==null&&!UUID.test(value.turnId??''))||!keys(value.lease,'effectId,leaseToken,leaseGeneration,replyId'))fail();
 const original=reference(value.ref,bound);if(ref&&canonical(original)!==canonical(ref))fail();lease(value.lease);if(value.lease.effectId!==original.requestId)fail();return freeze(structuredClone(value));
}

/** One adapter and one unresolved effect per immutable original binding. Never replays a journaled turn. */
export function createNativeTurnConsumer(input,{adapter,journal,reserve,issue,report,read,requestStop,reply,assertCurrent=()=>{}}={}){
 const bound=freeze(structuredClone(scope(input)));
 if(!adapter||['run','stop','close','reconcileStop'].some(key=>typeof adapter[key]!=='function')||!journal||['load','loadActive','save'].some(key=>typeof journal[key]!=='function')||[reserve,issue,report,read,requestStop,reply,assertCurrent].some(fn=>typeof fn!=='function'))fail();
 let closed=false,active=null,tail=Promise.resolve();
 const guard=async()=>{if(closed)throw new NativeRuntimeError('native_unavailable');await assertCurrent(bound);};
 const same=(a,b)=>canonical(a)===canonical(b);
 const result=row=>({state:row.state,...(row.turnId?{turnId:row.turnId}:{})});
 async function save(holder,state,turnId=holder.row.turnId){
  if(!STATES.has(state)||(turnId!==null&&!UUID.test(turnId??''))||(holder.row.turnId&&holder.row.turnId!==turnId))fail();
  const row=checkedRow({...holder.row,state,turnId},bound,holder.ref);holder.row=row;
  // Memory retains uncertainty even when the durable write fails.
  await guard();await journal.save(holder.ref,row);return row;
 }
 async function restore(ref){
  const unresolved=await journal.loadActive(bound);
  if(unresolved){const row=checkedRow(unresolved,bound);if(TERMINAL.has(row.state))fail();active={ref:row.ref,row,live:false,stopRequested:false};}
  const stored=await journal.load(ref);return stored?checkedRow(stored,bound,ref):null;
 }
 async function runOne(ref){
  await guard();
  if(active){if(same(active.ref,ref))return active.row?result(active.row):{state:'issued_unknown'};throw new NativeRuntimeError('native_effect_unresolved');}
  const stored=await restore(ref);
  if(active){if(same(active.ref,ref))return result(active.row);throw new NativeRuntimeError('native_effect_unresolved');}
  if(stored){
   // Reconciliation is read-only; even an ambiguous reply must keep its original reply ID.
   try{await guard();const view=await read(ref);if(view?.effectId!==stored.lease.effectId||view?.replyId!==stored.lease.replyId||!REPLY_STATES.has(view?.replyState))fail();return {...result(stored),replyState:view.replyState};}catch{return result(stored);}
  }
  const holder={ref,row:null,live:false,stopRequested:false};active=holder;let attemptedIssue=false;
  try{
   const reserved=await reserve(ref),originalLease=lease(reserved);
   if(!STATES.has(reserved.state))fail();
   holder.row=checkedRow({version:1,ref,lease:originalLease,threadId:bound.threadId,turnId:null,state:reserved.state},bound,ref);
   await save(holder,reserved.state);
   if(reserved.state!=='reserved')return result(holder.row);
   if(holder.stopRequested){try{await guard();await requestStop(ref);}catch{}await save(holder,'not_issued');return result(holder.row);}
   holder.live=true;
   const outcome=await adapter.run({
    effectId:originalLease.effectId,
    issue:async()=>{
     await guard();if(holder.stopRequested)throw new NativeRuntimeError('native_unavailable');
     // Fence disclosure itself: a lost issue receipt cannot permit a fresh turn on restart.
     attemptedIssue=true;await save(holder,'issued_unknown');await guard();
     const disclosure=await issue({...ref,...originalLease});
     if(disclosure?.effectId!==originalLease.effectId||disclosure?.replyId!==originalLease.replyId||disclosure?.leaseToken!==originalLease.leaseToken||disclosure?.leaseGeneration!==originalLease.leaseGeneration||disclosure?.digest!==ref.digest||disclosure?.thread?.threadId!==bound.threadId)fail();
     return{text:disclosure.text,replyId:originalLease.replyId};
    },
    persist:async metadata=>{
     if(metadata.effectId!==originalLease.effectId||metadata.threadId!==bound.threadId)fail();
     await save(holder,metadata.state,metadata.turnId);
    },
    report:async metadata=>{
     if(metadata.effectId!==originalLease.effectId||metadata.threadId!==bound.threadId||metadata.turnId!==holder.row.turnId)fail();
     await guard();return report({...ref,...originalLease,turnId:metadata.turnId,state:metadata.state});
    },
    reply:async metadata=>{
     if(metadata.effectId!==originalLease.effectId||metadata.replyId!==originalLease.replyId)fail();await guard();return reply({effectId:originalLease.effectId,replyId:originalLease.replyId,text:metadata.text});
    }
   });
   if(!outcome||!STATES.has(outcome.state))fail();
   const state=outcome.state==='not_issued'&&attemptedIssue?'issued_unknown':outcome.state;
   // Adapter completion persisted its receipt first. Do not erase that fact after a failed report/reply.
   if(!TERMINAL.has(holder.row.state))await save(holder,state,outcome.turnId??holder.row.turnId);
   return {...result(holder.row),...(outcome.replyState?{replyState:outcome.replyState}:{})};
  }catch{
   if(holder.row)return result(holder.row);
   return{state:'not_issued'};
  }finally{
   if(!holder.row||TERMINAL.has(holder.row.state))active=null;
  }
 }
 function run(inputRef){const ref=reference(inputRef,bound);const next=tail.then(()=>runOne(ref));tail=next.catch(()=>{});return next;}
 async function stop(inputRef){
  const ref=reference(inputRef,bound);if(closed)throw new NativeRuntimeError('native_unavailable');
  let holder=active;
  if(holder&&!same(holder.ref,ref))throw new NativeRuntimeError('native_effect_unresolved');
  if(!holder){const stored=await journal.load(ref);if(stored)holder={ref,row:checkedRow(stored,bound,ref),live:false,stopRequested:false};}
  if(!holder)return{state:'stopped_unknown'};
  if(holder.row&&TERMINAL.has(holder.row.state))return result(holder.row);
  holder.stopRequested=true;active=holder;
  let local={state:'stopped_unknown'};
  // Local original-turn interruption is independent of authentication, journal, and remote report health.
  try{local=holder.live?await adapter.stop():holder.row?.turnId?await adapter.reconcileStop({effectId:holder.row.lease.effectId,threadId:holder.row.threadId,turnId:holder.row.turnId}):local;}catch{}
  try{await guard();await requestStop(ref);}catch{}
  if(holder.row&&!TERMINAL.has(holder.row.state))try{await save(holder,local?.state==='stop_requested'?'stop_requested':'stopped_unknown');}catch{}
  return{state:local?.state==='stop_requested'?'stop_requested':'stopped_unknown',...(holder.row?.turnId?{turnId:holder.row.turnId}:{})};
 }
 function close(){closed=true;adapter.close();}
 return{run,stop,close};
}
