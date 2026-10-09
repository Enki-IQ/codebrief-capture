import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,realpathSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {verifyCaptureRelease,installCaptureRelease} from './release-installation.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function fixture(t){const root=mkdtempSync(join(realpathSync(tmpdir()),'capture-release-'));t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'scripts'));const source='reviewed runtime';writeFileSync(join(root,'scripts/runtime.js'),source);const manifest={schemaVersion:1,name:'codebrief-capture-standalone',version:'0.10.1',files:[{path:'scripts/runtime.js',sha256:hash(source),size:Buffer.byteLength(source)}]};const bytes=JSON.stringify(manifest);writeFileSync(join(root,'release-manifest.json'),bytes);return{root,manifest,manifestSha256:hash(bytes)};}
function amend(f,change){change(f.manifest);const bytes=JSON.stringify(f.manifest);writeFileSync(join(f.root,'release-manifest.json'),bytes);f.manifestSha256=hash(bytes);}
test('verifies actual reviewed manifest and every file without returning runtime source',t=>{const f=fixture(t);writeFileSync(join(f.root,'.codebrief-installation.json'),JSON.stringify({schemaVersion:1,version:'0.10.1',manifestSha256:f.manifestSha256}));assert.deepEqual(verifyCaptureRelease(f),{version:'0.10.1',manifestSha256:f.manifestSha256});});
test('rejects wrong trusted checksum and tampered missing extra bytes',t=>{const f=fixture(t);assert.throws(()=>verifyCaptureRelease({...f,manifestSha256:'0'.repeat(64)}),/capture_release_invalid/);writeFileSync(join(f.root,'scripts/runtime.js'),'secret sentinel');assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);rmSync(join(f.root,'scripts/runtime.js'));assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);writeFileSync(join(f.root,'scripts/runtime.js'),'reviewed runtime');writeFileSync(join(f.root,'unlisted'),'unlisted');assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});
for(const path of ['../outside','/absolute','scripts/../runtime.js','scripts//runtime.js','scripts\\runtime.js','release-manifest.json','.codebrief-installation.json'])test(`rejects unsafe manifest path ${path}`,t=>{const f=fixture(t);amend(f,m=>m.files[0].path=path);assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});
test('rejects duplicate, unsorted and overbounded manifests',t=>{const f=fixture(t);amend(f,m=>m.files.push({...m.files[0]}));assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);amend(f,m=>m.files=Array.from({length:513},(_,i)=>({path:`scripts/${i}`,sha256:'0'.repeat(64),size:0})));assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});
test('rejects symlink source roots files and directory ancestors',t=>{const f=fixture(t);const link=join(f.root,'link');symlinkSync(f.root,link);assert.throws(()=>verifyCaptureRelease({...f,root:link}),/capture_release_invalid/);rmSync(link);rmSync(join(f.root,'scripts/runtime.js'));symlinkSync(join(f.root,'release-manifest.json'),join(f.root,'scripts/runtime.js'));assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});

test('rejects unsorted entries, wrong release identity and total byte overflow',t=>{
 const f=fixture(t);amend(f,m=>m.files=[{path:'z',sha256:hash(''),size:0},{path:'a',sha256:hash(''),size:0}]);assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);
 amend(f,m=>{m.files=[];m.version='0.9.1';});assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);
 amend(f,m=>{m.version='0.10.1';m.files=[{path:'a',sha256:hash(''),size:8388608},{path:'b',sha256:hash(''),size:1}];});assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);
});
test('installation receipt is bounded exact metadata and cannot substitute a trusted manifest hash',t=>{
 const f=fixture(t);const receipt=join(f.root,'.codebrief-installation.json');writeFileSync(receipt,JSON.stringify({schemaVersion:1,version:'0.10.1',manifestSha256:f.manifestSha256}));assert.deepEqual(verifyCaptureRelease(f),{version:'0.10.1',manifestSha256:f.manifestSha256});
 writeFileSync(receipt,JSON.stringify({schemaVersion:1,version:'0.10.1',manifestSha256:f.manifestSha256,secret:'DO_NOT_PRINT'}));assert.throws(()=>verifyCaptureRelease(f),e=>e.message==='capture_release_invalid');
});

function installation(t){const f=fixture(t);const home=mkdtempSync(join(realpathSync(tmpdir()),'capture-home-'));t.after(()=>rmSync(home,{recursive:true,force:true}));return{...f,source:f.root,home,destination:join(home,'.codebrief/capture/releases/0.10.1')};}
test('fixed-home install publishes receipt last and exact completed bytes are idempotent',t=>{const f=installation(t);const expected={version:'0.10.1',manifestSha256:f.manifestSha256};assert.deepEqual(installCaptureRelease(f),expected);assert.deepEqual(verifyCaptureRelease({root:f.destination,manifestSha256:f.manifestSha256}),expected);assert.deepEqual(installCaptureRelease(f),expected);writeFileSync(join(f.destination,'scripts/runtime.js'),'different existing');assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);assert.equal(readFileSync(join(f.destination,'scripts/runtime.js'),'utf8'),'different existing');});
test('unrelated empty directory and incomplete destination are never overwritten or completed',t=>{const f=installation(t);mkdirSync(f.destination,{recursive:true});assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);assert.equal(existsSync(join(f.destination,'release-manifest.json')),false);writeFileSync(join(f.destination,'unrelated'),'preserve');assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);assert.equal(readFileSync(join(f.destination,'unrelated'),'utf8'),'preserve');});
test('destination and ancestor symlinks fail closed without writing target',t=>{const f=installation(t);mkdirSync(join(f.home,'.codebrief/capture/releases'),{recursive:true});symlinkSync(f.root,f.destination);assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);assert.equal(existsSync(join(f.root,'.codebrief-installation.json')),false);});
test('missing completion receipt rejects otherwise exact bytes',t=>{const f=fixture(t);assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});

const libraryUrl=new URL('./release-installation.js',import.meta.url).href;
const installerPath=fileURLToPath(new URL('../install-release.js',import.meta.url));
test('interruption before completion leaves owned partial non-executable and does not print source',t=>{
 const f=installation(t);
 const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const original=fs.writeFileSync;fs.writeFileSync=(fd,bytes)=>{if(String(bytes).includes('manifestSha256'))throw Error('SECRET_SHOULD_NOT_APPEAR');return original(fd,bytes);};syncBuiltinESMExports();const {installCaptureRelease}=await import(process.argv[1]);try{installCaptureRelease(JSON.parse(process.argv[2]));}catch(e){process.stderr.write(e.message);process.exitCode=1;}`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,libraryUrl,JSON.stringify(f)],{encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/capture_installation_incomplete/);assert.equal(result.stderr.includes('SECRET_SHOULD_NOT_APPEAR'),false);assert.equal(result.stderr.includes('reviewed runtime'),false);assert.equal(readFileSync(join(f.destination,'.codebrief-installation.json')).length,0);assert.throws(()=>verifyCaptureRelease({root:f.destination,manifestSha256:f.manifestSha256}),/capture_release_invalid/);assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);
});
test('concurrent production CLI installers preserve one complete exact fixed release',async t=>{
 const f=installation(t);
 const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,[installerPath,'--source',f.root,'--manifest-sha256',f.manifestSha256],{env:{...process.env,HOME:f.home},stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>err+=v);child.on('error',reject);child.on('close',code=>resolve({code,out,err}));});
 const results=await Promise.all([run(),run()]);assert.ok(results.some(r=>r.code===0));assert.ok(results.every(r=>r.code===0||r.err.includes('capture_installation_rejected')));assert.deepEqual(verifyCaptureRelease({root:f.destination,manifestSha256:f.manifestSha256}),{version:'0.10.1',manifestSha256:f.manifestSha256});assert.equal((await run()).code,0);
});
test('CLI accepts no destination version or home override',t=>{const f=installation(t);const result=spawnSync(process.execPath,[installerPath,'--source',f.root,'--manifest-sha256',f.manifestSha256,'--home',f.home],{env:{...process.env,HOME:f.home},encoding:'utf8'});assert.equal(result.status,1);assert.equal(existsSync(f.destination),false);});

test('symlink installation parent is rejected without touching target',t=>{const f=installation(t);symlinkSync(f.root,join(f.home,'.codebrief'));assert.throws(()=>installCaptureRelease(f),/capture_installation_rejected/);assert.equal(existsSync(join(f.root,'capture')),false);});
test('special manifest file is rejected without blocking or reading it',t=>{const f=fixture(t);rmSync(join(f.root,'release-manifest.json'));const result=spawnSync('/usr/bin/mkfifo',[join(f.root,'release-manifest.json')]);assert.equal(result.status,0);assert.throws(()=>verifyCaptureRelease(f),/capture_release_invalid/);});
