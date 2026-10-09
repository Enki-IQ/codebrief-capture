import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createNativeTurnPump} from './connected-agent-client.js';
const requestId='10000000-0000-4000-8000-000000000001',digest='a'.repeat(64);
function fixture(){let row=null,allowed=true,starts=0,stops=0,resolveRun;const bound={threadId:'thread'},ref={...bound,requestId,digest};const client={bound,threadBinding:{},journal:{loadActive:()=>row},assertCurrent(){if(!allowed)throw Error('revoked');},pending:async()=>({requests:[{requestId,digest}]}),read:async()=>({effectId:requestId,state:'running'})};const pump=createNativeTurnPump(client,{adapterFactory:async()=>({}),consumerFactory:()=>({run(r){starts++;assert.deepEqual(r,ref);row={ref,lease:{effectId:requestId}};return new Promise(resolve=>{resolveRun=resolve;});},async stop(r){stops++;assert.deepEqual(r,ref);},close(){}})});return{pump,client,get starts(){return starts;},get stops(){return stops;},revoke(){allowed=false;},finish(){resolveRun?.();},restore(){row={ref,lease:{effectId:requestId}};}};}
test('pending dispatch runs once without blocking presence and unresolved journal prevents replacement',async()=>{const f=fixture();await f.pump.tick();assert.equal(f.starts,1);await f.pump.tick();assert.equal(f.starts,1);f.finish();await Promise.resolve();await f.pump.tick();assert.equal(f.starts,1);f.pump.close();});
test('lost current authority interrupts original locally, without another admission',async()=>{const f=fixture();await f.pump.tick();f.revoke();await assert.rejects(f.pump.tick(),/revoked/);assert.equal(f.stops,1);assert.equal(f.starts,1);f.finish();f.pump.close();});
test('restart stop uses original journal ref and server Stop never starts another effect',async()=>{const f=fixture();f.restore();f.client.read=async()=>({effectId:requestId,state:'stop_requested'});await f.pump.tick();assert.equal(f.starts,0);assert.equal(f.stops,1);f.pump.close();});
test('malformed pending or foreign receipt fails closed',async()=>{const f=fixture();f.client.pending=async()=>({requests:[{requestId,digest,text:'no source'}]});await assert.rejects(f.pump.tick());assert.equal(f.starts,0);f.restore();f.client.read=async()=>({effectId:'foreign',state:'running'});await assert.rejects(f.pump.tick());assert.equal(f.starts,0);assert.equal(f.stops,1);f.pump.close();});

import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createProtocolTestNativeTurnClient} from './connected-agent-client.js';
import {localConnectionKey,saveConnectedState} from './connected-agent-state.js';
import {installConductorSession} from './tandem-client.js';
test('actual client and restart journal reconcile only original terminal turn without disclosure or replay',async()=>{
 const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const base=realpathSync(mkdtempSync(join(tmpdir(),'native-pump-reconcile-'))),root=join(base,'repo'),options={baseDir:join(base,'private')};mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
 const credentials={apiKey:'fixture',apiBaseUrl:'https://app.codebrief.ai'},key=localConnectionKey('fixture','codex'),claim={attemptId:id(1),handoffId:id(2),actionId:id(3),actionVersion:1,instanceId:id(4),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},threadBinding={threadId:id(5),sessionId:id(6),cwd:root,cliVersion:'0.145.0',model:'fixture',modelProvider:'fixture'};
 installConductorSession(root,{launchId:id(7),identity:{accountId:id(8),orgId:id(9),repoId:id(10)},credential:'x'.repeat(43),workspaceId:'fixture',sessionId:'fixture-provider',claim},options);
 saveConnectedState(key,{provider:'codex',runtimeId:id(11),nonce:'fixture-runtime',identity:{accountId:id(8),orgId:id(9)},paused:false,startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{sessionId:id(12),phase:'registered',nativeSessionId:threadBinding.threadId,threadBinding}}},options);
 let turnId=id(20);const paths=[];
 const client=createProtocolTestNativeTurnClient({root,options,credentials,repoFullName:'fixture/repo',fetchImpl:async(url)=>{paths.push(new URL(url).pathname);return Response.json({effectId:id(13),replyId:id(16),replyState:'not_sent',state:'completed',turn:{threadId:threadBinding.threadId,turnId}});}});
 const ref={...client.bound,requestId:id(13),digest:'a'.repeat(64)},row={version:1,ref,lease:{effectId:id(13),leaseToken:id(15),leaseGeneration:1,replyId:id(16)},threadId:client.bound.threadId,turnId:id(20),state:'running'};
 client.journal.save(ref,row);const pump=createNativeTurnPump(client,{adapterFactory:async()=>{throw Error('must not start adapter during reconciliation');}});
 turnId=id(21);await assert.rejects(pump.tick());assert.equal(client.journal.loadActive(client.bound).state,'running');
 turnId=id(20);await pump.tick();assert.equal(client.journal.loadActive(client.bound),null);assert.equal(client.journal.load(ref).state,'completed');assert.ok(paths.every(path=>path.endsWith('/read')));pump.close();
 }finally{rmSync(base,{recursive:true,force:true});}
});

import {createConnectedNativeTurnClient} from './connected-agent-client.js';
import {createNativeTurnAdapter} from './native-turn-adapter.js';
test('production automatic capability stays unavailable regardless of saved state or switches',async()=>{let calls=0;const context={automatic:true,isolationVerified:true,fetchImpl:async()=>{calls++;}};assert.throws(()=>createConnectedNativeTurnClient(context),{code:'native_integration_unavailable'});assert.throws(()=>createNativeTurnPump({pending:()=>{calls++;},issue:()=>{calls++;}}),{code:'native_integration_unavailable'});await assert.rejects(createNativeTurnAdapter({isolationVerified:true}),{code:'native_integration_unavailable'});assert.equal(calls,0);});
