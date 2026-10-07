import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { main as claudeMain } from '../codebrief-cli.js';
import { main as codexMain } from '../../codex/codebrief-capture/scripts/codebrief-cli.js';
for (const [host, main] of [['claude', claudeMain], ['codex', codexMain]])
    test(`${host} CLI authenticated claim heartbeat checkpoint return recovery with no credential output`, async () => {
        const id = randomUUID(), instance = randomUUID(), attempt = randomUUID(), base = 'a'.repeat(40), head = 'b'.repeat(40), scope = [{ kind: 'file', path: 'src/test.ts' }], credential = 'c'.repeat(43);
        let claim = { attemptId: attempt, handoffId: randomUUID(), actionId: randomUUID(), actionVersion: 1, instanceId: instance, generation: 1, version: 1, leaseExpiresAt: new Date(Date.now() + 3600000).toISOString() }, lost = true, closed = false;
        const calls = [], logs = [], errors = [];
        const payloads = { claim: { host, handoffId: claim.handoffId, expectedActionVersion: 1, requestId: randomUUID(), canonicalScope: scope }, checkpoint: { baseSha: base, dirty: [], untracked: [], decisions: [], commands: [], nextSteps: [], unresolvedRisks: [] }, return: { result: { schemaVersion: 2, outcome: 'completed', checks: [], references: [], blockers: [] }, receipt: { schemaVersion: 1, attemptId: attempt, actionVersion: 1, authorInstanceId: instance, generation: 1, baseSha: base, headSha: head, contractDigest: 'd'.repeat(64), evidenceDigest: 'e'.repeat(64) } }, recover: { disposition: 'resume', stoppedAttestation: true } };
        const context = { options: { baseDir: mkdtempSync(join(tmpdir(), 'tandem-cli-')) }, worktreeIdentity: () => host + 'worktree', readInput: path => payloads[path], inspectScope: async () => ({ clean: true, violations: [], baseSha: base, headSha: head, dirty: [], untracked: [] }), tandemRequest: async (r) => { calls.push(r); if (r.operation === 'register' && r.payload.verify)
                return { ownershipVerified: !closed, terminalClosed: closed }; if (r.operation === 'register')
                return { instanceId: instance, credential, identity: { accountId: id, orgId: id, repoId: id } }; if (r.operation === 'claim')
                return { claim }; if (r.operation === 'renew') {
                claim = { ...claim, version: claim.version + 1 };
                return { claim };
            } if (r.operation === 'return')
                return { claim: { ...claim, version: claim.version + 1 }, proposalId: id }; if (r.operation === 'recover') {
                if (lost) {
                    lost = false;
                    throw Object.assign(new Error('outage'), { status: 0 });
                }
                claim = { ...claim, generation: claim.generation + 1, version: claim.version + 1, handoffId: randomUUID() };
                return { claim, credential: 'r'.repeat(43) };
            } throw new Error('unavailable'); } };
        const overrides = { resolveRepo: () => ({ fullName: 'o/r' }), loadCreds: () => ({ apiKey: 'upstream', apiBaseUrl: 'https://app.codebrief.ai' }), loadConfig: () => ({}), log: value => logs.push(value), error: value => errors.push(value), tandemContext: context };
        assert.equal(await main(['tandem', 'claim', 'claim'], overrides), 0, JSON.stringify(errors));
        assert.equal(await main(['tandem', 'heartbeat'], overrides), 0);
        assert.equal(await main(['tandem', 'checkpoint', 'checkpoint'], overrides), 0);
        assert.equal(await main(['tandem', 'return', 'return'], overrides), 0);
        assert.equal(await main(['tandem', 'claim', 'claim'], overrides), 1);
        closed = true; claim = { ...claim, attemptId: randomUUID(), handoffId: randomUUID(), version: 1 };
        assert.equal(await main(['tandem', 'claim', 'claim'], overrides), 0, JSON.stringify(errors));
        closed = false;
        const { readCheckpoint } = await import('./tandem-checkpoint.js');
        assert.ok(readCheckpoint({ accountId:id, orgId:id, repoId:id, worktreeId:host+'worktree', attemptId:attempt }, context.options));
        const { readTandemOutbox } = await import('./tandem-client.js');
        assert.equal(readTandemOutbox({ accountId:id, orgId:id, repoId:id, worktreeId:host+'worktree', attemptId:attempt }, context.options).pending.length,0);

        assert.equal(await main(['tandem', 'recover', 'recover'], overrides), 1);
        assert.equal(await main(['tandem', 'recover', 'recover'], overrides), 0);
        const recovery = calls.filter(v => v.operation === 'recover');
        assert.deepEqual(recovery[0].payload, recovery[1].payload);
        assert.equal(recovery[0].credential, recovery[1].credential);
        assert.equal(JSON.stringify(logs).includes(credential), false);
        assert.equal(calls.filter(v => v.operation === 'renew').length, 1);
        assert.equal(JSON.parse(logs.at(-1)).claim.handoffId, claim.handoffId);
    });
for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])for(const failure of ['lost-response','save-failure'])for(const retry of ['heartbeat','recover'])test(`${host} renewal ${failure} via ${retry} replays durable request before recovery and retires only closed session`,async()=>{
 const id=randomUUID(),instance=randomUUID(),attempt=randomUUID(),credential='c'.repeat(43);let claim={attemptId:attempt,handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:instance,generation:1,version:1,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()},first=true,closed=false;const calls=[],errors=[];
 const payload={host,handoffId:claim.handoffId,expectedActionVersion:1,requestId:randomUUID(),canonicalScope:[{kind:'file',path:'src/a'}]};
 const context={options:{baseDir:mkdtempSync(join(tmpdir(),'renewal-'))},worktreeIdentity:()=>host+'worktree',readInput:()=>payload,beforeSessionSave:value=>{if(failure==='save-failure'&&first&&value.claim?.version===2&&!value.pendingRenewal){first=false;throw new Error('disk unavailable');}},tandemRequest:async r=>{calls.push(r);if(r.operation==='register'&&r.payload.verify)return {ownershipVerified:false,terminalClosed:closed};if(r.operation==='register')return {instanceId:instance,credential,identity:{accountId:id,orgId:id,repoId:id}};if(r.operation==='claim')return {claim};if(r.operation==='recover'){assert.equal(r.payload.expectedVersion,r.payload.pendingRenewal?1:2);if(r.payload.pendingRenewal)assert.deepEqual(r.payload.pendingRenewal,calls.find(v=>v.operation==='renew').payload);claim={...claim,generation:2,version:3};return {claim,credential:'r'.repeat(43)};}if(r.operation==='renew'){if(claim.version===1)claim={...claim,version:2};if(failure==='lost-response'&&first){first=false;throw new Error('lost response');}return {claim};}throw new Error('unexpected');}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:v=>errors.push(v),tandemContext:context};
 assert.equal(await main(['tandem','claim','input'],overrides),0);assert.equal(await main(['tandem','heartbeat'],overrides),1);assert.equal(await main(retry==='recover'?['tandem','recover','input']:['tandem','heartbeat'],overrides),0,JSON.stringify(errors));const renewals=calls.filter(v=>v.operation==='renew');if(retry==='heartbeat')assert.deepEqual(renewals[0].payload,renewals[1].payload);else assert.equal(renewals.length,1);
 assert.equal(await main(['tandem','claim','input'],overrides),1);closed=true;claim={...claim,attemptId:randomUUID(),handoffId:randomUUID(),version:1};assert.equal(await main(['tandem','claim','input'],overrides),0,JSON.stringify(errors));assert.equal(calls.filter(v=>v.operation==='claim').length,2);
});
for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} rejected pending renewal reaches atomic recovery and uncertain recovery preserves both requests`,async()=>{
 const id=randomUUID(),instance=randomUUID(),credential='c'.repeat(43);let claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:instance,generation:1,version:1,leaseExpiresAt:new Date().toISOString()},lost=true;const calls=[];
 const context={options:{baseDir:mkdtempSync(join(tmpdir(),'renew-reject-'))},worktreeIdentity:()=>host+'worktree',readInput:()=>({host,handoffId:claim.handoffId,expectedActionVersion:1,requestId:randomUUID(),canonicalScope:[{kind:'file',path:'src/a'}],disposition:'resume',stoppedAttestation:true}),tandemRequest:async r=>{calls.push(r);if(r.operation==='register')return {instanceId:instance,credential,identity:{accountId:id,orgId:id,repoId:id}};if(r.operation==='claim')return {claim};if(r.operation==='renew')throw Object.assign(new Error('expired'),{status:409});if(r.operation==='recover'){assert.deepEqual(r.payload.pendingRenewal,calls.find(v=>v.operation==='renew').payload);if(lost){lost=false;throw new Error('lost recovery response');}claim={...claim,generation:2,version:3};return {claim,credential:'r'.repeat(43)};}throw new Error('unexpected');}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:()=>{},tandemContext:context};
 // Keep command input shapes distinct so the claim itself is valid.
 context.readInput=path=>path==='claim'?{host,handoffId:claim.handoffId,expectedActionVersion:1,requestId:randomUUID(),canonicalScope:[{kind:'file',path:'src/a'}]}:{disposition:'resume',stoppedAttestation:true};
 assert.equal(await main(['tandem','claim','claim'],overrides),0);assert.equal(await main(['tandem','heartbeat'],overrides),1);assert.equal(await main(['tandem','recover','recover'],overrides),1);assert.equal(await main(['tandem','recover','recover'],overrides),0);const recovery=calls.filter(v=>v.operation==='recover');assert.deepEqual(recovery[0].payload,recovery[1].payload);assert.equal(calls.filter(v=>v.operation==='renew').length,1);
});

for (const [host, main] of [['claude',claudeMain],['codex',codexMain]]) test(`${host} actual Git review freezes clean revision and denies dirty, changed HEAD and same worktree`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'review-git-')), reviewer=root+'-review', options={baseDir:mkdtempSync(join(tmpdir(),'review-state-'))};
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();
 git('init','-q');git('config','user.email','review@example.test');git('config','user.name','Review');writeFileSync(join(root,'a'),'one');git('add','a');git('commit','-qm','base');const base=git('rev-parse','HEAD');writeFileSync(join(root,'a'),'two');git('commit','-qam','author');const head=git('rev-parse','HEAD');git('worktree','add','--detach',reviewer,head);
 const id=randomUUID(),instance=randomUUID(),author=randomUUID(),attempt=randomUUID(),claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:instance,generation:1,version:1,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()},revision={schemaVersion:1,attemptId:attempt,actionVersion:1,authorInstanceId:author,generation:1,baseSha:base,headSha:head,contractDigest:'d'.repeat(64),evidenceDigest:'e'.repeat(64)};
 const {worktreeIdentity}=await import('./tandem-state.js');const authorWorkspace=worktreeIdentity(root,options),calls=[];let input={phase:'claim',host,attemptId:attempt,requestId:randomUUID(),expectedActionVersion:1};
 const context={root:reviewer,options,readInput:()=>input,tandemRequest:async r=>{calls.push(r);if(r.operation==='register'&&r.payload.verify)return {ownershipVerified:true};if(r.operation==='register'){if(r.payload.workspaceId===authorWorkspace)throw new Error('same workspace denied');return {instanceId:instance,credential:'c'.repeat(43),identity:{accountId:id,orgId:id,repoId:id}};}if(r.payload.phase==='claim')return {claim,revision};return {reviewId:id};}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:()=>{},tandemContext:context};
 assert.equal(await main(['tandem','review','input'],overrides),0);input={phase:'submit',receipt:{...revision,reviewerInstanceId:instance,verdict:'approved',evidenceSource:'agent_reported'}};delete input.receipt.generation;
 writeFileSync(join(reviewer,'a'),'dirty');assert.equal(await main(['tandem','review','input'],overrides),1);execFileSync('git',['-C',reviewer,'checkout','--','a']);execFileSync('git',['-C',reviewer,'checkout','--detach',base]);assert.equal(await main(['tandem','review','input'],overrides),1);execFileSync('git',['-C',reviewer,'checkout','--detach',head]);assert.equal(await main(['tandem','review','input'],overrides),0);assert.equal(calls.filter(r=>r.payload.phase==='submit').length,1);
 context.root=root;input={phase:'claim',host,attemptId:attempt,requestId:randomUUID(),expectedActionVersion:1};assert.equal(await main(['tandem','review','input'],overrides),1);
});

for (const [host, main, modulePath] of [['claude',claudeMain,'./tandem-client.js'],['codex',codexMain,'../../codex/codebrief-capture/scripts/lib/tandem-client.js']]) test(`${host} executable brief prints only validated budget error references`,async()=>{
 const {TandemBriefBudgetError}=await import(modulePath), reference=`/${randomUUID()}/atlas/project`,errors=[],logs=[];
 const context={options:{baseDir:mkdtempSync(join(tmpdir(),'budget-cli-'))},worktreeIdentity:()=>host+'budget',readInput:()=>({handoffId:randomUUID()}),resolveBriefBase:()=> 'a'.repeat(40),tandemRequest:async()=>{throw new TandemBriefBudgetError([reference]);}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'secret',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:v=>logs.push(v),error:v=>errors.push(v),tandemContext:context};
 assert.equal(await main(['tandem','brief','input'],overrides),1);
 assert.deepEqual(JSON.parse(errors[0]),{error:'required_brief_exceeds_budget',expansionReferences:[reference]});assert.deepEqual(logs,[]);assert.ok(!JSON.stringify(errors).includes('secret'));
 context.tandemRequest=async()=>{throw Object.assign(new Error('private-server-secret'),{status:422});};errors.length=0;assert.equal(await main(['tandem','brief','input'],overrides),1);assert.deepEqual(errors,['Tandem failed (422).']);
});

for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} dependent claim verifies actual Git mission branch and HEAD before transport`,async()=>{
 const root=mkdtempSync(join(tmpdir(),'dependency-git-'));const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8'}).trim();git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.test');writeFileSync(join(root,'file'),'source-free');git('add','file');git('commit','-qm','baseline');git('switch','-qc','mission/test');const sha=git('rev-parse','HEAD');
 const id=randomUUID(),instance=randomUUID(),claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:instance,generation:1,version:1,leaseExpiresAt:new Date(Date.now()+3600000).toISOString()},calls=[];
 let input={host,handoffId:claim.handoffId,expectedActionVersion:1,requestId:randomUUID(),dependencyBase:{branch:'mission/test',sha:'0'.repeat(40)}};
 const context={root,options:{baseDir:mkdtempSync(join(tmpdir(),'dependency-state-'))},readInput:()=>input,tandemRequest:async r=>{calls.push(r);if(r.operation==='register')return {instanceId:instance,credential:'c'.repeat(43),identity:{accountId:id,orgId:id,repoId:id}};if(r.operation==='claim')return {claim};throw new Error('unexpected');}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:()=>{},tandemContext:context};
 assert.equal(await main(['tandem','claim','input'],overrides),1);assert.equal(calls.length,0);
 input={...input,dependencyBase:{branch:'mission/test',sha}};assert.equal(await main(['tandem','claim','input'],overrides),0);assert.deepEqual(calls.find(r=>r.operation==='claim').payload.dependencyBase,input.dependencyBase);assert.equal(git('rev-parse','HEAD'),sha);assert.equal(git('branch','--show-current'),'mission/test');
});
for(const [host,main] of [['claude',claudeMain],['codex',codexMain]])test(`${host} installed claim prints fixed typed dependency recovery guidance`,async()=>{
 const id=randomUUID(),instance=randomUUID(),errors=[];
 const context={options:{baseDir:mkdtempSync(join(tmpdir(),'dependency-error-'))},worktreeIdentity:()=>host,readInput:()=>({host,handoffId:id,expectedActionVersion:1,requestId:randomUUID(),canonicalScope:[{kind:'file',path:'src/a'}]}),tandemRequest:async r=>{if(r.operation==='register')return {instanceId:instance,credential:'c'.repeat(43),identity:{accountId:id,orgId:id,repoId:id}};throw Object.assign(new Error('unsafe provider detail'),{status:409,code:'dependency_base_required'});}};
 const overrides={resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:value=>errors.push(value),tandemContext:context};
 assert.equal(await main(['tandem','claim','input'],overrides),1);assert.deepEqual(JSON.parse(errors[0]),{error:'dependency_base_required',guidance:'Run the installed Tandem claim command with input.json containing dependencyBase {branch, sha} matching the local Git branch and HEAD.'});assert.ok(!errors.join('').includes('unsafe'));
});
for(const [host,relative] of [['claude','../codebrief-cli.js'],['codex','../../codex/codebrief-capture/scripts/codebrief-cli.js']])test(`${host} expected unborn-HEAD dependency preflight emits no raw Git stderr`,async()=>{
 const {spawnSync}=await import('node:child_process'),root=realpathSync(mkdtempSync(join(tmpdir(),'dependency-nongit-')));
 const git=(...args)=>execFileSync('git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git('init','-q');git('symbolic-ref','HEAD','refs/heads/mission/test');
 const moduleUrl=new URL(relative,import.meta.url).href;
 const source=`const {moduleUrl,root,baseDir,host}=JSON.parse(process.argv[1]);const {main}=await import(moduleUrl);const errors=[];const result=await main(['tandem','claim','input'],{resolveRepo:()=>({fullName:'o/r'}),loadCreds:()=>({apiKey:'upstream',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({}),log:()=>{},error:v=>errors.push(v),tandemContext:{root,options:{baseDir},worktreeIdentity:()=> 'source-free',readInput:()=>({host,dependencyBase:{branch:'mission/test',sha:'a'.repeat(40)}})}});if(result!==1||errors.length!==1)process.exit(2);`;
 const data=JSON.stringify({moduleUrl,root,host,baseDir:realpathSync(mkdtempSync(join(tmpdir(),'dependency-state-')))});
 const child=spawnSync(process.execPath,['--input-type=module','-e',source,data],{encoding:'utf8'});assert.equal(child.status,0,child.stderr);assert.equal(child.stderr,'');
});
