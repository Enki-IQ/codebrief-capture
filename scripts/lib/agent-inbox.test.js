import test from 'node:test';
import assert from 'node:assert/strict';
import {readAgentMessageInput,validateAgentMessageInput} from './agent-inbox.js';
import {randomUUID} from 'node:crypto';
test('peer request has exact structured target and caller cannot choose sender authority',()=>{const input={requestId:randomUUID(),actionId:randomUUID(),recipientSessionId:randomUUID(),expectedRecipientGeneration:1,text:'Please check this boundary.',parentRequestId:null};assert.deepEqual(validateAgentMessageInput('request',input),input);assert.throws(()=>validateAgentMessageInput('request',{...input,senderSessionId:randomUUID()}));assert.throws(()=>validateAgentMessageInput('request',{...input,text:'\ud800'}));});

import {mkdtempSync,realpathSync,symlinkSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installConductorSession} from './tandem-client.js';
const packageRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
for(const host of ['claude','codex'])test(`${host} actual packaged Conductor request inbox ACK reply needs only frozen relay authority`,()=>{
 const base=mkdtempSync(join(tmpdir(),'agent-inbox-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
  const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'};
  installConductorSession(root,{launchId:randomUUID(),credential:'fixture-private-relay',claim,identity:{accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},workspaceId:'fixture-workspace',sessionId:'fixture-session'},{baseDir:state});
  const request={requestId:randomUUID(),actionId:claim.actionId,recipientSessionId:randomUUID(),expectedRecipientGeneration:1,text:'Scoped peer request',parentRequestId:null},input=join(base,'input.json'),audit=join(base,'audit.json');writeFileSync(input,JSON.stringify(request));writeFileSync(audit,'[]');
  const entry=join(packageRoot,host==='claude'?'scripts/codebrief-cli.js':'codex/codebrief-capture/scripts/codebrief-cli.js'),wrapper=join(base,'wrapper.mjs');
  writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';const {entry,audit,root,state,requestId,credentials,runtimeId,sessionId,attemptId}=JSON.parse(process.argv[2]);const {main}=await import(entry);process.exitCode=await main(process.argv.slice(3),{loadCreds:()=>null,resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root:root,options:{baseDir:state},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),calls=JSON.parse(readFileSync(audit));if(!url.startsWith('https://app.codebrief.ai/api/conductor/launches/')||init.headers.authorization!=='Bearer fixture-private-relay')throw Error();calls.push(body.operation);writeFileSync(audit,JSON.stringify(calls));return Response.json(body.operation==='inbox'?{requests:[{requestId:requestId,digest:'a'.repeat(64),text:'Scoped peer request'}],nextCursor:null}:{requestId:requestId,replyCount:body.operation==='reply'?1:0});}}});`);
  const run=(command)=>{const args=['agents',command,'--provider','conductor'];if(command!=='inbox')args.push('--input',input);const result=spawnSync(process.execPath,[wrapper,JSON.stringify({entry:new URL('file://'+entry).href,audit,root,state,requestId:request.requestId}),...args],{cwd:root,encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);};
  assert.equal(run('request').requestId,request.requestId);assert.equal(run('inbox').requests[0].requestId,request.requestId);
  writeFileSync(input,JSON.stringify({requestId:request.requestId,digest:'a'.repeat(64)}));run('ack');writeFileSync(input,JSON.stringify({requestId:request.requestId,replyId:randomUUID(),digest:'a'.repeat(64),text:'Scoped explicit reply'}));assert.equal(run('reply').replyCount,1);
  assert.deepEqual(JSON.parse(readFileSync(audit)),['request','inbox','ack','reply']);
 }finally{rmSync(base,{recursive:true,force:true});}
});
import {localConnectionKey,saveConnectedState} from './connected-agent-state.js';
for(const host of ['claude','codex'])test(`${host} actual packaged native private request inbox ACK reply binds runtime and exact current claim`,()=>{
 const base=mkdtempSync(join(tmpdir(),'native-inbox-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
  const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},identity={accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},runtimeId=randomUUID(),sessionId=randomUUID(),credentials={apiKey:'fixture-capture',apiBaseUrl:'https://app.codebrief.ai'};
  installConductorSession(root,{credential:'fixture-tandem',claim,identity,workspaceId:'fixture-workspace',sessionId:'fixture-native'},{baseDir:state});
  const threadBinding={threadId:randomUUID(),sessionId:randomUUID(),cwd:realpathSync(root),cliVersion:'0.145.0',model:'gpt-6.1',modelProvider:'openai'};
 const bin=join(base,'bin');mkdirSync(bin);writeFileSync(join(bin,'codex'),`#!${process.execPath}\nimport {createInterface} from 'node:readline';const binding=${JSON.stringify(threadBinding)};createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;if(!['initialize','thread/read'].includes(m.method))process.exit(2);if(m.method==='thread/read'&&(m.params.threadId!==binding.threadId||m.params.includeTurns!==false))process.exit(3);console.log(JSON.stringify({id:m.id,result:m.method==='thread/read'?{thread:{id:binding.threadId,sessionId:binding.sessionId,cwd:binding.cwd,cliVersion:binding.cliVersion}}:{}}));});\n`,{mode:0o700});
 saveConnectedState(localConnectionKey(credentials.apiKey,host),{runtimeId,nonce:'fixture-runtime-private',provider:host,identity:{...identity,provider:host,runtimeId},startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{phase:'registered',sessionId,nativeSessionId:host==='codex'?threadBinding.threadId:'fixture-native',...(host==='codex'?{threadBinding}:{})}}},{baseDir:state});
  const request={requestId:randomUUID(),actionId:claim.actionId,recipientSessionId:randomUUID(),expectedRecipientGeneration:1,text:'Explicit peer request',parentRequestId:null},input=join(base,'input.json'),audit=join(base,'audit.json');writeFileSync(input,JSON.stringify(request));writeFileSync(audit,'[]');
  const entry=join(packageRoot,host==='claude'?'scripts/codebrief-cli.js':'codex/codebrief-capture/scripts/codebrief-cli.js'),wrapper=join(base,'wrapper.mjs');
  writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';const {entry,audit,root,state,requestId,credentials,runtimeId,sessionId,attemptId}=JSON.parse(process.argv[2]);const {main}=await import(entry);process.exitCode=await main(process.argv.slice(3),{loadCreds:()=>(credentials),resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root:root,options:{baseDir:state},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),operation=url.split('/').at(-1),calls=JSON.parse(readFileSync(audit));if(!url.startsWith('https://app.codebrief.ai/api/capture/connected-agents/')||init.headers['x-codebrief-runtime-credential']!=='fixture-runtime-private'||init.headers['x-codebrief-tandem-credential']!=='fixture-tandem'||body.runtimeId!==runtimeId||body.sessionId!==sessionId||body.claim.attemptId!==attemptId)throw Error();calls.push(operation);writeFileSync(audit,JSON.stringify(calls));return Response.json(operation==='inbox'?{requests:[{requestId:requestId,digest:'b'.repeat(64),text:'Explicit peer request'}],nextCursor:null}:{requestId:requestId,replyCount:operation==='reply'?1:0});}}});`);
  const run=command=>{const args=['agents',command,'--provider',host];if(command!=='inbox')args.push('--input',input);const r=spawnSync(process.execPath,[wrapper,JSON.stringify({entry:new URL('file://'+entry).href,audit,root,state,requestId:request.requestId,credentials,runtimeId,sessionId,attemptId:claim.attemptId}),...args],{cwd:root,encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`}});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  run('request');assert.equal(run('inbox').requests[0].requestId,request.requestId);writeFileSync(input,JSON.stringify({requestId:request.requestId,digest:'b'.repeat(64)}));run('ack');writeFileSync(input,JSON.stringify({requestId:request.requestId,replyId:randomUUID(),digest:'b'.repeat(64),text:'Explicit reply'}));assert.equal(run('reply').replyCount,1);assert.deepEqual(JSON.parse(readFileSync(audit)),['request','inbox','ack','reply']);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('agent input rejects symlink and nonregular paths and enforces descriptor byte bound',()=>{
 const base=mkdtempSync(join(tmpdir(),'agent-input-'));try{
  const file=join(base,'input.json'),link=join(base,'link.json');
  const value={requestId:randomUUID(),actionId:randomUUID(),recipientSessionId:randomUUID(),expectedRecipientGeneration:1,text:'Bounded input',parentRequestId:null};
  writeFileSync(file,JSON.stringify(value));assert.deepEqual(readAgentMessageInput('request',file),value);
  symlinkSync(file,link);assert.throws(()=>readAgentMessageInput('request',link),/agent_request_unavailable/);
  assert.throws(()=>readAgentMessageInput('request',base),/agent_request_unavailable/);
  writeFileSync(file,' '.repeat(49153));assert.throws(()=>readAgentMessageInput('request',file),/agent_request_unavailable/);
 }finally{rmSync(base,{recursive:true,force:true});}
});

import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
test('agent input validates and reads the same inode when path is replaced after descriptor inspection',()=>{
 const base=mkdtempSync(join(tmpdir(),'agent-input-race-')),file=join(base,'input.json'),replacement=join(base,'replacement.json');
 const value={requestId:randomUUID(),actionId:randomUUID(),recipientSessionId:randomUUID(),expectedRecipientGeneration:1,text:'Original descriptor',parentRequestId:null};
 const original=fs.fstatSync;
 try{
  writeFileSync(file,JSON.stringify(value));writeFileSync(replacement,'invalid replacement');
  fs.fstatSync=(...args)=>{const stat=original(...args);fs.renameSync(replacement,file);return stat;};syncBuiltinESMExports();
  assert.deepEqual(readAgentMessageInput('request',file),value);
 }finally{fs.fstatSync=original;syncBuiltinESMExports();rmSync(base,{recursive:true,force:true});}
});
