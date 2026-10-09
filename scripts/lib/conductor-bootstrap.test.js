import {test} from 'node:test';
import assert from 'node:assert/strict';
import {launchRelayRequest} from './conductor-bootstrap.js';
test('launch transport denies broad commands and never sends ordinary Capture API key',async()=>{
 let calls=0;const session={launchId:'11111111-1111-4111-8111-111111111111',credential:'restricted',workspaceId:'workspace'};
 const context={apiBaseUrl:'https://app.codebrief.ai',session,fetchImpl:async(url,options)=>{calls++;assert.equal(options.headers.authorization,'Bearer restricted');assert.equal(JSON.parse(options.body).operation,'verify');assert.equal(JSON.parse(options.body).payload.workspaceId,'workspace');return Response.json({ownershipVerified:true});}};
 await assert.rejects(()=>launchRelayRequest({...context,operation:'claim',payload:{}}),/unsupported/i);assert.equal(calls,0);
 assert.equal((await launchRelayRequest({...context,operation:'register',payload:{verify:{claim:{},workspaceId:'local'}}})).ownershipVerified,true);assert.equal(calls,1);
});
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildStandaloneRelease} from '../build-standalone-release.js';
import {installCaptureRelease} from './release-installation.js';
const releaseHome=mkdtempSync(join(tmpdir(),'capture-bootstrap-release-'));
const releaseSource=join(releaseHome,'artifact');
const releasePin=buildStandaloneRelease({source:fileURLToPath(new URL('../../',import.meta.url)),destination:releaseSource}).manifestSha256;
installCaptureRelease({source:releaseSource,manifestSha256:releasePin,home:releaseHome});
const releaseRoot=join(releaseHome,'.codebrief/capture/releases/0.10.0');
import {bootstrapConductorCapture} from './conductor-bootstrap.js';
test('bootstrap rejects absent trusted installation pin before token parsing or network',async()=>{
 let calls=0,tokenReads=0;
 const env={get CODEBRIEF_BOOTSTRAP_TOKEN(){tokenReads++;throw new Error('token parsing must not begin');}};
 await assert.rejects(()=>bootstrapConductorCapture({env,fetchImpl:async()=>{calls++;throw new Error('network forbidden');}}),/capture_release_invalid/);
 assert.equal(calls,0);assert.equal(tokenReads,0);
});
test('bootstrap rejects mismatched trusted pin, incomplete install and self-consistent local tampering before token parsing',async()=>{
 let calls=0,tokenReads=0;
 const denied=async(root,pin)=>{
  const env={CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256:pin,get CODEBRIEF_BOOTSTRAP_TOKEN(){tokenReads++;throw new Error('token parsing forbidden');}};
  await assert.rejects(()=>bootstrapConductorCapture({releaseRoot:root,env,fetchImpl:async()=>{calls++;throw new Error('network forbidden');}}),/capture_release_invalid/);
 };
 await denied(releaseRoot,'f'.repeat(64));await denied(releaseRoot,'ABCDEF'.repeat(11));
 await denied(releaseSource,releasePin); // Manifest bytes alone do not prove completed installation.
 const modified=join(mkdtempSync(join(tmpdir(),'capture-tampered-')),'release');cpSync(releaseRoot,modified,{recursive:true});
 const manifest=JSON.parse(readFileSync(join(modified,'release-manifest.json')));
 const file=manifest.files.find(file=>file.path==='scripts/codebrief-cli.js');const bytes=Buffer.from('self-consistent forged runtime');
 writeFileSync(join(modified,file.path),bytes);file.size=bytes.length;file.sha256=createHash('sha256').update(bytes).digest('hex');
 const manifestBytes=Buffer.from(JSON.stringify(manifest)+'\n'),localHash=createHash('sha256').update(manifestBytes).digest('hex');
 writeFileSync(join(modified,'release-manifest.json'),manifestBytes);writeFileSync(join(modified,'.codebrief-installation.json'),JSON.stringify({schemaVersion:1,version:'0.10.0',manifestSha256:localHash}));
 await denied(modified,releasePin);assert.equal(calls,0);assert.equal(tokenReads,0);
});
for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} bootstrap CLI denies manually supplied provider IDs`,async()=>{
 let tokenReads=0,calls=0;const errors=[];
 assert.equal(await main(['tandem','bootstrap','workspace','session'],{error:value=>errors.push(value),log:()=>{},tandemContext:{env:{get CODEBRIEF_BOOTSTRAP_TOKEN(){tokenReads++;}},fetchImpl:async()=>{calls++;}}}),1);
 assert.deepEqual(errors,['usage: codebrief tandem bootstrap']);assert.equal(tokenReads,0);assert.equal(calls,0);
});
test('actual bootstrap preserves lost-exchange envelope and scope claim before ready without secret output',async()=>{
 const root=mkdtempSync(join(tmpdir(),'conductor-preflight-')),baseDir=mkdtempSync(join(tmpdir(),'conductor-state-'));
 execFileSync('git',['init',root]);execFileSync('git',['-C',root,'config','user.email','test@example.com']);execFileSync('git',['-C',root,'config','user.name','Test']);mkdirSync(join(root,'src'));writeFileSync(join(root,'src','example.ts'),'ok');execFileSync('git',['-C',root,'add','src/example.ts']);execFileSync('git',['-C',root,'commit','-m','base']);
 const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),launchId=randomUUID(),instanceId=randomUUID();
 const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:2,leaseExpiresAt:new Date(Date.now()+10000).toISOString()};
 const orgId=randomUUID(),credential=`${orgId}.${'r'.repeat(43)}`,token=`${randomUUID()}.${'t'.repeat(43)}`,envelopes=[];let scopeCalls=0,readyCalls=0;
 const context={releaseRoot,root,options:{baseDir},workspaceId:'workspace-1',sessionId:'session-2',env:{CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256:releasePin,CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:token,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},fetchImpl:async(url,options)=>{
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
 const context={releaseRoot,root,options,env:{CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256:releasePin,CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:`${orgId}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},readInput:()=>({baseSha:head,dirty:[],untracked:[],decisions:[],commands:[],nextSteps:[],unresolvedRisks:[]}),fetchImpl:async(url,init)=>{
  const body=JSON.parse(init.body);calls.push({url,body});
  if(url.endsWith('/bootstrap/resolve')){assert.deepEqual(Object.keys(body),['token']);assert.equal(init.headers.authorization,undefined);return Response.json({state:'bound',launchId,attemptId:claim.attemptId,baseSha:head,workspaceId:'workspace',sessionId:'session',expiresAt:new Date(Date.now()+60000).toISOString()});}
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
 assert.equal(await main(['tandem','bootstrap'],overrides),0,JSON.stringify(errors));
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
 await assert.rejects(()=>bootstrapConductorCapture({releaseRoot,root,options:{baseDir:mkdtempSync(join(tmpdir(),'bootstrap-timeout-state-'))},workspaceId:'workspace',sessionId:'session',env:{CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256:releasePin,CODEBRIEF_LAUNCH_ID:randomUUID(),CODEBRIEF_EXPECTED_SHA:head,CODEBRIEF_BOOTSTRAP_TOKEN:`${randomUUID()}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},now:()=>ticks++?60000:0,fetchImpl:async()=>{calls++;return new Response('secret-provider-details',{status:503});}}),error=>error.status===503&&!error.message.includes('secret-provider-details'));
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
 const context={releaseRoot,workspaceId:'review-workspace',sessionId:'review-session',root,options,env:{CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256:releasePin,CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:headSha,CODEBRIEF_BOOTSTRAP_TOKEN:`${orgId}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body);if(url.endsWith('/exchange'))return Response.json({launchId,instanceId,credential,claim,identity:{accountId:randomUUID(),orgId,repoId:randomUUID()}});if(url.endsWith('/ready')){ready++;return Response.json({ready:true});}if(body.operation==='setup')return Response.json({protocolVersion:1,purpose:'review',plannedFiles:['a'],claim,authorReceipt});if(body.operation==='scope'){scope++;throw new Error('Review cannot reserve writer paths');}throw new Error('Unexpected call');}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>{throw new Error('Broad credential forbidden');},loadConfig:()=>({}),log:()=>{},error:value=>errors.push(value),tandemContext:context};
 assert.equal(await main(['tandem','bootstrap'],overrides),0,JSON.stringify(errors));const {readConductorSession}=await import('./tandem-client.js');assert.deepEqual(readConductorSession(root,options).reviewRevision,authorReceipt);assert.equal(scope,0);assert.equal(ready,1);
 authorReceipt.baseSha='f'.repeat(40);assert.equal(await main(['tandem','bootstrap'],overrides),1);assert.equal(ready,1);authorReceipt.baseSha=baseSha;
 writeFileSync(join(root,'a'),'dirty review');assert.equal(await main(['tandem','bootstrap'],overrides),1);assert.equal(ready,1);
});


test('bootstrap reinstall repairs older same-generation scoped claim without losing local state',async()=>{
 const {installConductorSession,readConductorSession}=await import('./tandem-client.js');
 const root=mkdtempSync(join(tmpdir(),'bootstrap-old-')),options={baseDir:mkdtempSync(join(tmpdir(),'bootstrap-old-state-'))};execFileSync('git',['init','-q',root]);
 const claim={attemptId:randomUUID(),instanceId:randomUUID(),generation:1,version:2};
 const saved={launchId:randomUUID(),credential:'restricted',workspaceId:'workspace',sessionId:'session',identity:{accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},claim,canonicalScope:[{kind:'file',path:'a'}]};
 installConductorSession(root,saved,options);installConductorSession(root,{...saved,claim:{...claim,version:3}},options);
 assert.equal(readConductorSession(root,options).claim.version,3);assert.deepEqual(readConductorSession(root,options).canonicalScope,saved.canonicalScope);
});

import {resolveConductorBootstrap} from './conductor-bootstrap.js';
test('token-only resolver preserves pending expiry and explicit exact binding without value-inequality assumption',async()=>{
 const launchId=randomUUID(),attemptId=randomUUID(),baseSha='a'.repeat(40),expiresAt=new Date(10000).toISOString();
 const env={CODEBRIEF_LAUNCH_ID:launchId,CODEBRIEF_EXPECTED_SHA:baseSha,CODEBRIEF_BOOTSTRAP_TOKEN:`${randomUUID()}.${'t'.repeat(43)}`,CODEBRIEF_API_ORIGIN:'https://app.codebrief.ai'};
 let deniedCalls=0;
 const unavailableOrigin=new URL(env.CODEBRIEF_API_ORIGIN);unavailableOrigin.hostname=['staging','invalid'].join('.');
 const deceptiveOrigin=new URL(env.CODEBRIEF_API_ORIGIN);deceptiveOrigin.hostname+=['','evil','invalid'].join('.');
 const insecureOrigin=new URL(env.CODEBRIEF_API_ORIGIN);insecureOrigin.protocol='http:';
 for(const unsafeOrigin of [unavailableOrigin.origin,deceptiveOrigin.origin,`${env.CODEBRIEF_API_ORIGIN}/`,insecureOrigin.origin])await assert.rejects(()=>resolveConductorBootstrap({env:{...env,CODEBRIEF_API_ORIGIN:unsafeOrigin},fetchImpl:async()=>{deniedCalls++;throw new Error('unexpected request');}}),/Invalid/);
 assert.equal(deniedCalls,0);
 let clock=0,calls=0;
 const binding={state:'bound',launchId,attemptId,baseSha,workspaceId:'same-id',sessionId:'same-id',expiresAt};
 const result=await resolveConductorBootstrap({env,now:()=>clock,wait:async ms=>{clock+=ms;},fetchImpl:async(url,init)=>{
  assert.equal(url,`${env.CODEBRIEF_API_ORIGIN}/api/conductor/bootstrap/resolve`);assert.equal(init.redirect,'error');assert.deepEqual(JSON.parse(init.body),{token:env.CODEBRIEF_BOOTSTRAP_TOKEN});assert.equal(init.headers.authorization,undefined);
  return Response.json(++calls===1?{state:'pending',expiresAt}:binding);
 }});
 assert.deepEqual(result,binding);assert.equal(calls,2);
 for(const invalid of [{...binding,launchId:randomUUID()},{...binding,baseSha:'b'.repeat(40)},{...binding,sessionId:undefined},{...binding,extra:true},{...binding,expiresAt:new Date(0).toISOString()}])await assert.rejects(()=>resolveConductorBootstrap({env,now:()=>0,fetchImpl:async()=>Response.json(invalid)}),/Invalid|expired/);
 let poll=0;await assert.rejects(()=>resolveConductorBootstrap({env,now:()=>0,wait:async()=>{},fetchImpl:async()=>Response.json(++poll===1?{state:'pending',expiresAt}:{...binding,expiresAt:new Date(20000).toISOString()})}),/changed/);
});
