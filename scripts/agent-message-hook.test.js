import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentCheckpointHook} from './agent-message-hook.js';
import {randomUUID} from 'node:crypto';
test('opted-in checkpoint exposes IDs only after exact registration and inbox authority',async()=>{
 const requestId=randomUUID(),calls=[];const result=await runAgentCheckpointHook({session_id:'native-exact',hook_event_name:'UserPromptSubmit',prompt:'SECRET',transcript_path:'SECRET'}, {credentials:{apiKey:'fixture'},repo:{fullName:'fixture/app'},config:{enabledRepos:['fixture/app']},run:async(args,context)=>{calls.push({args,context});if(calls.length===1)throw Object.assign(new Error('missing'),{code:'checkpoint_session_required'});return args[0]==='checkpoint'?{sessionId:randomUUID()}:{requests:[{requestId,text:'SECRET',digest:'a'.repeat(64)}]};}});
 assert.deepEqual(calls.map(c=>c.args[0]),['inbox','checkpoint','inbox']);assert.equal(calls[0].context.hookSessionId,'native-exact');assert.equal(result.hookSpecificOutput.hookEventName,'UserPromptSubmit');assert.match(result.hookSpecificOutput.additionalContext,new RegExp(requestId));assert.doesNotMatch(JSON.stringify(result),/SECRET|aaaa/);assert.equal(calls[0].context.deadline,calls[1].context.deadline);
});
test('disabled, unsupported, malformed or failed checkpoint remains silent and bounded',async()=>{
 let calls=0;const deps={credentials:{apiKey:'fixture'},repo:{fullName:'fixture/app'},config:{enabledRepos:[]},run:async()=>{calls++;throw Error('SECRET');}};
 assert.equal(await runAgentCheckpointHook({session_id:'native',hook_event_name:'SessionStart'},deps),null);assert.equal(calls,0);
 deps.config.enabledRepos=['fixture/app'];assert.equal(await runAgentCheckpointHook({session_id:'native',hook_event_name:'SessionEnd'},deps),null);assert.equal(await runAgentCheckpointHook({session_id:'native',hook_event_name:'PostToolUse'},deps),null);assert.equal(calls,1);
});
import {spawnSync} from 'node:child_process';
test('actual bounded hook child process ignores transcript fields and emits only explicit request IDs',()=>{
 const id=randomUUID(),module=new URL('./agent-message-hook.js',import.meta.url).href;
 const script=`import {readAgentHookInput,runAgentCheckpointHook} from ${JSON.stringify(module)};const result=await runAgentCheckpointHook(await readAgentHookInput(),{credentials:{apiKey:'fixture'},repo:{fullName:'fixture/app'},config:{enabledRepos:['fixture/app']},run:async args=>args[0]==='checkpoint'?{}:{requests:[{requestId:${JSON.stringify(id)},text:'SECRET'}]}});if(result)console.log(JSON.stringify(result));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({hook_event_name:'PostToolUse',session_id:'exact-native',tool_input:'SECRET',transcript_path:'SECRET'}),encoding:'utf8',timeout:6000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,new RegExp(id));assert.doesNotMatch(result.stdout,/SECRET/);
 const oversized=spawnSync(process.execPath,['--input-type=module','-e',script],{input:'x'.repeat(16385),encoding:'utf8',timeout:6000});assert.equal(oversized.status,0);assert.equal(oversized.stdout,'');
});
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {installConductorSession} from './lib/tandem-client.js';
import {localConnectionKey,saveConnectedState,updateCompanion} from './lib/connected-agent-state.js';
test('actual hook client reads an existing fenced session without checkpoint admission or companion mutation',async()=>{
 const base=mkdtempSync(join(tmpdir(),'hook-composition-')),root=join(base,'repo'),options={baseDir:join(base,'state')};mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
 const credentials={apiKey:'fixture',apiBaseUrl:'https://app.codebrief.ai'},identity={accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},runtimeId=randomUUID(),sessionId=randomUUID(),key=localConnectionKey(credentials.apiKey,'claude'),requestId=randomUUID();
 installConductorSession(root,{credential:'fixture-claim',claim,identity,workspaceId:'fixture-workspace',sessionId:'native-exact'},options);
 const state={runtimeId,nonce:'fixture-runtime',provider:'claude',identity:{...identity,provider:'claude',runtimeId},startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{phase:'registered',sessionId,nativeSessionId:'native-exact'}}};saveConnectedState(key,state,options);const companion={id:randomUUID(),generation:1,pid:process.pid,active:true,runtimeId};updateCompanion(key,options,()=>companion);
 const calls=[],deps={credentials,repo:{fullName:'fixture/app'},config:{enabledRepos:['fixture/app']},context:{root,options,fetchImpl:async(url,init)=>{calls.push(url.split('/').at(-1));const body=JSON.parse(init.body);assert.equal(body.sessionId,sessionId);assert.equal(body.nativeSessionId,'native-exact');assert.equal(body.companion,undefined);return Response.json({requests:[{requestId}],nextCursor:null});}}};
 const result=await runAgentCheckpointHook({session_id:'native-exact',hook_event_name:'UserPromptSubmit'},deps);assert.ok(result);assert.deepEqual(calls,['inbox']);
 assert.equal(await runAgentCheckpointHook({session_id:'stale-native',hook_event_name:'PostToolUse'},deps),null);assert.deepEqual(calls,['inbox']);
 saveConnectedState(key,{...state,startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{phase:'issued',sessionId,nativeSessionId:'native-exact'}}},options);assert.equal(await runAgentCheckpointHook({session_id:'native-exact',hook_event_name:'PostToolUse'},deps),null);assert.deepEqual(calls,['inbox']);
 saveConnectedState(key,{...state,paused:true},options);assert.equal(await runAgentCheckpointHook({session_id:'native-exact',hook_event_name:'PostToolUse'},deps),null);assert.deepEqual(calls,['inbox']);
 }finally{rmSync(base,{recursive:true,force:true});}
});
