import {test} from 'node:test';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,symlinkSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildStandaloneRelease} from './build-standalone-release.js';
test('standalone producer freezes exact runtime bytes and refuses a destination replay',()=>{
 const root=mkdtempSync(join(tmpdir(),'capture-artifact-'));
 try{const source=join(root,'source'),destination=join(root,'artifact');mkdirSync(source);mkdirSync(join(source,'scripts'));writeFileSync(join(source,'package.json'),JSON.stringify({version:'0.10.2'}));writeFileSync(join(source,'scripts','codebrief-cli.js'),'runtime');writeFileSync(join(source,'scripts','fixture.test.js'),'excluded');
 const result=buildStandaloneRelease({source,destination});assert.match(result.manifestSha256,/^[a-f0-9]{64}$/);const manifest=JSON.parse(readFileSync(join(destination,'release-manifest.json')));assert.deepEqual(manifest.files.map(x=>x.path),['package.json','scripts/codebrief-cli.js']);assert.equal(readFileSync(join(destination,'scripts','codebrief-cli.js'),'utf8'),'runtime');assert.throws(()=>buildStandaloneRelease({source,destination}),/capture_artifact_invalid/);
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('standalone producer rejects symlinks and unsupported versions before publication',()=>{
 const root=mkdtempSync(join(tmpdir(),'capture-artifact-'));try{const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'package.json'),JSON.stringify({version:'0.9.1'}));assert.throws(()=>buildStandaloneRelease({source,destination:join(root,'old')}),/capture_artifact_invalid/);writeFileSync(join(source,'package.json'),JSON.stringify({version:'0.10.2'}));mkdirSync(join(source,'scripts'));symlinkSync(join(source,'package.json'),join(source,'scripts','linked.js'));assert.throws(()=>buildStandaloneRelease({source,destination:join(root,'linked')}),/capture_artifact_invalid/);}finally{rmSync(root,{recursive:true,force:true});}
});

function raceFixture(t){const root=mkdtempSync(join(tmpdir(),'capture-artifact-race-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const source=join(root,'source');mkdirSync(source);writeFileSync(join(source,'package.json'),JSON.stringify({version:'0.10.2'}));mkdirSync(join(source,'scripts'));const leaf=join(source,'scripts/runtime.js');writeFileSync(leaf,'reviewed runtime');return{root,source,leaf,destination:join(root,'artifact')};}
function patchFs(name,wrapper,body){const original=fs[name];fs[name]=wrapper(original);syncBuiltinESMExports();try{return body();}finally{fs[name]=original;syncBuiltinESMExports();}}
test('leaf swapped to symlink after traversal check is rejected before artifact writes',t=>{
 const f=raceFixture(t),outside=join(f.root,'outside');writeFileSync(outside,'unreviewed replacement');let swapped=false;
 patchFs('lstatSync',original=>path=>{const stat=original(path);if(path===f.leaf&&!swapped){swapped=true;rmSync(f.leaf);symlinkSync(outside,f.leaf);}return stat;},()=>assert.throws(()=>buildStandaloneRelease(f),/capture_artifact_invalid/));
 assert.equal(swapped,true);assert.equal(fs.existsSync(f.destination),false);
});
test('already opened source stays bound to its descriptor after path replacement',t=>{
 const f=raceFixture(t);let swapped=false;
 patchFs('openSync',original=>(path,...args)=>{const fd=original(path,...args);if(path===f.leaf&&!swapped){swapped=true;fs.renameSync(f.leaf,f.leaf+'.original');writeFileSync(f.leaf,'unreviewed replacement');}return fd;},()=>buildStandaloneRelease(f));
 assert.equal(swapped,true);assert.equal(readFileSync(join(f.destination,'scripts/runtime.js'),'utf8'),'reviewed runtime');assert.equal(readFileSync(f.leaf,'utf8'),'unreviewed replacement');
});
test('FIFO source rejects without opening a blocking stream or writing an artifact',t=>{
 const f=raceFixture(t);rmSync(f.leaf);assert.equal(spawnSync('mkfifo',[f.leaf]).status,0);
 assert.throws(()=>buildStandaloneRelease(f),/capture_artifact_invalid/);assert.equal(fs.existsSync(f.destination),false);
});
test('oversize source fails before any content read or artifact writes',t=>{
 const f=raceFixture(t);fs.truncateSync(f.leaf,8388609);let pathReads=0,descriptorReads=0;
 patchFs('readFileSync',original=>(path,...args)=>{if(path===f.leaf)pathReads++;return original(path,...args);},()=>patchFs('readSync',original=>(...args)=>{if(fs.fstatSync(args[0]).size===8388609)descriptorReads++;return original(...args);},()=>assert.throws(()=>buildStandaloneRelease(f),/capture_artifact_invalid/)));
 assert.equal(pathReads,0);assert.equal(descriptorReads,0);
 assert.equal(fs.existsSync(f.destination),false);
});
