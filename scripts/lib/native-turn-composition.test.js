import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,realpathSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createProtocolTestNativeTurnClient} from './connected-agent-client.js';
import {createNativeTurnConsumer} from './native-turn-consumer.js';
import {createNativeTurnAdapter} from './native-turn-adapter.js';
import {localConnectionKey,saveConnectedState,loadConnectedState} from './connected-agent-state.js';
import {installConductorSession} from './tandem-client.js';

const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const requestId=id(20),turnId=id(21),replyId=id(22),leaseToken=id(23);
const question='Benign fixture question',answer='Benign fixture final answer';
const digest=createHash('sha256').update(question).digest('hex');
const defer=()=>{let resolve;const promise=new Promise(done=>resolve=done);return{promise,resolve};};
const settle=promise=>Promise.race([promise,new Promise((_resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('composition fixture timed out')),2500);timeout.unref();})]);

async function fixture({mode='complete',loseReplyResponse=false,wrongReplyProof=false,delayIssue=false}={}){
 const base=realpathSync(mkdtempSync(join(tmpdir(),'native-composition-'))),root=join(base,'repo'),options={baseDir:join(base,'private')};mkdirSync(root);execFileSync('git',['init','-q',root]);
 const credentials={apiKey:'fixture-capture-key',apiBaseUrl:'https://app.codebrief.ai'},key=localConnectionKey(credentials.apiKey,'codex');
 const claim={attemptId:id(1),handoffId:id(2),actionId:id(3),actionVersion:1,instanceId:id(4),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'};
 const threadBinding={threadId:id(5),sessionId:id(6),cwd:root,cliVersion:'0.145.0',model:'fixture-model',modelProvider:'fixture-provider'};
 const startupKey=JSON.stringify([claim.attemptId,claim.instanceId,claim.generation]);
 installConductorSession(root,{launchId:id(7),identity:{accountId:id(8),orgId:id(9),repoId:id(10)},credential:'x'.repeat(43),workspaceId:'fixture-workspace',sessionId:'fixture-provider-session',claim},options);
 saveConnectedState(key,{provider:'codex',runtimeId:id(11),nonce:'fixture-runtime-key',identity:{accountId:id(8),orgId:id(9)},paused:false,startups:{[startupKey]:{sessionId:id(12),phase:'registered',nativeSessionId:threadBinding.threadId,threadBinding}}},options);
 const issueStarted=defer(),releaseIssue=defer(),running=defer(),http=[],native=[],adapters=[];
 let effect=null,replyProof=null,replyCalls=0,rejectRemote=false;
 const view=()=>({...effect,...(replyProof?{reply:replyProof}:{})});
 const fetchImpl=async(url,init)=>{
  const path=new URL(url).pathname,body=JSON.parse(init.body);http.push({path,body});
  assert.equal(init.method,'POST');assert.equal(init.redirect,'error');assert.equal(init.headers.authorization,'Bearer fixture-capture-key');assert.equal(init.headers['x-codebrief-runtime-credential'],'fixture-runtime-key');assert.equal(init.headers['x-codebrief-tandem-credential'],'x'.repeat(43));
  assert.deepEqual(body.repo,{fullName:'fixture/repo'});assert.equal(body.runtimeId,id(11));assert.equal(body.sessionId,id(12));assert.deepEqual(body.claim,claim);assert.equal(body.workspaceId,'fixture-workspace');assert.equal('threadId'in body,false);assert.equal('replyId'in body,false);
  if(rejectRemote)return Response.json({error:'unavailable'},{status:503});
  const operation=path.split('/').at(-1);
  if(operation==='pending'){assert.deepEqual(Object.keys(body).sort(),['claim','repo','runtimeId','sessionId','workspaceId']);return Response.json({requests:[{requestId,digest}]});}
  if(operation==='reply'){
   replyCalls++;assert.equal(body.input.requestId,requestId);assert.equal(body.input.replyId,replyId);assert.equal(body.input.digest,digest);assert.equal(body.input.text,answer);
   replyProof={replyId:wrongReplyProof?id(99):replyId,requestId,sessionId:id(12),replyDigest:createHash('sha256').update(JSON.stringify(body.input)).digest('hex')};effect.replyState='confirmed';
   if(loseReplyResponse)throw Error('fixture committed reply before response loss');
   return Response.json({requestId,recipientSessionId:id(12),generation:claim.generation});
  }
  assert.equal(body.requestId,requestId);assert.equal(body.digest,digest);
  if(operation==='reserve'){assert.equal(effect,null);effect={effectId:requestId,state:'reserved',leaseToken,leaseGeneration:1,replyId,replyState:'not_sent'};return Response.json(view());}
  if(operation==='issue'){
   assert.equal(body.effectId,requestId);assert.equal(body.leaseToken,leaseToken);assert.equal(body.leaseGeneration,1);assert.equal(effect.state,'reserved');effect.state='issued_unknown';const receipt={...view(),text:question,digest,thread:threadBinding};issueStarted.resolve();if(delayIssue)await releaseIssue.promise;return Response.json(receipt);
  }
  if(operation==='report'){
   assert.equal(body.effectId,requestId);assert.equal(body.leaseToken,leaseToken);assert.equal(body.leaseGeneration,1);assert.equal(body.turnId,turnId);effect.state=body.state;if(body.state==='running')running.resolve();return Response.json(view());
  }
  if(operation==='stop'){effect.state='stop_requested';return Response.json(view());}
  if(operation==='read')return Response.json(view());
  assert.fail('Composition must use pending, never legacy inbox or another endpoint');
 };
 const context={root,options,credentials,repoFullName:'fixture/repo',fetchImpl};
 function spawnServer(client,ref){
  const thread={id:threadBinding.threadId,sessionId:threadBinding.sessionId,cwd:root,cliVersion:threadBinding.cliVersion};
  const program=`const {createInterface}=require('node:readline');const thread=${JSON.stringify(thread)};const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');const completed=status=>emit({method:'turn/completed',params:{threadId:thread.id,turn:{id:${JSON.stringify(turnId)},status,itemsView:'full',items:status==='completed'?[{type:'agentMessage',id:'final',phase:'final_answer',text:${JSON.stringify(answer)}}]:[]}}});createInterface({input:process.stdin}).on('line',line=>{const r=JSON.parse(line);if(!r.id)return;let result={};if(r.method==='thread/read'){if(r.params.includeTurns!==false)process.exit(41);result={thread};}if(r.method==='thread/resume'){if(r.params.threadId!==thread.id||Object.keys(r.params).length!==1)process.exit(42);result={thread,cwd:thread.cwd,model:'fixture-model',modelProvider:'fixture-provider',approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}};}if(r.method==='turn/start'){if(r.params.threadId!==thread.id||r.params.input[0].text!==${JSON.stringify(question)}||r.params.sandboxPolicy.type!=='readOnly'||r.params.sandboxPolicy.networkAccess!==false)process.exit(43);result={turn:{id:${JSON.stringify(turnId)},status:'inProgress'}};}if(r.method==='turn/interrupt'){if(r.params.threadId!==thread.id||r.params.turnId!==${JSON.stringify(turnId)})process.exit(44);}emit({id:r.id,result});if(r.method==='turn/start'&&${JSON.stringify(mode)}==='complete')setTimeout(()=>completed('completed'),5);if(r.method==='turn/interrupt')setTimeout(()=>completed('interrupted'),5);});`;
  const child=spawn(process.execPath,['-e',program],{stdio:['pipe','pipe','ignore']});const originalWrite=child.stdin.write.bind(child.stdin);
  child.stdin.write=data=>{const rpc=JSON.parse(data);native.push({method:rpc.method,threadId:rpc.params?.threadId,turnId:rpc.params?.turnId});if(rpc.method==='turn/start'){const row=client.journal.load(ref);assert.equal(row.state,'issued_unknown');assert.equal(row.lease.effectId,requestId);assert.equal(row.lease.replyId,replyId);assert.equal(row.turnId,null);}return originalWrite(data);};return child;
 }
 async function compose(){const client=createProtocolTestNativeTurnClient(context),pending=await client.pending();assert.deepEqual(pending,{requests:[{requestId,digest}]});const ref={...structuredClone(client.bound),...pending.requests[0]};const adapter=await createNativeTurnAdapter(client.threadBinding,{spawnServer:()=>spawnServer(client,ref),timeoutMs:1000});adapters.push(adapter);const consumer=createNativeTurnConsumer(client.bound,{adapter,journal:client.journal,reserve:client.reserve,issue:client.issue,report:client.report,read:client.read,requestStop:client.requestStop,reply:client.reply,assertCurrent:client.assertCurrent});return{client,ref,consumer};}
 function journalText(){return readFileSync(join(options.baseDir,'connected-agents/v1',key,'native-effects.json'),'utf8');}
 return{compose,http,native,issueStarted,releaseIssue,running,journalText,get replyCalls(){return replyCalls;},pause(){const state=loadConnectedState(key,options);saveConnectedState(key,{...state,paused:true},options);rejectRemote=true;},cleanup(){for(const adapter of adapters)adapter.close();rmSync(base,{recursive:true,force:true});}};
}

test('actual client/consumer/journal/adapter verifies exact reply UUID and digest before confirming',async()=>{
 const f=await fixture();try{const {client,ref,consumer}=await f.compose();assert.deepEqual(await settle(consumer.run(ref)),{state:'completed',turnId});assert.equal(f.replyCalls,1);const row=client.journal.load(ref);assert.equal(row.lease.replyId,replyId);assert.equal(row.lease.leaseToken,leaseToken);assert.equal(row.turnId,turnId);assert.equal(row.state,'completed');assert.equal(f.native.filter(rpc=>rpc.method==='turn/start').length,1);assert.ok(f.http.some(call=>call.path.endsWith('native-turns/read')));assert.ok(!f.journalText().includes(question)&&!f.journalText().includes(answer)&&!f.journalText().includes('fixture-capture-key'));}finally{f.cleanup();}
});
test('reply commit then lost response restarts original journal without a second turn or reply',async()=>{
 const f=await fixture({loseReplyResponse:true});try{const first=await f.compose();assert.deepEqual(await settle(first.consumer.run(first.ref)),{state:'completed',turnId,replyState:'unknown'});first.consumer.close();const restart=await f.compose();assert.deepEqual(await settle(restart.consumer.run(restart.ref)),{state:'completed',turnId,replyState:'confirmed'});assert.equal(f.replyCalls,1);assert.equal(f.native.filter(rpc=>rpc.method==='turn/start').length,1);assert.equal(f.http.filter(call=>call.path.endsWith('native-turns/reserve')).length,1);assert.equal(f.http.filter(call=>call.path.endsWith('native-turns/issue')).length,1);assert.equal(restart.client.journal.load(restart.ref).lease.replyId,replyId);}finally{f.cleanup();}
});
test('mismatched exact reply proof stays unknown despite a confirmed projection',async()=>{
 const f=await fixture({wrongReplyProof:true});try{const {consumer,ref}=await f.compose();assert.deepEqual(await settle(consumer.run(ref)),{state:'completed',turnId,replyState:'unknown'});consumer.close();const restart=await f.compose();const reconciled=await settle(restart.consumer.run(restart.ref));assert.notEqual(reconciled.replyState,'confirmed','Restart must validate original authenticated reply proof identity');assert.equal(f.replyCalls,1);assert.equal(f.native.filter(rpc=>rpc.method==='turn/start').length,1);}finally{f.cleanup();}
});
test('Stop during issued receipt delay prevents turn/start and restart never reissues',async()=>{
 const f=await fixture({delayIssue:true});try{const first=await f.compose(),execution=first.consumer.run(first.ref);await settle(f.issueStarted.promise);assert.deepEqual(await first.consumer.stop(first.ref),{state:'stopped_unknown'});f.releaseIssue.resolve();assert.deepEqual(await settle(execution),{state:'issued_unknown'});assert.equal(f.native.filter(rpc=>rpc.method==='turn/start').length,0);first.consumer.close();const restart=await f.compose();assert.deepEqual(await settle(restart.consumer.run(restart.ref)),{state:'issued_unknown'});assert.equal(f.http.filter(call=>call.path.endsWith('native-turns/issue')).length,1);assert.equal(f.replyCalls,0);}finally{f.releaseIssue.resolve();f.cleanup();}
});
test('known in-flight original turn is interrupted locally after authority and remote reporting loss',async()=>{
 const f=await fixture({mode:'wait'});try{const {client,ref,consumer}=await f.compose(),execution=consumer.run(ref);await settle(f.running.promise);assert.equal(client.journal.load(ref).turnId,turnId);f.pause();assert.deepEqual(await consumer.stop(ref),{state:'stop_requested',turnId});const outcome=await settle(execution);assert.equal(outcome.state,'stopped');assert.deepEqual(f.native.filter(rpc=>rpc.method==='turn/interrupt'),[{method:'turn/interrupt',threadId:client.bound.threadId,turnId}]);assert.equal(f.native.filter(rpc=>rpc.method==='turn/start').length,1);assert.equal(f.replyCalls,0);await assert.rejects(consumer.run({...ref,requestId:id(24)}),{code:'session_unavailable'});}finally{f.cleanup();}
});
