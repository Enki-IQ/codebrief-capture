import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchRelayRequest} from './conductor-bootstrap.js';
test('launch transport denies broad commands and never sends ordinary Capture API key',async()=>{
 let calls=0;const session={launchId:'11111111-1111-4111-8111-111111111111',credential:'restricted',workspaceId:'workspace'};
 const context={apiBaseUrl:'https://app.codebrief.ai',session,fetchImpl:async(url,options)=>{calls++;assert.equal(options.headers.authorization,'Bearer restricted');assert.equal(JSON.parse(options.body).operation,'verify');assert.equal(JSON.parse(options.body).payload.workspaceId,'workspace');return Response.json({ownershipVerified:true});}};
 await assert.rejects(()=>launchRelayRequest({...context,operation:'claim',payload:{}}),/unsupported/i);assert.equal(calls,0);
 assert.equal((await launchRelayRequest({...context,operation:'register',payload:{verify:{claim:{},workspaceId:'local'}}})).ownershipVerified,true);assert.equal(calls,1);
});
import {mkdtempSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {bootstrapConductorCapture} from './conductor-bootstrap.js';
test('actual bootstrap preserves lost-exchange envelope and scope claim before ready without secret output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'conductor-preflight-')),baseDir=mkdtempSync(join(tmpdir(),'conductor-state-'));
 execFileSync('git',['init',root]);execFileSync('git',['-C',root,'config','user.email','test@example.com']);execFileSync('git',['-C',root,'config','user.name','Test']);mkdirSync(join(root,'src'));writeFileSync(join(root,'src','example.ts'),'ok');execFileSync('git',['-C',root,'add','src/example.ts']);execFileSync('git',['-C',root,'commit','-m','base']);
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),launchId=randomUUID(),instanceId=randomUUID();
 const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:2,leaseExpiresAt:new Date(Date.now()+10000).toISOString()};
 const orgId=randomUUID(),credential=`${orgId}.${'r'.repeat(43)}`,token=`${randomUUID()}.${'t'.repeat(43)}`,envelopes=[];let scopeCalls=0,readyCalls=0;
 const context={root,options:{baseDir},workspaceId:'workspace-1',sessionId:'session-2',env:{CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:token,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},fetchImpl:async(url,options)=>{
  const payload=JSON.parse(options.body);if(url.endsWith('/exchange')){envelopes.push(payload);if(envelopes.length===1){const error=new Error("lost response");error.status=503;throw error;}return Response.json({launchId,instanceId,credential,claim,identity:{orgId,repoId:randomUUID(),accountId:randomUUID()}});}
  if(url.endsWith('/ready')){readyCalls++;assert.equal(payload.claim.version,3);assert.equal(payload.workspaceId,'workspace-1');assert.equal(payload.sessionId,'session-2');return Response.json({ready:true});}
  if(payload.operation==='setup')return Response.json({protocolVersion:1,purpose:'implement',plannedFiles:['src/example.ts'],claim});
  if(payload.operation==='scope'){scopeCalls++;assert.deepEqual(payload.payload.canonicalScope,[{kind:'file',path:'src/example.ts'}]);return Response.json({claim:{...claim,version:3}});}
  throw new Error('Unexpected request');
 }};
 let installCalls=0;
 await assert.rejects(()=>bootstrapConductorCapture({...context,install:()=>{installCalls++;throw new Error('simulated local save failure');}}),/save failure/);
 const result=await bootstrapConductorCapture({...context,install:()=>{installCalls++;}});
 assert.deepEqual(result,{ready:true,launchId,attemptId:claim.attemptId});assert.equal(envelopes.length,2);assert.deepEqual(envelopes[0],envelopes[1]);assert.equal(scopeCalls,1);assert.equal(readyCalls,1);assert.equal(installCalls,2);assert.ok(!JSON.stringify(result).includes(credential));
});

test('bootstrap reinstall preserves newer claim and unresolved renewal',async()=>{
 const {installConductorSession,readConductorSession}=await import('./tandem-client.js');
 const root=mkdtempSync(join(tmpdir(),'bootstrap-resume-')),options={baseDir:mkdtempSync(join(tmpdir(),'bootstrap-resume-state-'))};
 execFileSync('git',['init','-q',root]);
 const id=randomUUID(),claim={attemptId:randomUUID(),instanceId:randomUUID(),generation:2,version:4};
 const saved={launchId:id,credential:'restricted',workspaceId:'workspace',sessionId:'session',identity:{accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},claim,pendingRenewal:{requestId:randomUUID()}};
 installConductorSession(root,saved,options);
 installConductorSession(root,{...saved,claim:{...claim,version:2,generation:1},pendingRenewal:undefined},options);
 const resumed=readConductorSession(root,options);
 assert.equal(resumed.claim.version,4);assert.deepEqual(resumed.pendingRenewal,saved.pendingRenewal);
});

import {main as claudeMain} from '../codebrief-cli.js';
import {main as codexMain} from '../../codex/codebrief-capture/scripts/codebrief-cli.js';
for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} actual CLI bootstrap heartbeat checkpoint uses only launch credential`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'launch-cli-')),options={baseDir:mkdtempSync(join(tmpdir(),'launch-cli-state-'))};
 execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'config','user.email','test@example.com']);execFileSync('git',['-C',root,'config','user.name','Test']);writeFileSync(join(root,'a'),'ok');execFileSync('git',['-C',root,'add','a']);execFileSync('git',['-C',root,'commit','-qm','base']);
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),launchId=randomUUID(),orgId=randomUUID(),instanceId=randomUUID(),credential=`${orgId}.${'r'.repeat(43)}`;
 let claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:2,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()};
 const calls=[],logs=[],errors=[];let recoveryCalls=0,recoveryEnvelope,recoveryClaim;
 const context={root,options,env:{CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:`${orgId}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},readInput:()=>({baseSha:head,dirty:[],untracked:[],decisions:[],commands:[],nextSteps:[],unresolvedRisks:[]}),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,body});
  if(url.endsWith('/exchange'))return Response.json({launchId,instanceId,credential,claim,identity:{accountId:randomUUID(),orgId,repoId:randomUUID()}});
  assert.equal(init.headers.authorization,`Bearer ${credential}`);
  if(url.endsWith('/ready')){assert.equal(body.claim.version,claim.version);return Response.json({ready:true});}
  if(body.operation==='setup')return Response.json({protocolVersion:1,purpose:'implement',plannedFiles:['a'],claim});
  if(body.operation==='scope'||body.operation==='renew'){claim={...claim,version:claim.version+1};return Response.json({claim});}
  if(body.operation==='verify'){assert.equal(body.payload.workspaceId,'workspace');return Response.json({ownershipVerified:true,terminalClosed:false});}
  if(body.operation==='recover'){recoveryCalls++;if(!recoveryEnvelope){recoveryEnvelope=body.payload;recoveryClaim={...claim,generation:claim.generation+1,version:claim.version+1};throw new Error('lost recovery response');}assert.deepEqual(body.payload,recoveryEnvelope);claim=recoveryClaim;return Response.json({claim,credential});}
  throw new Error('Unexpected operation');
 }};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>{throw new Error('Broad credential access forbidden');},loadConfig:()=>({}),log:v=>logs.push(v),error:v=>errors.push(v),tandemContext:context};
 assert.equal(await main(['tandem','bootstrap','workspace','session'],overrides),0,JSON.stringify(errors));
 assert.equal(await main(['tandem','heartbeat'],overrides),0,JSON.stringify(errors));
 assert.equal(await main(['tandem','checkpoint','input'],overrides),0,JSON.stringify(errors));
 assert.equal(JSON.parse(logs.at(-1)).ready,true);assert.deepEqual(errors,[]);assert.ok(!JSON.stringify(logs).includes(credential));assert.equal(calls.filter(v=>v.body.operation==='renew').length,1);
 const recoveryOverrides={...overrides,tandemContext:{...context,readInput:()=>({disposition:'resume',stoppedAttestation:true})}};
 assert.equal(await main(['tandem','recover','input'],recoveryOverrides),1);
 assert.equal(await main(['tandem','recover','input'],recoveryOverrides),0,JSON.stringify(errors));
 assert.equal(recoveryCalls,2);assert.ok(!JSON.stringify(logs).includes(credential));
});

test('receipt wait expires within bounded preflight window without leaking provider error',async()=>{
 const root=mkdtempSync(join(tmpdir(),'bootstrap-timeout-'));execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'config','user.email','test@example.com']);execFileSync('git',['-C',root,'config','user.name','Test']);writeFileSync(join(root,'a'),'ok');execFileSync('git',['-C',root,'add','a']);execFileSync('git',['-C',root,'commit','-qm','base']);
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();let ticks=0,calls=0;
 await assert.rejects(()=>bootstrapConductorCapture({root,options:{baseDir:mkdtempSync(join(tmpdir(),'bootstrap-timeout-state-'))},workspaceId:'workspace',sessionId:'session',env:{CODEBRIEF_LAUNCH_ID:randomUUID(),CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:`${randomUUID()}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},now:()=>ticks++?60000:0,fetchImpl:async()=>{calls++;return new Response('secret-provider-details',{status:503});}}),error=>error.status===503&&!error.message.includes('secret-provider-details'));
 assert.equal(calls,1);
});

test('exchange response rejects foreign credential namespace and malformed authority',async()=>{
 const {validateBootstrapExchangeResponse}=await import('./conductor-bootstrap.js'),orgId=randomUUID(),launchId=randomUUID(),instanceId=randomUUID();
 const response={launchId,instanceId,credential:`${orgId}.${'r'.repeat(43)}`,identity:{accountId:randomUUID(),orgId,repoId:randomUUID()},claim:{attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:2,leaseExpiresAt:new Date(Date.now()+10000).toISOString()}};
 assert.equal(validateBootstrapExchangeResponse(response,launchId),response);
 for(const invalid of [{...response,extra:true},{...response,credential:`${randomUUID()}.${'r'.repeat(43)}`},{...response,claim:{...response.claim,version:0}},{...response,identity:{...response.identity,orgId:orgId.toUpperCase()}}])assert.throws(()=>validateBootstrapExchangeResponse(invalid,launchId),/Invalid scoped/);
});

for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} actual review bootstrap freezes original base and rejects dirty revision`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-cli-')),options={baseDir:mkdtempSync(join(tmpdir(),'review-cli-state-'))};
 execFileSync('git',['init','-q',root]);execFileSync('git',['-C',root,'config','user.email','test@example.com']);execFileSync('git',['-C',root,'config','user.name','Test']);writeFileSync(join(root,'a'),'base');execFileSync('git',['-C',root,'add','a']);execFileSync('git',['-C',root,'commit','-qm','base']);const baseSha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();writeFileSync(join(root,'a'),'author');execFileSync('git',['-C',root,'commit','-am','author','-q']);const headSha=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const launchId=randomUUID(),orgId=randomUUID(),instanceId=randomUUID(),credential=`${orgId}.${'r'.repeat(43)}`,claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:2,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()},authorReceipt={schemaVersion:1,attemptId:randomUUID(),actionVersion:1,authorInstanceId:randomUUID(),generation:1,baseSha,headSha,contractDigest:'a'.repeat(64),evidenceDigest:'b'.repeat(64)};
 let ready=0,scope=0;const errors=[];
 const context={root,options,env:{CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:headSha,CODEBRIEF_BOOTSTRAP_TOKEN:`${orgId}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);if(url.endsWith('/exchange'))return Response.json({launchId,instanceId,credential,claim,identity:{accountId:randomUUID(),orgId,repoId:randomUUID()}});if(url.endsWith('/ready')){ready++;return Response.json({ready:true});}if(body.operation==='setup')return Response.json({protocolVersion:1,purpose:'review',plannedFiles:['a'],claim,authorReceipt});if(body.operation==='scope'){scope++;throw new Error('Review cannot reserve writer paths');}throw new Error('Unexpected call');}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>{throw new Error('Broad credential forbidden');},loadConfig:()=>({}),log:()=>{},error:value=>errors.push(value),tandemContext:context};
 assert.equal(await main(['tandem','bootstrap','review-workspace','review-session'],overrides),0,JSON.stringify(errors));const {readConductorSession}=await import('./tandem-client.js');assert.deepEqual(readConductorSession(root,options).reviewRevision,authorReceipt);assert.equal(scope,0);assert.equal(ready,1);
 authorReceipt.baseSha='f'.repeat(40);assert.equal(await main(['tandem','bootstrap','review-workspace','review-session'],overrides),1);assert.equal(ready,1);authorReceipt.baseSha=baseSha;
 writeFileSync(join(root,'a'),'dirty review');assert.equal(await main(['tandem','bootstrap','review-workspace','review-session'],overrides),1);assert.equal(ready,1);
});


test('bootstrap reinstall repairs older same-generation scoped claim without losing local state',async()=>{
 const {installConductorSession,readConductorSession}=await import('./tandem-client.js');
 const root=mkdtempSync(join(tmpdir(),'bootstrap-old-')),options={baseDir:mkdtempSync(join(tmpdir(),'bootstrap-old-state-'))};execFileSync('git',['init','-q',root]);
 const claim={attemptId:randomUUID(),instanceId:randomUUID(),generation:1,version:2};
 const saved={launchId:randomUUID(),credential:'restricted',workspaceId:'workspace',sessionId:'session',identity:{accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},claim,canonicalScope:[{kind:'file',path:'a'}]};
 installConductorSession(root,saved,options);installConductorSession(root,{...saved,claim:{...claim,version:3}},options);
 assert.equal(readConductorSession(root,options).claim.version,3);assert.deepEqual(readConductorSession(root,options).canonicalScope,saved.canonicalScope);
});
