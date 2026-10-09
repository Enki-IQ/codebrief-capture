import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid=()=>{throw new TypeError('room_input_invalid');};
const exact=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).sort().join()!==[...keys].sort().join())invalid();return v;};
const text=(v,max)=>{if(typeof v!=='string'||!v.trim()||!v.isWellFormed()||Buffer.byteLength(v)>max)invalid();return v;};
const uuid=v=>{if(!UUID.test(v??''))invalid();return v;};
const positive=v=>{if(!Number.isSafeInteger(v)||v<1)invalid();};
const bool=v=>{if(typeof v!=='boolean')invalid();};
const nullableUuid=v=>{if(v!==null)uuid(v);};
const date=v=>{if(typeof v!=='string'||!Number.isFinite(Date.parse(v))||v.length>40)invalid();};
const cursor=v=>{if(v!==null&&(typeof v!=='string'||!v||v.length>2000||!/^[A-Za-z0-9_.-]+$/.test(v)))invalid();return v;};
export function readRoomPostInput(file){
 let fd;try{if(typeof file!=='string'||!file)invalid();fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>16384)invalid();const raw=Buffer.alloc(16385);let size=0;while(size<raw.length){const n=readSync(fd,raw,size,raw.length-size,null);if(!n)break;size+=n;}if(size>16384)invalid();const v=exact(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,size))),['operationId','text']);v.operationId=uuid(v.operationId).toLowerCase();text(v.text,8192);return v;}catch{invalid();}finally{if(fd!==undefined)closeSync(fd);}
}
/** Fixed commands use saved session authority. No default provider or generated post ID. */
export function parseRoomCommand(args){
 const [group,operation,...rest]=args;if(group!=='rooms'||!['post','read'].includes(operation)||rest.length%2)invalid();const opts={};
 for(let i=0;i<rest.length;i+=2){const key=rest[i];if(!['--provider','--room',...(operation==='post'?['--input']:['--stream','--cursor'])].includes(key)||Object.hasOwn(opts,key)||!rest[i+1])invalid();opts[key]=rest[i+1];}
 if(!['claude','codex','conductor'].includes(opts['--provider']))invalid();const roomId=uuid(opts['--room']).toLowerCase();
 if(operation==='post')return {operation,roomId,input:readRoomPostInput(opts['--input'])};
 const stream=opts['--stream']??'messages';if(!['messages','events'].includes(stream))invalid();return {operation,roomId,input:{stream,cursor:cursor(opts['--cursor']??null)}};
}
export function validateRoomResponse(command,value){
 if(command.operation==='post'){
 const r=exact(value,['operationId','roomId','messageId','version','sequence','deleted','erased']);if(r.operationId!==command.input.operationId||r.roomId!==command.roomId)invalid();uuid(r.messageId);positive(r.version);positive(r.sequence);bool(r.deleted);bool(r.erased);return r;
 }
 const stream=command.input.stream,r=exact(value,[stream,'nextCursor']);cursor(r.nextCursor);if(!Array.isArray(r[stream])||r[stream].length>20||Buffer.byteLength(JSON.stringify(r))>102400)invalid();let prior=0;
 for(const item of r[stream]){
 uuid(item.id);positive(item.sequence);if(item.sequence<=prior)invalid();prior=item.sequence;date(item.createdAt);
 if(stream==='messages'){
 exact(item,['id','sequence','canErase','author','provenance','text','erased','createdAt']);bool(item.canErase);bool(item.erased);const author=exact(item.author,['userId','label']);text(author.label,255);if(author.userId===null){const p=exact(item.provenance,['kind','originalKind','reason']);if(author.label!=='Deleted member'||p.kind!=='unavailable'||!['human','agent'].includes(p.originalKind)||p.reason!=='author_deleted')invalid();}else{text(author.userId,255);
 if(item.provenance?.kind==='human')exact(item.provenance,['kind']);else{const p=exact(item.provenance,['kind','sessionId','actionId','attemptId','generation','provider','model']);if(p.kind!=='agent')invalid();uuid(p.sessionId);uuid(p.actionId);uuid(p.attemptId);positive(p.generation);text(p.provider,255);if(p.model!==null)text(p.model,255);}
 }
 if(item.text!==null)text(item.text,8192);if(item.erased&&item.text!==null)invalid();
 }else if(item.kind==='handoff'){
 exact(item,['id','sequence','kind','handoffId','evidence','createdAt']);uuid(item.handoffId);if(item.evidence!=='reported')invalid();
 }else{
 exact(item,['id','sequence','kind','requestId','replyId','delivery','requestState','acknowledgedAt','replyCount','erased','createdAt']);if(!['request','reply'].includes(item.kind))invalid();uuid(item.requestId);nullableUuid(item.replyId);text(item.delivery,100);text(item.requestState,100);if(item.acknowledgedAt!==null)date(item.acknowledgedAt);if(!Number.isSafeInteger(item.replyCount)||item.replyCount<0)invalid();bool(item.erased);
 }
 }
 return r;
}
/** A missing/invalid receipt is unconfirmed, with no automatic resend or replacement ID. */
export async function executeRoomCommand(command,transport){try{return validateRoomResponse(command,await transport());}catch{throw new Error(command.operation==='post'?'room_post_unknown':'room_read_unavailable');}}
