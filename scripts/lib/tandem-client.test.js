import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tandemRequest } from './tandem-client.js';
test('old server explicitly unsupported without sending mutation', async () => { let calls = 0; await assert.rejects(tandemRequest({ apiBaseUrl: 'https://app.codebrief.ai', apiKey: 'key', repoFullName: 'o/r', operation: 'claim', payload: {}, fetchImpl: async () => { calls++; return new Response('{}', { status: 404 }); } }), /unsupported/i); assert.equal(calls, 1); });
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { queueTandemResult, readTandemOutbox } from './tandem-client.js';
import { randomUUID } from 'node:crypto';
const receipt = { schemaVersion: 1, attemptId: randomUUID(), authorInstanceId: randomUUID(), actionVersion: 1, generation: 1, baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), contractDigest: 'c'.repeat(64), evidenceDigest: 'd'.repeat(64) };
test('outbox never evicts unresolved entries and overflow preserves new result', () => { const identity = { accountId: 'a', orgId: 'o', repoId: 'r', worktreeId: 'w', attemptId: 't' }, options = { baseDir: mkdtempSync(join(tmpdir(), 'outbox-')) }; for (let i = 0; i < 100; i++)
    queueTandemResult(identity, { requestId: randomUUID(), result: { schemaVersion: 2, outcome: 'completed', checks: [], references: [], blockers: [] }, receipt }, options); const id = randomUUID(); assert.throws(() => queueTandemResult(identity, { requestId: id, result: { schemaVersion: 2, outcome: 'completed', checks: [], references: [], blockers: [] }, receipt }, options), /recovery/i); const outbox = readTandemOutbox(identity, options); assert.equal(outbox.pending.length, 100); assert.equal(outbox.recovery[0].requestId, id); });
test('concurrent result writers preserve both unresolved payloads', async () => { const { spawn } = await import('node:child_process'); const identity = { accountId: 'a', orgId: 'o', repoId: 'r', worktreeId: 'w', attemptId: 't' }, options = { baseDir: mkdtempSync(join(tmpdir(), 'outbox-concurrent-')) }; const moduleUrl = new URL('./tandem-client.js', import.meta.url).href; const ids = [randomUUID(), randomUUID()]; await Promise.all(ids.map(id => new Promise((resolve, reject) => { const source = `import {queueTandemResult} from ${JSON.stringify(moduleUrl)}; const args=${JSON.stringify([identity, { requestId: id, result: { schemaVersion: 2, outcome: 'completed', checks: [], references: [], blockers: [] }, receipt }, options])}; for(let i=0;i<20;i++){try{queueTandemResult(...args);process.exit(0);}catch(e){if(!/lock|flight|busy/i.test(e.message))throw e;await new Promise(r=>setTimeout(r,20));}}process.exit(1);`; const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe' }); let output = ''; child.stderr.on('data', v => output += v); child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output))); }))); assert.deepEqual(readTandemOutbox(identity, options).pending.map(v => v.requestId).sort(), ids.sort()); });
import { runTandemCommand } from './tandem-client.js';
test('preclaim brief resolves actual git revision, transmits exact read selector and preserves required metadata',async()=>{
 const baseSha='a'.repeat(40), handoffId=randomUUID(),options={baseDir:mkdtempSync(join(tmpdir(),'brief-'))};let sent;
 const context={options,worktreeIdentity:()=> 'worktree',readInput:()=>({handoffId}),resolveBriefBase:ref=>{assert.equal(ref,'HEAD');return baseSha;},tandemRequest:async input=>{sent=input;return {text:'approved',freshness:'missing',indexedSha:null,expansionReferences:[],truncated:false,baseSha,actionVersion:1,contractDigest:'d'.repeat(64)};}};
 const result=await runTandemCommand(['brief','input.json'],context);
 assert.deepEqual(sent.payload,{handoffId,baseSha});assert.equal(sent.operation,'brief');assert.equal(sent.credential,undefined);assert.equal(result.contractDigest,'d'.repeat(64));assert.deepEqual(result.localCheckpointReferences,[]);
 context.readInput=()=>({handoffId,source:'private'});await assert.rejects(runTandemCommand(['brief','input.json'],context),/only/);
});
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
test('brief verifies actual Git base and cannot send an absent revision',async()=>{
 const root=mkdtempSync(join(tmpdir(),'brief-git-'));const git=args=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();git(['init','-q']);git(['config','user.name','Test']);git(['config','user.email','test@example.test']);writeFileSync(join(root,'file'),'content');git(['add','file']);git(['commit','-qm','base']);const baseSha=git(['rev-parse','HEAD']);let calls=0;
 const context={root,options:{baseDir:mkdtempSync(join(tmpdir(),'brief-state-'))},worktreeIdentity:()=> 'worktree',readInput:()=>({handoffId:randomUUID()}),tandemRequest:async input=>{calls++;assert.equal(input.payload.baseSha,baseSha);return {text:'approved',freshness:'current',indexedSha:baseSha,expansionReferences:[],truncated:false,baseSha,actionVersion:1,contractDigest:'d'.repeat(64)};}};
 await runTandemCommand(['brief','input'],context);assert.equal(calls,1);context.readInput=()=>({handoffId:randomUUID(),baseSha:'0'.repeat(40)});await assert.rejects(runTandemCommand(['brief','input'],context));assert.equal(calls,1);
});
import { writeCheckpoint } from './tandem-checkpoint.js';
import { tandemNamespace } from './tandem-state.js';
test('brief exposes only an ownership-authorized local checkpoint pointer and never uploads inventory',async()=>{
 const options={baseDir:mkdtempSync(join(tmpdir(),'brief-private-'))},worktreeId='worktree',identity={accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},instanceId=randomUUID(),baseSha='a'.repeat(40),claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId,generation:1,version:1,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()};let authorized=true;const payloads=[];
 const context={options,worktreeIdentity:()=>worktreeId,resolveBriefBase:()=>baseSha,readInput:()=>({host:'codex',handoffId:claim.handoffId,expectedActionVersion:1,requestId:randomUUID(),canonicalScope:[{kind:'file',path:'file'}]}),tandemRequest:async r=>{payloads.push(r.payload);if(r.operation==='register')return r.payload.verify?{ownershipVerified:authorized}:{identity,instanceId,credential:'c'.repeat(43)};if(r.operation==='claim')return {claim};return {text:'approved',freshness:'missing',indexedSha:null,expansionReferences:[],truncated:false,baseSha,actionVersion:1,contractDigest:'d'.repeat(64)};}};
 await runTandemCommand(['claim','input'],context);const binding={...identity,worktreeId,attemptId:claim.attemptId};await writeCheckpoint(binding,{schemaVersion:1,namespace:tandemNamespace(binding),attemptId:claim.attemptId,actionId:claim.actionId,generation:1,contractVersion:1,baseSha,headSha:baseSha,dirty:['private-file'],untracked:[],decisions:['private decision'],commands:[],nextSteps:[],unresolvedRisks:[],clean:false,scopeViolations:[],ownershipVerified:true},options);
 let result=await runTandemCommand(['brief'],context);assert.deepEqual(result.localCheckpointReferences,[{namespace:tandemNamespace(binding),kind:'local_checkpoint'}]);authorized=false;result=await runTandemCommand(['brief'],context);assert.deepEqual(result.localCheckpointReferences,[]);assert.ok(!JSON.stringify(payloads).includes('private decision'));assert.ok(!JSON.stringify(result).includes('private-file'));
});

test('HTTP transport preserves only strict bounded typed overflow errors',async()=>{
 const repoId=randomUUID(),reference=`/${repoId}/atlas/project`,context={apiBaseUrl:'https://app.codebrief.ai',apiKey:'private-key',repoFullName:'o/r',operation:'brief',payload:{},fetchImpl:async url=>new Response(JSON.stringify(url.endsWith('/register')?{protocolVersion:1}:{error:'required_brief_exceeds_budget',expansionReferences:[reference]}),{status:url.endsWith('/register')?200:422})};
 await assert.rejects(tandemRequest(context),error=>error.status===422&&error.code==='required_brief_exceeds_budget'&&JSON.stringify(error.expansionReferences)===JSON.stringify([reference]));
 for(const body of [{error:'private secret',expansionReferences:[reference]},{error:'required_brief_exceeds_budget',expansionReferences:['https://github.com/example/secret']},{error:'required_brief_exceeds_budget',expansionReferences:[reference],secret:'never echo'}]){
 context.fetchImpl=async url=>new Response(JSON.stringify(url.endsWith('/register')?{protocolVersion:1}:body),{status:url.endsWith('/register')?200:422});await assert.rejects(tandemRequest(context),error=>!error.code&&!error.expansionReferences&&!error.message.includes('secret'));
 }
});

test('brief response rejects malformed freshness and expansion metadata',async()=>{
 const {validateTandemBriefResponse}=await import('./tandem-client.js'); const baseSha='a'.repeat(40), valid={text:'ok',truncated:false,freshness:'missing',indexedSha:null,baseSha,actionVersion:1,contractDigest:'d'.repeat(64),expansionReferences:[]};
 for(const changes of [{freshness:'current'},{indexedSha:'secret'},{expansionReferences:['https://github.com/example']},{expansionReferences:['/repo/atlas/active-project']},{secret:'hidden'}]) assert.throws(()=>validateTandemBriefResponse({...valid,...changes},baseSha));
});
test('missing dependency baseline uses only exact safe code and constant installed-command guidance',async()=>{
 const request=body=>tandemRequest({apiBaseUrl:'https://app.codebrief.ai',apiKey:'key',repoFullName:'o/r',operation:'claim',payload:{},fetchImpl:async(_url,options)=>options.method==='GET'?Response.json({protocolVersion:1}):Response.json(body,{status:409})});
 await assert.rejects(request({error:'dependency_base_required'}),error=>error.status===409&&error.code==='dependency_base_required'&&error.message==='Run the installed Tandem claim command with input.json containing dependencyBase {branch, sha} matching the local Git branch and HEAD.');
 await assert.rejects(request({error:'dependency_base_required',detail:'unsafe'}),error=>!error.message.includes('unsafe')&&error.code!== 'dependency_base_required');
});
