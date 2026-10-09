import {createHash} from 'node:crypto';
import {constants,closeSync,existsSync,fstatSync,lstatSync,openSync,readSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const fail=()=>{throw new Error('capture_artifact_invalid');};
const LIMIT=8388608;
function regularBytes(path,max){
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const stat=fstatSync(fd);if(!stat.isFile()||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>max)fail();
  const bytes=Buffer.alloc(stat.size+1);let offset=0;
  while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,null);if(!count)break;offset+=count;}
  if(offset!==stat.size)fail();return bytes.subarray(0,offset);
 }finally{closeSync(fd);}
}
/** Offline reviewed-byte producer. Publication supplies a separately trusted hash. */
export function buildStandaloneRelease({source,destination}){
 source=resolve(source);destination=resolve(destination);
 const collected=[];let total=0;
 const walk=(relative)=>{const path=join(source,relative),stat=lstatSync(path);if(stat.isSymbolicLink())fail();if(stat.isDirectory()){for(const name of readdirSync(path).sort())walk(`${relative}/${name}`);return;}if(!stat.isFile())fail();if(relative.endsWith('.test.js')||relative==='scripts/build-codex-package.js'||relative.startsWith('scripts/build-standalone-release.')||relative==='scripts/validate-package.js')return;
 if(relative.length>512||relative.includes('\\')||relative.split('/').some(p=>!p||p==='.'||p==='..'))fail();if(collected.length>=512)fail();const bytes=regularBytes(path,LIMIT-total);total+=bytes.length;collected.push({path:relative,bytes});};
 try{if(!lstatSync(source).isDirectory()||lstatSync(source).isSymbolicLink())fail();for(const name of ['package.json','.claude-plugin','scripts','hooks','skills','schemas']){if(existsSync(join(source,name)))walk(name);else if(name==='package.json')fail();}
 if(JSON.parse(collected.find(f=>f.path==='package.json').bytes.toString()).version!=='0.10.1')fail();
 collected.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const bytes=Buffer.from(JSON.stringify({schemaVersion:1,name:'codebrief-capture-standalone',version:'0.10.1',files:collected.map(f=>({path:f.path,sha256:sha(f.bytes),size:f.bytes.length}))})+'\n');
 mkdirSync(destination,{mode:0o700});for(const file of collected){const target=join(destination,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o700});writeFileSync(target,file.bytes,{flag:'wx',mode:0o600});}writeFileSync(join(destination,'release-manifest.json'),bytes,{flag:'wx',mode:0o600});return{version:'0.10.1',manifestSha256:sha(bytes)};
 }catch{fail();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw new Error('usage: build-standalone-release.js <new-output-directory>');
 console.log(JSON.stringify(buildStandaloneRelease({source:join(dirname(fileURLToPath(import.meta.url)),'..'),destination:process.argv[2]})));
}
