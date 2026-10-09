import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {installConductorSession} from './tandem-client.js';
import {localConnectionKey,saveConnectedState} from './connected-agent-state.js';
const packageRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
for(const host of ['claude','codex'])test(`${host} actual packaged native private tool invoke read erase binds runtime and exact current claim`,()=>{
 const base=mkdtempSync(join(tmpdir(),'native-inbox-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
  const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},identity={accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},runtimeId=randomUUID(),sessionId=randomUUID(),credentials={apiKey:'fixture-capture',apiBaseUrl:'https://app.codebrief.ai'};
  installConductorSession(root,{credential:'fixture-tandem',claim,identity,workspaceId:'fixture-workspace',sessionId:'fixture-native'},{baseDir:state});
  saveConnectedState(localConnectionKey(credentials.apiKey,host),{runtimeId,nonce:'fixture-runtime-private',provider:host,identity:{...identity,provider:host,runtimeId},startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{phase:'registered',sessionId,nativeSessionId:'fixture-native'}}},{baseDir:state});
  const roomId=randomUUID(),request={operation:'invoke',roomId,input:{operationId:randomUUID(),toolId:'glob',args:{pattern:'src/*'}}},input=join(base,'input.json'),audit=join(base,'audit.json');writeFileSync(input,JSON.stringify(request));writeFileSync(audit,'[]');
  const entry=join(packageRoot,host==='claude'?'scripts/codebrief-cli.js':'codex/codebrief-capture/scripts/codebrief-cli.js'),wrapper=join(base,'wrapper.mjs');
  writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';const {entry,audit,root,state,requestId,credentials,runtimeId,sessionId,attemptId,roomId}=JSON.parse(process.argv[2]);const {main}=await import(entry);process.exitCode=await main(process.argv.slice(3),{loadCreds:()=>(credentials),resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root:root,options:{baseDir:state},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),operation=url.split('/').at(-1),calls=JSON.parse(readFileSync(audit));if(!url.startsWith('https://app.codebrief.ai/api/capture/rooms/tools/')||init.headers['x-codebrief-runtime-credential']!=='fixture-runtime-private'||init.headers['x-codebrief-tandem-credential']!=='fixture-tandem'||body.runtimeId!==runtimeId||body.sessionId!==sessionId||body.claim.attemptId!==attemptId)throw Error();if(body.roomId!==roomId)throw Error();calls.push(operation);writeFileSync(audit,JSON.stringify(calls));return Response.json({invocation:{operationId:requestId,phase:operation==='erase'?'erased':'succeeded'}});}}});`);
  const run=command=>{const args=['agents','tool','--provider',host,'--input',input];const r=spawnSync(process.execPath,[wrapper,JSON.stringify({entry:new URL('file://'+entry).href,audit,root,state,requestId:request.input.operationId,credentials,runtimeId,sessionId,attemptId:claim.attemptId,roomId}),...args],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  assert.equal(run().invocation.operationId,request.input.operationId);for(const operation of ['read','erase']){writeFileSync(input,JSON.stringify({operation,roomId,operationId:request.input.operationId}));assert.equal(run().invocation.operationId,request.input.operationId);}assert.deepEqual(JSON.parse(readFileSync(audit)),['invoke','read','erase']);writeFileSync(input,JSON.stringify({...request,result:'forged'}));const before=readFileSync(audit,'utf8');assert.throws(()=>run());assert.equal(readFileSync(audit,'utf8'),before);
 }finally{rmSync(base,{recursive:true,force:true});}
});


for(const host of ['claude','codex'])test(`${host} actual packaged Conductor tools use only exact launch relay, no broad Capture key`,()=>{
 const base=mkdtempSync(join(tmpdir(),'conductor-tools-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
  const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},launchId=randomUUID();
  installConductorSession(root,{launchId,credential:'fixture-private-relay',claim,identity:{accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},workspaceId:'fixture-workspace',sessionId:'fixture-session'},{baseDir:state});
  const roomId=randomUUID(),request={operation:'invoke',roomId,input:{operationId:randomUUID(),toolId:'glob',args:{pattern:'src/*'}}},input=join(base,'input.json'),audit=join(base,'audit.json');writeFileSync(input,JSON.stringify(request));writeFileSync(audit,'[]');
  const entry=join(packageRoot,host==='claude'?'scripts/codebrief-cli.js':'codex/codebrief-capture/scripts/codebrief-cli.js'),wrapper=join(base,'wrapper.mjs');
  writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';const {entry,audit,root,state,launchId,attemptId,roomId,operationId}=JSON.parse(process.argv[2]);const {main}=await import(entry);process.exitCode=await main(process.argv.slice(3),{loadCreds:()=>null,resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root,options:{baseDir:state},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),calls=JSON.parse(readFileSync(audit));if(url!=='https://app.codebrief.ai/api/conductor/launches/'+launchId+'/relay'||init.headers.authorization!=='Bearer fixture-private-relay'||body.operation!=='room_tool'||body.payload.claim.attemptId!==attemptId||body.payload.tool.roomId!==roomId)throw Error();calls.push(body.payload.tool.operation);writeFileSync(audit,JSON.stringify(calls));return Response.json({invocation:{operationId,phase:body.payload.tool.operation==='erase'?'erased':'succeeded'}});}}});`);
  const run=()=>{const r=spawnSync(process.execPath,[wrapper,JSON.stringify({entry:new URL('file://'+entry).href,audit,root,state,launchId,attemptId:claim.attemptId,roomId,operationId:request.input.operationId}),'agents','tool','--provider','conductor','--input',input],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout);};
  run();for(const operation of ['read','erase']){writeFileSync(input,JSON.stringify({operation,roomId,operationId:request.input.operationId}));run();}assert.deepEqual(JSON.parse(readFileSync(audit)),['invoke','read','erase']);
 }finally{rmSync(base,{recursive:true,force:true});}
});
