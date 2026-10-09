import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync,execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {installConductorSession} from './tandem-client.js';
import {localConnectionKey,saveConnectedState} from './connected-agent-state.js';
import {parseRoomCommand,readRoomPostInput,validateRoomResponse} from './room-discussion.js';
const packageRoot=resolve(fileURLToPath(new URL('../../',import.meta.url)));
test('room input is exact, bounded descriptor data; receipt must match original operation and room',()=>{
 const base=mkdtempSync(join(tmpdir(),'room-input-'));try{
 const roomId=randomUUID(),input={operationId:randomUUID(),text:'Ordinary discussion'},file=join(base,'input');writeFileSync(file,JSON.stringify(input));assert.deepEqual(readRoomPostInput(file),input);writeFileSync(file,JSON.stringify({...input,operationId:input.operationId.toUpperCase()}));assert.deepEqual(readRoomPostInput(file),input);
 symlinkSync(file,join(base,'link'));assert.throws(()=>readRoomPostInput(join(base,'link')));
 writeFileSync(file,JSON.stringify({...input,result:'fabricated'}));assert.throws(()=>readRoomPostInput(file));writeFileSync(file,'x'.repeat(16385));assert.throws(()=>readRoomPostInput(file));
 assert.throws(()=>parseRoomCommand(['rooms','post','--room',roomId,'--provider','claude']));
 assert.throws(()=>parseRoomCommand(['rooms','read','--room',roomId,'--provider','claude','--stream','unknown']));
 const cmd={operation:'post',roomId,input},receipt={operationId:input.operationId,roomId,messageId:randomUUID(),version:1,sequence:1,deleted:false,erased:false};assert.deepEqual(validateRoomResponse(cmd,receipt),receipt);
 for(const bad of [{...receipt,operationId:randomUUID()},{...receipt,roomId:randomUUID()},{...receipt,result:'fabricated'},{...receipt,sequence:0}])assert.throws(()=>validateRoomResponse(cmd,bad));
 }finally{rmSync(base,{recursive:true,force:true});}
});
for(const host of ['claude','codex'])for(const relay of [false,true])test(`${host} packaged ${relay?'Conductor':'native'} room post/read keeps original identity and separate signed cursors`,()=>{
 const base=mkdtempSync(join(tmpdir(),'room-package-')),root=join(base,'repo'),state=join(base,'state');mkdirSync(root);execFileSync('git',['init','-q',root]);
 try{
 const claim={attemptId:randomUUID(),handoffId:randomUUID(),actionId:randomUUID(),actionVersion:1,instanceId:randomUUID(),generation:1,version:1,leaseExpiresAt:'2099-01-01T00:00:00Z'},identity={accountId:randomUUID(),orgId:randomUUID(),repoId:randomUUID()},runtimeId=randomUUID(),sessionId=randomUUID(),launchId=randomUUID(),credentials={apiKey:'fixture-capture',apiBaseUrl:'https://app.codebrief.ai'};
 installConductorSession(root,{...(relay?{launchId}:{}),credential:'fixture-private',claim,identity,workspaceId:'fixture-workspace',sessionId:'fixture-native'},{baseDir:state});
 if(!relay)saveConnectedState(localConnectionKey(credentials.apiKey,host),{runtimeId,nonce:'fixture-runtime',provider:host,identity:{...identity,provider:host,runtimeId},startups:{[JSON.stringify([claim.attemptId,claim.instanceId,claim.generation])]:{phase:'registered',sessionId,nativeSessionId:'fixture-native'}}},{baseDir:state});
 const roomId=randomUUID(),input={operationId:randomUUID(),text:'Shared discussion'},messageId=randomUUID(),inputFile=join(base,'input.json'),audit=join(base,'audit.json');writeFileSync(inputFile,JSON.stringify(input));writeFileSync(audit,'[]');
 const entry=pathToFileURL(join(packageRoot,host==='claude'?'scripts/codebrief-cli.js':'codex/codebrief-capture/scripts/codebrief-cli.js')).href,wrapper=join(base,'wrapper.mjs');
 writeFileSync(wrapper,`import {readFileSync,writeFileSync} from 'node:fs';const f=JSON.parse(process.argv[2]),{main}=await import(f.entry);process.exitCode=await main(process.argv.slice(3),{loadCreds:()=>f.relay?null:f.credentials,resolveRepo:()=>({fullName:'fixture/app'}),agentsContext:{root:f.root,options:{baseDir:f.state},fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),call=f.relay?body.payload:body,operation=f.relay?body.operation.slice(5):url.split('/').at(-1);if(f.relay){if(url!=='https://app.codebrief.ai/api/conductor/launches/'+f.launchId+'/relay'||init.headers.authorization!=='Bearer fixture-private'||!['room_post','room_read'].includes(body.operation))throw Error();}else if(url!=='https://app.codebrief.ai/api/capture/rooms/'+operation||init.headers['x-codebrief-runtime-credential']!=='fixture-runtime'||init.headers['x-codebrief-tandem-credential']!=='fixture-private'||call.runtimeId!==f.runtimeId||call.sessionId!==f.sessionId)throw Error();if(call.roomId!==f.roomId||call.claim.attemptId!==f.claim.attemptId)throw Error();const calls=JSON.parse(readFileSync(f.audit));calls.push({operation,input:call.input});writeFileSync(f.audit,JSON.stringify(calls));if(f.malformed)return Response.json({token:'must-not-print'});return Response.json(operation==='post'?{operationId:f.input.operationId,roomId:f.roomId,messageId:f.messageId,version:1,sequence:1,deleted:false,erased:false}:{[call.input.stream]:[],nextCursor:'fixture.signed-cursor'});}}});`);
 const fixture={entry,audit,root,state,roomId,input,messageId,claim,relay,launchId,credentials,runtimeId,sessionId};const run=(args,extra={})=>spawnSync(process.execPath,[wrapper,JSON.stringify({...fixture,...extra}),'agents','rooms',...args,'--provider',relay?'conductor':host,'--room',roomId],{cwd:root,encoding:'utf8'});
 const post=run(['post','--input',inputFile]);assert.equal(post.status,0,post.stderr);assert.equal(JSON.parse(post.stdout).operationId,input.operationId);
 const again=run(['post','--input',inputFile]);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout).messageId,messageId);
 for(const stream of ['messages','events']){const read=run(['read','--stream',stream,'--cursor','prior.signed-cursor']);assert.equal(read.status,0,read.stderr);assert.deepEqual(JSON.parse(read.stdout),{[stream]:[],nextCursor:'fixture.signed-cursor'});}
 const bad=run(['post','--input',inputFile],{malformed:true});assert.notEqual(bad.status,0);assert.match(bad.stderr,/Room post is unconfirmed/);assert.doesNotMatch(bad.stdout,/must-not-print/);
 const calls=JSON.parse(readFileSync(audit));assert.equal(calls.length,5,'unknown response makes one call and no automatic resend');assert.deepEqual(calls.slice(0,2).map(c=>c.input),[input,input]);assert.deepEqual(calls.slice(2,4).map(c=>c.input),[{stream:'messages',cursor:'prior.signed-cursor'},{stream:'events',cursor:'prior.signed-cursor'}]);
 }finally{rmSync(base,{recursive:true,force:true});}
});

test('both installed agent skills teach actual room discovery, current authority and stable unknown operation recovery',()=>{
 const canonical=readFileSync(join(packageRoot,'skills/codebrief-agents/SKILL.md'),'utf8'),codex=readFileSync(join(packageRoot,'codex/codebrief-capture/skills/codebrief-agents/SKILL.md'),'utf8');
 assert.equal(canonical.replace('$CLAUDE_PLUGIN_ROOT/scripts/codebrief-cli.js','$SKILL_DIR/../../scripts/codebrief-cli.js'),codex);
 for(const skill of [canonical,codex])for(const phrase of ['There is no packaged room-list command','agents rooms read','agents rooms post','--stream events','nextCursor','room_post_unknown','never generate a new operation ID','current write-owning participant','agents tool','returned author'])assert.ok(skill.includes(phrase),phrase);
});
