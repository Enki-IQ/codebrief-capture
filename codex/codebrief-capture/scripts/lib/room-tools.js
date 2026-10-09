import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOOLS=['read_file','glob','grep','get_symbol','find_references','read_principles','read_cached_drift','run_drift'];
const invalid=()=>{throw new TypeError('room_tool_input_invalid');};
function exact(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())invalid();return v;}
function text(v,max){if(typeof v!=='string'||!v.trim()||!v.isWellFormed()||Buffer.byteLength(v)>max||/[\u0000-\u001f\u007f]/.test(v))invalid();}
function path(v){text(v,512);if(v.startsWith('/')||v.includes('\\')||v.split('/').some(p=>!p||p==='.'||p==='..')||/^[a-z]:/i.test(v))invalid();}
export function validateRoomToolInput(v){
 if(!['invoke','read','erase'].includes(v?.operation))invalid();exact(v,v.operation==='invoke'?['operation','roomId','input']:['operation','roomId','operationId']);if(!UUID.test(v.roomId))invalid();
 if(v.operation!=='invoke'){if(!UUID.test(v.operationId))invalid();return v;}
 const i=exact(v.input,['operationId','toolId','args']);if(!UUID.test(i.operationId)||!TOOLS.includes(i.toolId))invalid();const a=i.args;
 switch(i.toolId){
 case 'read_file':exact(a,['path','start','end']);path(a.path);if(!Number.isSafeInteger(a.start)||a.start<1||!Number.isSafeInteger(a.end)||a.end<a.start||a.end-a.start>=200)invalid();break;
 case 'glob':case 'grep':exact(a,['pattern']);text(a.pattern,128);break;
 case 'get_symbol':exact(a,['name']);text(a.name,128);break;
 case 'find_references':exact(a,['path']);path(a.path);break;
 case 'read_principles':exact(a,Object.hasOwn(a??{},'declarationId')?['declarationId']:[]);if(Object.hasOwn(a,'declarationId')&&!UUID.test(a.declarationId))invalid();break;
 case 'read_cached_drift':exact(a,['declarationId']);if(!UUID.test(a.declarationId))invalid();break;
 case 'run_drift':exact(a,['declarationId','confirmModel']);if(!UUID.test(a.declarationId)||a.confirmModel!==true)invalid();break;
 }
 return v;
}
/** One bounded descriptor; arguments never become a result file or outbox. */
export function readRoomToolInput(file){
 let fd;try{if(typeof file!=='string'||!file)invalid();fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>8192)invalid();const raw=Buffer.alloc(8193);let size=0;while(size<raw.length){const n=readSync(fd,raw,size,raw.length-size,null);if(!n)break;size+=n;}if(size>8192)invalid();return validateRoomToolInput(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,size))));}catch{invalid();}finally{if(fd!==undefined)closeSync(fd);}
}
