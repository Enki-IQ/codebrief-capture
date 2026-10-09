import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTurnConsumer} from './native-turn-consumer.js';

const id=n=>`019d1234-${String(n).padStart(4,'0')}-7111-8111-111111111111`;
const bound={repo:{fullName:'owner/repo'},runtimeId:id(1),sessionId:id(2),threadId:id(3),workspaceId:'owned-workspace',claim:{attemptId:id(4),handoffId:id(5),actionId:id(6),actionVersion:1,instanceId:id(7),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'}};
const reference=n=>({...structuredClone(bound),requestId:id(n),digest:'a'.repeat(64)});
const turnId=id(20),lease={effectId:id(8),leaseToken:id(9),leaseGeneration:1,replyId:id(10)};
const terminal=new Set(['completed','failed','stopped','not_issued','cancelled','erased']);
function fixture({rows=new Map(),state='completed',issueFailure=false,reportFailure=false,replyFailure=false,saveFailure=null,adapterRun=null}={}){
 const calls=[],saved=[],key=ref=>ref.requestId;
 const journal={load:async ref=>structuredClone(rows.get(key(ref))??null),loadActive:async()=>{const values=[...rows.values()].filter(row=>!terminal.has(row.state));assert.ok(values.length<=1);return structuredClone(values[0]??null);},save:async(ref,row)=>{calls.push(['save',row.state]);if(row.state===saveFailure)throw new Error('private untrusted detail');rows.set(key(ref),structuredClone(row));saved.push(structuredClone(row));}};
 const adapter={run:async hooks=>{
  calls.push(['run',hooks.effectId]);if(adapterRun)return adapterRun(hooks,calls);
  const issued=await hooks.issue();await hooks.persist({effectId:hooks.effectId,threadId:bound.threadId,turnId:null,state:'issued_unknown'});
  calls.push(['start']);await hooks.persist({effectId:hooks.effectId,threadId:bound.threadId,turnId,state:'running'});
  try{await hooks.report({effectId:hooks.effectId,threadId:bound.threadId,turnId,state:'running'});}catch{return{state:'issued_unknown'};}
  if(state==='issued_unknown')return{state};
  await hooks.persist({effectId:hooks.effectId,threadId:bound.threadId,turnId,state});
  try{await hooks.report({effectId:hooks.effectId,threadId:bound.threadId,turnId,state});if(state==='completed')await hooks.reply({effectId:hooks.effectId,replyId:issued.replyId,text:'PRIVATE MODEL OUTPUT'});}catch{return{state,turnId,replyState:'unknown'};}
  return{state,turnId};
 },stop:async()=>{calls.push(['localStop']);return{state:'stop_requested'};},reconcileStop:async metadata=>{calls.push(['reconcileStop',metadata]);return{state:'stop_requested'};},close:()=>calls.push(['close'])};
 let fresh=true;
 const options={adapter,journal,assertCurrent:()=>{if(!fresh)throw new Error('current_scope_changed');},reserve:async ref=>{calls.push(['reserve',ref]);return{...lease,effectId:ref.requestId,state:'reserved',replyState:'not_sent'};},issue:async input=>{calls.push(['issue',input]);if(issueFailure)throw new Error('private transport detail');return{...lease,effectId:input.effectId,state:'issued_unknown',replyState:'not_sent',text:'PRIVATE QUESTION',digest:input.digest,thread:{threadId:bound.threadId}};},report:async input=>{calls.push(['report',input]);if(reportFailure)throw new Error('private reporting detail');return{...lease,state:input.state};},read:async ref=>{calls.push(['read',ref]);return{...lease,replyState:'confirmed'};},requestStop:async ref=>{calls.push(['remoteStop',ref]);if(reportFailure)throw new Error('private reporting detail');return{state:'stop_requested'};},reply:async input=>{calls.push(['reply',input]);if(replyFailure)throw new Error('private output');return{replyId:input.replyId};}};
 return{options,calls,rows,saved,setFresh:value=>{fresh=value;},consumer:createNativeTurnConsumer(structuredClone(bound),options)};
}
test('original effect, lease and reply IDs cross closures; durable journal never contains question/output',async()=>{
 const f=fixture(),ref=reference(8);assert.deepEqual(await f.consumer.run(ref),{state:'completed',turnId});
 assert.equal(f.calls.filter(([name])=>name==='start').length,1);
 for(const [,input]of f.calls.filter(([name])=>['issue','report'].includes(name))){assert.equal(input.effectId,lease.effectId);assert.equal(input.leaseToken,lease.leaseToken);assert.equal(input.leaseGeneration,1);assert.equal(input.replyId,lease.replyId);assert.equal(input.requestId,ref.requestId);}
 assert.deepEqual(f.calls.find(([name])=>name==='reply')[1],{effectId:lease.effectId,replyId:lease.replyId,text:'PRIVATE MODEL OUTPUT'});
 assert.ok(f.saved.every(row=>!JSON.stringify(row).includes('PRIVATE')));assert.ok(f.calls.findIndex(([name,state])=>name==='save'&&state==='issued_unknown')<f.calls.findIndex(([name])=>name==='issue'));
});
test('persistent adapter serializes different effects, even when run callers arrive together',async()=>{
 let release,entered=0,concurrent=0,max=0;const gate=new Promise(resolve=>release=resolve);
 const f=fixture({adapterRun:async hooks=>{entered++;concurrent++;max=Math.max(max,concurrent);if(entered===1)await gate;await hooks.issue();await hooks.persist({effectId:hooks.effectId,threadId:bound.threadId,turnId,state:'failed'});concurrent--;return{state:'failed',turnId};}});
 const first=f.consumer.run(reference(8)),second=f.consumer.run(reference(11));await new Promise(resolve=>setImmediate(resolve));assert.equal(entered,1);release();await Promise.all([first,second]);assert.equal(entered,2);assert.equal(max,1);
});
test('restart unknown blocks original replay and a replacement request before reserve/start',async()=>{
 const f=fixture({state:'issued_unknown'}),ref=reference(8);await f.consumer.run(ref);const restarted=createNativeTurnConsumer(bound,f.options),before=f.calls.length;
 assert.deepEqual(await restarted.run(ref),{state:'issued_unknown',turnId});await assert.rejects(restarted.run(reference(11)),{code:'native_effect_unresolved'});
 assert.equal(f.calls.slice(before).filter(([name])=>['reserve','run','issue','start'].includes(name)).length,0);
});
test('issue transport uncertainty remains issued_unknown despite adapter not_issued result, including restart',async()=>{
 const f=fixture({issueFailure:true,adapterRun:async hooks=>{try{await hooks.issue();}catch{return{state:'not_issued'};}assert.fail('issue must fail');}}),ref=reference(8);
 assert.deepEqual(await f.consumer.run(ref),{state:'issued_unknown'});assert.equal(f.rows.get(ref.requestId).state,'issued_unknown');
 const restart=createNativeTurnConsumer(bound,f.options);assert.deepEqual(await restart.run(ref),{state:'issued_unknown'});assert.equal(f.calls.filter(([name])=>name==='issue').length,1);
});
test('ambiguous completed reply keeps original completed identity and never repeats reply or turn',async()=>{
 const f=fixture({replyFailure:true}),ref=reference(8);assert.deepEqual(await f.consumer.run(ref),{state:'completed',turnId,replyState:'unknown'});
 await createNativeTurnConsumer(bound,f.options).run(ref);assert.equal(f.calls.filter(([name])=>name==='reply').length,1);assert.equal(f.calls.filter(([name])=>name==='start').length,1);
});
test('Stop uses original known turn after report failure and restart even if remote Stop fails',async()=>{
 const f=fixture({reportFailure:true}),ref=reference(8);await f.consumer.run(ref);const restart=createNativeTurnConsumer(bound,f.options);
 assert.deepEqual(await restart.stop(ref),{state:'stop_requested',turnId});
 assert.deepEqual(f.calls.find(([name])=>name==='reconcileStop')[1],{effectId:lease.effectId,threadId:bound.threadId,turnId});
 assert.ok(f.calls.findIndex(([name])=>name==='reconcileStop')<f.calls.findIndex(([name])=>name==='remoteStop'));
 await assert.rejects(restart.run(reference(11)),{code:'native_effect_unresolved'});
});
test('local known Stop still runs when current authority and journal reporting have failed',async()=>{
 const f=fixture({state:'issued_unknown',saveFailure:'stop_requested'}),ref=reference(8);await f.consumer.run(ref);f.setFresh(false);
 assert.deepEqual(await f.consumer.stop(ref),{state:'stop_requested',turnId});assert.equal(f.calls.filter(([name])=>name==='localStop').length,1);
 await assert.rejects(f.consumer.run(ref),/current_scope_changed/);
});
test('binding clone is immutable; changed scope/generation denied before any callback',async()=>{
 const source=structuredClone(bound),f=fixture(),consumer=createNativeTurnConsumer(source,f.options);source.claim.generation=999;source.repo.fullName='foreign/repo';
 await consumer.run(reference(8));const count=f.calls.length;
 for(const ref of [{...reference(11),repo:{fullName:'foreign/repo'}},{...reference(11),claim:{...bound.claim,generation:2}}]){assert.throws(()=>consumer.run(ref),{code:'native_scope_invalid'});await assert.rejects(consumer.stop(ref),{code:'native_scope_invalid'});}
 assert.equal(f.calls.length,count);
});
test('untrusted journal row with text or changed lease shape fails closed before reserve',async()=>{
 const f=fixture(),ref=reference(8);f.rows.set(ref.requestId,{version:1,ref,lease,threadId:bound.threadId,turnId,state:'running',text:'PRIVATE QUESTION'});
 await assert.rejects(f.consumer.run(ref),{code:'native_scope_invalid'});assert.equal(f.calls.length,0);
});
test('failed pre-disclosure journal write prevents issue/start and fences later scheduling',async()=>{
 const f=fixture({saveFailure:'issued_unknown'}),ref=reference(8);assert.deepEqual(await f.consumer.run(ref),{state:'issued_unknown'});
 assert.equal(f.calls.filter(([name])=>name==='issue'||name==='start').length,0);
 await assert.rejects(f.consumer.run(reference(11)),{code:'native_effect_unresolved'});
 const restart=createNativeTurnConsumer(bound,f.options);assert.deepEqual(await restart.run(ref),{state:'reserved'});assert.equal(f.calls.filter(([name])=>name==='run').length,1);
});
test('mismatched issued reply identity cannot start a turn or write a replacement reply fence',async()=>{
 const f=fixture(),ref=reference(8);f.options.issue=async input=>({...lease,replyId:id(21),text:'PRIVATE QUESTION',digest:input.digest,thread:{threadId:bound.threadId}});
 const consumer=createNativeTurnConsumer(bound,f.options);assert.deepEqual(await consumer.run(ref),{state:'issued_unknown'});
 assert.equal(f.calls.filter(([name])=>name==='start'||name==='reply').length,0);assert.equal(f.rows.get(ref.requestId).lease.replyId,lease.replyId);
});
