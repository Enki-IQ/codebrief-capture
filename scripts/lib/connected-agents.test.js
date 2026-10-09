import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNativeObservation } from './native-agent-runtime.js';
test('Claude observation allowlists fields and never exports provider extras', () => {
    const value = parseNativeObservation('claude', { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'owner@example.test', accessToken: 'secret', configDirectory: '/private/secret' });
    assert.deepEqual(value, { provider: 'claude', authState: 'signed_in', authMethod: 'native_subscription', accountLabel: null, runtimeVersion: null });
    assert.equal(JSON.stringify(value).includes('secret'), false);
});
test('Codex missing account is unknown rather than inferred authenticated', () => {
    assert.equal(parseNativeObservation('codex', {}).authState, 'unknown');
    assert.equal(parseNativeObservation('codex', { account: null, requiresOpenaiAuth: true }).authState, 'signed_out');
});
test('Codex typed native account observation does not imply entitlement', () => {
    assert.deepEqual(parseNativeObservation('codex', { account: { type: 'chatgpt', email: 'owner@example.test', planType: 'plus', token: 'secret' } }), { provider: 'codex', authState: 'signed_in', authMethod: 'native_subscription', accountLabel: 'owner@example.test', runtimeVersion: null });
});
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const packageRoot = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const node = process.execPath;
async function fixtureCommand(host, args, fixture, { hookInput, longLived = false } = {}) {
    const entry = host === 'claude' ? join(packageRoot, 'scripts/codebrief-cli.js') : join(packageRoot, 'codex/codebrief-capture/scripts/codebrief-cli.js');
    const wrapper = join(fixture.base, `${host}-wrapper.mjs`);
    writeFileSync(wrapper, `
import {main} from ${JSON.stringify(new URL('file://' + entry).href)};
import {readFileSync,writeFileSync,appendFileSync,existsSync} from 'node:fs';import {createHash} from 'node:crypto';
const configPath=${JSON.stringify(fixture.config)},serverPath=${JSON.stringify(fixture.server)},auditPath=${JSON.stringify(join(fixture.base,'audit.jsonl'))};let calls=[];
function audit(body,stage){appendFileSync(auditPath,JSON.stringify({pid:process.pid,path:body.path,operation:body.operation,stage})+'\\n');}
const fetchImpl=async(url,init)=>{
 const body={...JSON.parse(init.body),path:url.split('/').at(-1)},config=JSON.parse(readFileSync(configPath,'utf8'));
 calls.push({path:body.path,operation:body.operation});audit(body,'issued');
 if(config.delayPid===process.pid&&config.delayOperation===body.operation){writeFileSync(${JSON.stringify(join(fixture.base,'blocked'))},'blocked');for(let i=0;i<1000&&!existsSync(${JSON.stringify(join(fixture.base,'release'))});i++)await new Promise(r=>setTimeout(r,10));}
 const state=JSON.parse(readFileSync(serverPath,'utf8'));
 if(body.path==='exchange'){
  const digest=createHash('sha256').update(JSON.stringify({...body,path:undefined})).digest('hex');if(state.exchangeDigest&&state.exchangeDigest!==digest)return Response.json({},{status:409});
  state.exchangeDigest=digest;writeFileSync(serverPath,JSON.stringify(state));if(config.failExchange)return Response.json({},{status:503});
  return Response.json({runtimeId:config.runtimeId,expiresAt:'2099-01-01T00:00:00Z',identity:{accountId:config.accountId,orgId:config.orgId}});
 }
 const previous=state.companion,incoming=body.companion,advance=body.operation==='admit'||body.invalidate===true;
 const stale=advance?(previous&&(!incoming||incoming.generation<previous.generation||(incoming.generation===previous.generation&&incoming.id!==previous.id))):previous&&(body.operation==='register'||body.operation==='pause'||incoming)&&(!incoming||incoming.generation!==previous.generation||incoming.id!==previous.id);
 if(stale){audit(body,'rejected');return Response.json({},{status:409});}
 if(body.path==='observe'){
  if(body.operation==='pause'||body.operation==='disconnect'){state.paused=true;if(incoming)state.companion=incoming;writeFileSync(serverPath,JSON.stringify(state));}
  audit(body,'applied');return Response.json({runtimeId:config.runtimeId,availability:state.paused?'paused':'connected'});
 }
 if(body.operation==='admit'){
  if(config.denied)return Response.json({},{status:409});const fresh=!state.issued;state.issued=true;if(incoming)state.companion=incoming;if(body.resume)state.paused=false;writeFileSync(serverPath,JSON.stringify(state));audit(body,'applied');return Response.json({sessionId:config.sessionId,createAllowed:fresh,registered:!!state.registered});
 }
 if(config.failRegistration)return Response.json({},{status:503});if(state.paused)return Response.json({},{status:409});state.registered=true;writeFileSync(serverPath,JSON.stringify(state));audit(body,'applied');return Response.json({sessionId:config.sessionId,registered:true});
};
const initial=JSON.parse(readFileSync(configPath,'utf8'));
const exit=await main(process.argv.slice(2),{loadCreds:()=>({apiKey:'fixture-capture',apiBaseUrl:'https://app.codebrief.ai'}),loadConfig:()=>({apiBaseUrl:'https://app.codebrief.ai',enabledRepos:initial.noOptIn?[]:['fixture/app']}),resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root:${JSON.stringify(fixture.root)},options:{baseDir:${JSON.stringify(fixture.state)}},fetchImpl}});
writeFileSync(${JSON.stringify(fixture.calls)},JSON.stringify(calls));process.exitCode=exit;`);
    const child = spawn(node, [wrapper, ...args], { cwd: fixture.root, env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, CODEBRIEF_NATIVE_FIXTURE_COUNT: fixture.count, CODEBRIEF_NATIVE_FIXTURE_CONFIG: fixture.config }, stdio: ['pipe', 'pipe', 'pipe'] }); let output = '', error = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => error += c); child.stdin.end(hookInput ?? ''); const done = new Promise(resolveResult => child.on('exit', code => resolveResult({ code, output, error }))); return longLived ? { child, done, output: () => output } : done;
}
function fixture() { const base = mkdtempSync(join(tmpdir(), 'connected-agent-')), root = join(base, 'repo'), state = join(base, 'private'), bin = join(base, 'bin'); mkdirSync(root); mkdirSync(bin); execFileSync('git', ['init', '-q', root]); const f = { base, root, state, bin, config: join(base, 'fixture.json'), server: join(base, 'server.json'), calls: join(base, 'calls.json'), count: join(base, 'count') }; const config = { runtimeId: randomUUID(), accountId: randomUUID(), orgId: randomUUID(), repoId: randomUUID(), sessionId: randomUUID() }; writeFileSync(f.config, JSON.stringify(config)); writeFileSync(f.server, '{}'); writeFileSync(f.count, '0'); writeFileSync(join(bin, 'claude'), `#!${node}\nimport {readFileSync} from 'node:fs';const config=JSON.parse(readFileSync(process.env.CODEBRIEF_NATIVE_FIXTURE_CONFIG,'utf8'));if(config.delayNativePid===process.ppid)await new Promise(resolve=>setTimeout(resolve,750));console.log(JSON.stringify({loggedIn:true,authMethod:'claude.ai',accessToken:'never-export'}));\n`, { mode: 0o700 }); writeFileSync(join(bin, 'codex'), `#!${node}\nimport {createInterface} from 'node:readline';import {readFileSync,writeFileSync} from 'node:fs';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;let result={};if(m.method==='account/read')result={account:{type:'chatgpt',email:'fixture@example.test',token:'never-export'},requiresOpenaiAuth:true};if(m.method==='thread/start'){const p=process.env.CODEBRIEF_NATIVE_FIXTURE_COUNT;writeFileSync(p,String(Number(readFileSync(p,'utf8'))+1));result={thread:{id:'fixture-owned-thread'}};}console.log(JSON.stringify({id:m.id,result}));});\n`, { mode: 0o700 }); return { ...f, identity: config }; }
async function installClaim(f) { const { installConductorSession } = await import('./tandem-client.js'); installConductorSession(f.root, { launchId: randomUUID(), identity: { accountId: f.identity.accountId, orgId: f.identity.orgId, repoId: f.identity.repoId }, credential: 'a'.repeat(43), workspaceId: 'fixture-workspace', sessionId: 'provider-session', claim: { attemptId: randomUUID(), handoffId: randomUUID(), actionId: randomUUID(), actionVersion: 1, instanceId: randomUUID(), generation: 1, version: 1, leaseExpiresAt: '2099-01-01T00:00:00Z' } }, { baseDir: f.state }); }
for (const host of ['claude', 'codex'])
    test(`${host} packaged dispatcher preserves exact native receipt after registration failure`, async () => { const f = fixture(); try {
        await installClaim(f);
        assert.equal((await fixtureCommand(host, ['agents', 'connect', '--provider', 'codex', '--pairing', randomUUID()], f)).code, 0);
        let config = JSON.parse(readFileSync(f.config, 'utf8'));
        config.failRegistration = true;
        writeFileSync(f.config, JSON.stringify(config));
        assert.equal((await fixtureCommand(host, ['agents', 'serve', '--provider', 'codex', '--mode', 'owned-thread', '--once'], f)).code, 1);
        assert.equal(readFileSync(f.count, 'utf8'), '1');
        config.failRegistration = false;
        writeFileSync(f.config, JSON.stringify(config));
        const retry = await fixtureCommand(host, ['agents', 'serve', '--provider', 'codex', '--mode', 'owned-thread', '--once'], f);
        assert.equal(retry.code, 0, retry.error);
        assert.equal(readFileSync(f.count, 'utf8'), '1');
        assert.equal((await fixtureCommand(host, ['agents', 'stop', '--provider', 'codex'], f)).code, 0);
        assert.equal(retry.output.includes('never-export'), false);
        assert.equal(statSync(f.state).mode & 0o777, 0o700);
    }
    finally {
        rmSync(f.base, { recursive: true, force: true });
    } });
for (const host of ['claude', 'codex'])
    test(`${host} Codex login request never invokes native authentication or pairing`, async () => { const f = fixture(); try {
        const result = await fixtureCommand(host, ['agents', 'connect', '--provider', 'codex', '--login', '--pairing', randomUUID()], f);
        assert.equal(result.code, 1);
        assert.match(result.error, /native_login_required/);
        assert.equal(readFileSync(f.calls, 'utf8'), '[]');
        assert.equal(readFileSync(f.count, 'utf8'), '0');
    }
    finally {
        rmSync(f.base, { recursive: true, force: true });
    } });
for (const host of ['claude', 'codex'])
    test(`${host} Claude checkpoint ignores transcript fields and explicit serve requires successful exact hook registration`, async () => { const f = fixture(); try {
        await installClaim(f);
        assert.equal((await fixtureCommand(host, ['agents', 'connect', '--provider', 'claude', '--pairing', randomUUID()], f)).code, 0);
        const missing = await fixtureCommand(host, ['agents', 'serve', '--provider', 'claude', '--mode', 'checkpoint', '--once'], f);
        assert.equal(missing.code, 1);
        assert.equal(JSON.parse(readFileSync(f.calls, 'utf8')).some(x => x.operation === 'admit'), false);
        const hook = await fixtureCommand(host, ['agents', 'checkpoint', '--provider', 'claude', '--hook-input'], f, { hookInput: JSON.stringify({ session_id: 'native-claude-session', transcript_path: '/private/secret', tool_input: { secret: 'never-store' } }) });
        assert.equal(hook.code, 0, hook.error);
        assert.equal((await fixtureCommand(host, ['agents', 'serve', '--provider', 'claude', '--mode', 'checkpoint', '--once'], f)).code, 0);
        const changed = await fixtureCommand(host, ['agents', 'checkpoint', '--provider', 'claude', '--hook-input'], f, { hookInput: '{"session_id":"other-native-session"}' });
        assert.equal(changed.code, 1);
        assert.equal(JSON.stringify(readFileSync(f.calls, 'utf8')).includes('never-store'), false);
    }
    finally {
        rmSync(f.base, { recursive: true, force: true });
    } });
for (const host of ['claude', 'codex'])
    test(`${host} denied admission and unknown native create never cause a second thread`, async () => {
        const f = fixture();
        try {
            await installClaim(f);
            assert.equal((await fixtureCommand(host, ['agents', 'connect', '--provider', 'codex', '--pairing', randomUUID()], f)).code, 0);
            let config = JSON.parse(readFileSync(f.config, 'utf8'));
            config.denied = true;
            writeFileSync(f.config, JSON.stringify(config));
            assert.equal((await fixtureCommand(host, ['agents', 'serve', '--provider', 'codex', '--mode', 'owned-thread', '--once'], f)).code, 1);
            assert.equal(readFileSync(f.count, 'utf8'), '0');
            config.denied = false;
            writeFileSync(f.config, JSON.stringify(config));
            const executable = join(f.bin, 'codex');
            writeFileSync(executable, readFileSync(executable, 'utf8').replace("id:'fixture-owned-thread'", "id:null"), { mode: 0o700 });
            for (let i = 0; i < 2; i++)
                assert.equal((await fixtureCommand(host, ['agents', 'serve', '--provider', 'codex', '--mode', 'owned-thread', '--once'], f)).code, 1);
            assert.equal(readFileSync(f.count, 'utf8'), '1');
        }
        finally {
            rmSync(f.base, { recursive: true, force: true });
        }
    });
for (const host of ['claude', 'codex'])
    test(`${host} Claude hook invalid input and missing Capture opt-in issue no session authority`, async () => {
        const f = fixture();
        try {
            await installClaim(f);
            assert.equal((await fixtureCommand(host, ['agents', 'connect', '--provider', 'claude', '--pairing', randomUUID()], f)).code, 0);
            for (const hookInput of ['{}', '{"session_id":"bad\\u0000id"}', Buffer.from([0xff])]) {
                assert.equal((await fixtureCommand(host, ['agents', 'checkpoint', '--provider', 'claude', '--hook-input'], f, { hookInput })).code, 1);
                assert.equal(JSON.parse(readFileSync(f.calls, 'utf8')).some(x => x.operation === 'admit'), false);
            }
            const config = JSON.parse(readFileSync(f.config, 'utf8'));
            config.noOptIn = true;
            writeFileSync(f.config, JSON.stringify(config));
            assert.equal((await fixtureCommand(host, ['agents', 'checkpoint', '--provider', 'claude', '--hook-input'], f, { hookInput: '{"session_id":"native-session"}' })).code, 1);
            assert.equal(readFileSync(f.calls, 'utf8'), '[]');
        }
        finally {
            rmSync(f.base, { recursive: true, force: true });
        }
    });
for(const host of ['claude','codex'])test(`${host} lost exchange response replays private persisted envelope`,async()=>{const f=fixture();try{
 const config=JSON.parse(readFileSync(f.config,'utf8'));config.failExchange=true;writeFileSync(f.config,JSON.stringify(config));const args=['agents','connect','--provider','claude','--pairing',randomUUID()];assert.equal((await fixtureCommand(host,args,f)).code,1);const digest=JSON.parse(readFileSync(f.server,'utf8')).exchangeDigest;
 const {localConnectionKey,loadConnectedState}=await import('./connected-agent-state.js');const key=localConnectionKey('fixture-capture','claude'),before=loadConnectedState(key,{baseDir:f.state});assert.equal(Buffer.from(before.nonce,'base64url').length,32);assert.equal(statSync(join(f.state,'connected-agents','v1',key,'state.json')).mode&0o777,0o600);
 config.failExchange=false;writeFileSync(f.config,JSON.stringify(config));assert.equal((await fixtureCommand(host,args,f)).code,0);const after=loadConnectedState(key,{baseDir:f.state});assert.equal(after.nonce,before.nonce);assert.equal(after.requestId,before.requestId);assert.equal(JSON.parse(readFileSync(f.server,'utf8')).exchangeDigest,digest);
}finally{rmSync(f.base,{recursive:true,force:true});}});

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function companionReady(process) {
 for (let i=0;i<100;i++) { if (process.output().includes('checkpoint_wait')) return; if (process.child.exitCode !== null) throw new Error('companion exited before ready'); await pause(20); }
 throw new Error('companion readiness timeout');
}
async function waitForAppliedRegistration(companion, auditPath, before) {
 // Polling includes the 5s interval and native observation, not only the timer.
 const deadline=Date.now()+20000;
 while(Date.now()<deadline) {
  const later=readFileSync(auditPath,'utf8').trim().split('\n').slice(before).map(JSON.parse);
  if(companion.child.exitCode!==null||companion.child.signalCode!==null)
   throw new Error(`replacement exited before successful polling: code=${companion.child.exitCode}, signal=${companion.child.signalCode}`);
  if(later.some(x=>x.pid===companion.child.pid&&x.operation==='register'&&x.stage==='applied'))return later;
  await pause(25);
 }
 const stages=readFileSync(auditPath,'utf8').trim().split('\n').slice(before).map(JSON.parse).filter(x=>x.pid===companion.child.pid).map(({operation,stage})=>({operation,stage}));
 throw new Error(`replacement polling deadline exceeded: ${JSON.stringify(stages)}`);
}
for (const host of ['claude','codex']) test(`${host} long-lived companion excludes second serve and fences stale Stop/signal`, async () => {
 const f=fixture(), processes=[];
 try {
  await installClaim(f);
  assert.equal((await fixtureCommand(host,['agents','connect','--provider','claude','--pairing',randomUUID()],f)).code,0);
  assert.equal((await fixtureCommand(host,['agents','checkpoint','--provider','claude','--hook-input'],f,{hookInput:'{"session_id":"native-claude-session"}'})).code,0);
  const args=['agents','serve','--provider','claude','--mode','checkpoint'];
  const old=await fixtureCommand(host,args,f,{longLived:true});processes.push(old);await companionReady(old);
  const second=await fixtureCommand(host,args,f,{longLived:true});processes.push(second);
  const rejected=await Promise.race([second.done,pause(1500).then(()=>({code:'still-running'}))]);
  assert.equal(rejected.code,1,'second companion must not become a second polling owner');
  assert.equal((await fixtureCommand(host,['agents','stop','--provider','claude'],f)).code,0);
  const replacement=await fixtureCommand(host,args,f,{longLived:true});processes.push(replacement);await companionReady(replacement);
  // Deterministically exceed the former 0.5s observation allowance.
  const config=JSON.parse(readFileSync(f.config,'utf8'));config.delayNativePid=replacement.child.pid;writeFileSync(f.config,JSON.stringify(config));
  const auditPath=join(f.base,'audit.jsonl');const before=readFileSync(auditPath,'utf8').trim().split('\n').length;
  old.child.kill('SIGINT');await old.done;
  const later=await waitForAppliedRegistration(replacement,auditPath,before);
  assert.equal(later.some(x=>x.pid===old.child.pid),false,'stale sleeper/signal must issue no presence or teardown request');
  assert.equal(later.some(x=>x.pid===replacement.child.pid&&x.operation==='register'&&x.stage==='applied'),true,'replacement continues polling');
  assert.equal(readFileSync(f.count,'utf8'),'0');
 } finally { for (const p of processes) { if(p.child.exitCode===null)p.child.kill('SIGKILL');await p.done; } rmSync(f.base,{recursive:true,force:true}); }
});

async function waitFile(path) {for(let i=0;i<800;i++){if(existsSync(path))return;await pause(10);}throw new Error('fixture barrier timeout');}
for(const host of ['claude','codex'])for(const delayed of ['pause','register'])test(`${host} long-lived server fences delayed old ${delayed} through replacement`,async()=>{
 const f=fixture(),processes=[];
 try{
  await installClaim(f);
  assert.equal((await fixtureCommand(host,['agents','connect','--provider','claude','--pairing',randomUUID()],f)).code,0);
  assert.equal((await fixtureCommand(host,['agents','checkpoint','--provider','claude','--hook-input'],f,{hookInput:'{"session_id":"native-claude-session"}'})).code,0);
  const args=['agents','serve','--provider','claude','--mode','checkpoint'];
  const old=await fixtureCommand(host,args,f,{longLived:true});processes.push(old);await companionReady(old);
  const config=JSON.parse(readFileSync(f.config,'utf8'));config.delayPid=old.child.pid;config.delayOperation=delayed;writeFileSync(f.config,JSON.stringify(config));
  if(delayed==='pause')old.child.kill('SIGINT');
  await waitFile(join(f.base,'blocked'));
  if(delayed==='register')assert.equal((await fixtureCommand(host,['agents','stop','--provider','claude'],f)).code,0);
  const replacement=await fixtureCommand(host,args,f,{longLived:true});processes.push(replacement);await companionReady(replacement);
  writeFileSync(join(f.base,'release'),'release');
  if(delayed==='register')old.child.kill('SIGINT');
  await old.done;
  const audit=readFileSync(join(f.base,'audit.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(audit.some(x=>x.pid===old.child.pid&&x.operation===delayed&&x.stage==='rejected'),true,'delayed request is rejected by server CAS');
  assert.equal(JSON.parse(readFileSync(f.server,'utf8')).paused,false,'replacement presence remains active');
  assert.equal(readFileSync(f.count,'utf8'),'0');
 }finally{for(const p of processes){if(p.child.exitCode===null)p.child.kill('SIGKILL');await p.done;}rmSync(f.base,{recursive:true,force:true});}
});

test('stale native receipt preservation cannot overwrite replacement presence or frozen startup identity',async()=>{
 const f=fixture();
 try{
  const {localConnectionKey,saveConnectedState,loadConnectedState,updateCompanion,saveFencedConnectedState,preserveNativeReceipt}=await import('./connected-agent-state.js');
  const key=localConnectionKey('fixture-capture','codex'),options={baseDir:f.state},sessionId=randomUUID(),startupKey='frozen-attempt';
  const state={runtimeId:f.identity.runtimeId,paused:false,startups:{[startupKey]:{sessionId,phase:'issued',nativeSessionId:null}}};
  saveConnectedState(key,state,options);
  const first={id:randomUUID(),generation:1,active:true};updateCompanion(key,options,()=>first);
  updateCompanion(key,options,()=>({id:randomUUID(),generation:3,active:true}));
  const late={...state,paused:true,startups:{[startupKey]:{sessionId,phase:'created',nativeSessionId:'exact-native-receipt'}}};
  assert.throws(()=>saveFencedConnectedState(key,late,options,first),/companion_stale/);
  preserveNativeReceipt(key,late,options);
  const preserved=loadConnectedState(key,options);assert.equal(preserved.paused,false);assert.equal(preserved.startups[startupKey].nativeSessionId,'exact-native-receipt');
  preserveNativeReceipt(key,{...late,startups:{[startupKey]:{sessionId:randomUUID(),phase:'created',nativeSessionId:'wrong'}}},options);
  assert.equal(loadConnectedState(key,options).startups[startupKey].nativeSessionId,'exact-native-receipt');
 }finally{rmSync(f.base,{recursive:true,force:true});}
});
