import {openSync,fstatSync,readSync,closeSync,constants} from 'node:fs';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export class AgentInboxError extends Error{constructor(){super('agent_request_unavailable');this.code='agent_request_unavailable';}}
export function validateAgentMessageInput(operation,value){
 const keys=operation==='request'?['requestId','actionId','recipientSessionId','expectedRecipientGeneration','text','parentRequestId']:operation==='ack'?['requestId','digest']:operation==='reply'?['requestId','replyId','digest','text']:null;
 if(!keys||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join()!==keys.sort().join())throw new AgentInboxError();
 for(const key of ['requestId','actionId','recipientSessionId','replyId'])if(Object.hasOwn(value,key)&&!UUID.test(value[key]))throw new AgentInboxError();
 if(Object.hasOwn(value,'parentRequestId')&&value.parentRequestId!==null&&!UUID.test(value.parentRequestId))throw new AgentInboxError();
 if(Object.hasOwn(value,'expectedRecipientGeneration')&&(!Number.isSafeInteger(value.expectedRecipientGeneration)||value.expectedRecipientGeneration<1))throw new AgentInboxError();
 if(Object.hasOwn(value,'digest')&&!/^[a-f0-9]{64}$/.test(value.digest))throw new AgentInboxError();
 if(Object.hasOwn(value,'text')&&(typeof value.text!=='string'||!value.text.trim()||!value.text.isWellFormed()||[...value.text].length>8000||Buffer.byteLength(value.text)>32768))throw new AgentInboxError();return value;
}
export function readAgentMessageInput(operation,path){
 let fd;
 try{
  if(typeof path!=='string'||!path)throw new AgentInboxError();
  fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=fstatSync(fd);if(!stat.isFile()||stat.size>49152)throw new AgentInboxError();
  // One descriptor binds validation and reads to the same inode. Read at most
  // the limit plus one even if the file grows after fstat.
  const raw=Buffer.alloc(49153);let size=0;
  while(size<raw.length){const count=readSync(fd,raw,size,raw.length-size,null);if(!count)break;size+=count;}
  if(size>49152)throw new AgentInboxError();
  return validateAgentMessageInput(operation,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw.subarray(0,size))));
 }catch{throw new AgentInboxError();}finally{if(fd!==undefined)closeSync(fd);}
}
