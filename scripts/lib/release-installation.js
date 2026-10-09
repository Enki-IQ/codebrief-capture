import {createHash} from 'node:crypto';
import {constants,closeSync,fstatSync,lstatSync,openSync,readSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
const VERSION='0.10.0',LIMIT=8388608,MANIFEST='release-manifest.json',RECEIPT='.codebrief-installation.json';
const invalid=()=>{throw new Error('capture_release_invalid');};
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function exact(value,keys){return value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(k=>Object.hasOwn(value,k));}
function directory(path){const info=lstatSync(path);if(!info.isDirectory()||info.isSymbolicLink())invalid();return info;}
function ancestors(path){let current=resolve(path);while(true){directory(current);const next=dirname(current);if(next===current)break;current=next;}}
function regular(path,max){const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=fstatSync(fd);if(!stat.isFile()||stat.size>max)invalid();const buffer=Buffer.alloc(stat.size+1);let offset=0;while(offset<buffer.length){const count=readSync(fd,buffer,offset,buffer.length-offset,null);if(!count)break;offset+=count;}if(offset!==stat.size)invalid();return buffer.subarray(0,offset);}finally{closeSync(fd);}}
function safePath(value){return typeof value==='string'&&value.length<=512&&!isAbsolute(value)&&!value.includes('\\')&&!value.includes('\0')&&value.split('/').every(p=>p&&p!=='.'&&p!=='..')&&value!==MANIFEST&&value!==RECEIPT;}
function verified({root,manifestSha256},requireReceipt=false){
 if(typeof root!=='string'||typeof manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(manifestSha256))invalid();
 root=resolve(root);ancestors(root);
 const bytes=regular(join(root,MANIFEST),262144);if(hash(bytes)!==manifestSha256)invalid();
 const manifest=JSON.parse(bytes.toString('utf8'));
 if(!exact(manifest,['schemaVersion','name','version','files'])||manifest.schemaVersion!==1||manifest.name!=='codebrief-capture-standalone'||manifest.version!==VERSION||!Array.isArray(manifest.files)||manifest.files.length>512)invalid();
 let total=0,previous='';const allowed=new Map();
 for(const file of manifest.files){if(!exact(file,['path','sha256','size'])||!safePath(file.path)||file.path<=previous||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.size)||file.size<0||file.size>LIMIT)invalid();previous=file.path;total+=file.size;if(total>LIMIT)invalid();allowed.set(file.path,file);}
 let count=0;const actual=new Set();
 function walk(dir,relative=''){for(const name of readdirSync(dir)){const path=join(dir,name),rel=relative?`${relative}/${name}`:name;const stat=lstatSync(path);if(stat.isSymbolicLink())invalid();if(stat.isDirectory()){if(![...allowed.keys()].some(p=>p.startsWith(rel+'/')))invalid();walk(path,rel);}else{if(!stat.isFile()||++count>514)invalid();if(rel===MANIFEST)continue;if(rel===RECEIPT){const receipt=JSON.parse(regular(path,512).toString('utf8'));if(!exact(receipt,['schemaVersion','version','manifestSha256'])||receipt.schemaVersion!==1||receipt.version!==VERSION||receipt.manifestSha256!==manifestSha256)invalid();continue;}const expected=allowed.get(rel);if(!expected)invalid();const data=regular(path,LIMIT);if(data.length!==expected.size||hash(data)!==expected.sha256)invalid();actual.add(rel);}}}
 walk(root);if(actual.size!==allowed.size||(requireReceipt&&!lstatSync(join(root,RECEIPT)).isFile()))invalid();return{root,manifest,bytes};
}
/** The caller supplies an independently trusted hash; this function does not establish publication. */
export function verifyCaptureRelease(input){try{verified(input,true);return{version:VERSION,manifestSha256:input.manifestSha256};}catch{invalid();}}

/** Publishes completion metadata last. A partial directory is never a completed installation. */
export function installCaptureRelease({source,manifestSha256,home}) {
 let destination,created=false;
 try {
  const artifact=verified({root:source,manifestSha256});
  if(typeof home!=='string'||!isAbsolute(home))invalid();
  home=resolve(home);ancestors(home);
  let parent=home;
  for(const segment of ['.codebrief','capture','releases']) {
   parent=join(parent,segment);
   try{mkdirSync(parent,{mode:0o700});}catch(error){if(error.code!=='EEXIST')throw error;}
   ancestors(parent);
  }
  destination=join(parent,VERSION);
  try{mkdirSync(destination,{mode:0o700});created=true;}catch(error){
   if(error.code!=='EEXIST')throw error;
   verifyCaptureRelease({root:destination,manifestSha256});
   return{version:VERSION,manifestSha256};
  }
  const identity=directory(destination);
  const check=()=>{ancestors(destination);const now=directory(destination);if(now.dev!==identity.dev||now.ino!==identity.ino)invalid();};
  const directories=new Set([destination]);
  for(const file of artifact.manifest.files) {
   const target=join(destination,...file.path.split('/'));
   let dir=destination;
   for(const segment of file.path.split('/').slice(0,-1)){dir=join(dir,segment);if(!directories.has(dir)){check();mkdirSync(dir,{mode:0o700});directories.add(dir);}directory(dir);}
   check();ancestors(dirname(target));
   const bytes=regular(join(artifact.root,...file.path.split('/')),LIMIT);
   if(bytes.length!==file.size||hash(bytes)!==file.sha256)invalid();
   const fd=openSync(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
   try{writeFileSync(fd,bytes);}finally{closeSync(fd);}
  }
  function exclusive(name,bytes){check();const fd=openSync(join(destination,name),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);try{writeFileSync(fd,bytes);}finally{closeSync(fd);}}
  exclusive(MANIFEST,artifact.bytes);
  verified({root:destination,manifestSha256});
  exclusive(RECEIPT,JSON.stringify({schemaVersion:1,version:VERSION,manifestSha256}));
  return verifyCaptureRelease({root:destination,manifestSha256});
 }catch{
  // Never remove a directory another process might have altered. Completion remains absent.
  throw new Error(created?'capture_installation_incomplete: inspect and remove only the incomplete 0.10.0 installation before retrying':'capture_installation_rejected');
 }
}
