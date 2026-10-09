import {NativeRuntimeError,readBoundOwnedThread} from './native-agent-runtime.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const error=code=>new NativeRuntimeError(code);
/** One owned app-server connection. RPC IDs correlate responses; they are not retry keys. */
export async function createNativeTurnAdapter(bound,{spawnServer,timeoutMs=30000}={}){
 if(typeof spawnServer!=='function')throw error('native_integration_unavailable');
 if(!Number.isInteger(timeoutMs)||timeoutMs<100||timeoutMs>60000)throw error('native_scope_invalid');
 // Validate original binding before starting a process or reading any transcript.
 await readBoundOwnedThread(bound,async()=>({thread:{id:bound.threadId,sessionId:bound.sessionId,cwd:bound.cwd,cliVersion:bound.cliVersion}}));
 const child=spawnServer(),pending=new Map(),listeners=new Set(),notifications=[],completedItems=new Map();
 let nextId=1,buffer='',bytes=0,closed=false,current=null;
 const attempted=new Set();
 const rejectAll=()=>{closed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(error('native_unavailable'));}pending.clear();for(const listener of listeners)listener(null);};
 const write=value=>{if(closed)throw error('native_unavailable');child.stdin.write(JSON.stringify(value)+'\n');};
 const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=nextId++,timer=setTimeout(()=>{pending.delete(id);reject(error('native_unavailable'));},timeoutMs);pending.set(id,{resolve,reject,timer});try{write({jsonrpc:'2.0',id,method,params});}catch{clearTimeout(timer);pending.delete(id);reject(error('native_unavailable'));}});
 child.on('error',rejectAll);child.on('exit',rejectAll);
 child.stdout.on('data',chunk=>{
  bytes+=chunk.length;if(bytes>2000000){rejectAll();child.kill();return;}buffer+=chunk.toString('utf8');
  for(let nl;(nl=buffer.indexOf('\n'))>=0;){const line=buffer.slice(0,nl);buffer=buffer.slice(nl+1);let value;try{value=JSON.parse(line);}catch{rejectAll();child.kill();return;}
   if(value.method&&value.id!==undefined){try{write({jsonrpc:'2.0',id:value.id,error:{code:-32000,message:'local_approval_required'}});}catch{}rejectAll();child.kill();return;}
   const item=pending.get(value.id);if(item){pending.delete(value.id);clearTimeout(item.timer);value.error?item.reject(error('native_rejected')):item.resolve(value.result);continue;}
   if(value.method==='item/completed'&&current&&value.params?.threadId===bound.threadId){const p=value.params,item=p.item;if(UUID.test(p.turnId??'')&&typeof item?.id==='string'&&item.id.length>0&&item.id.length<=255&&Number.isSafeInteger(p.completedAtMs)&&p.completedAtMs>=0){const key=p.turnId+':'+item.id;if(completedItems.size>=64&&!completedItems.has(key)){rejectAll();child.kill();return;}const previous=completedItems.get(key);if(previous&&JSON.stringify(previous)!==JSON.stringify(item)){rejectAll();child.kill();return;}completedItems.set(key,item);}}
   if(value.method==='turn/completed'){if(notifications.length>=64){rejectAll();child.kill();return;}notifications.push(value.params);for(const listener of listeners)listener(value.params);}
  }
 });
 const close=()=>{rejectAll();child.kill();};
 try{
  await rpc('initialize',{clientInfo:{name:'codebrief',version:'0.10.2'},capabilities:{experimentalApi:false}});write({jsonrpc:'2.0',method:'initialized'});
  await readBoundOwnedThread(bound,rpc);
  const resumed=await rpc('thread/resume',{threadId:bound.threadId});
  await readBoundOwnedThread(bound,async()=>({thread:resumed?.thread}));
  if(resumed.cwd!==bound.cwd||resumed.model!==bound.model||resumed.modelProvider!==bound.modelProvider||resumed.approvalPolicy!=='on-request'||resumed.sandbox?.type!=='readOnly'||resumed.sandbox.networkAccess!==false)throw error('native_receipt_invalid');
 }catch(e){close();throw e instanceof NativeRuntimeError?e:error('native_unavailable');}
 function terminal(turnId){return new Promise(resolve=>{
  let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);listeners.delete(receive);resolve(value);};
  const receive=value=>{if(value===null)return finish(null);if(value?.threadId===bound.threadId&&value.turn?.id===turnId&&['completed','failed','interrupted'].includes(value.turn.status))finish(value.turn);};
  const timer=setTimeout(()=>finish(null),timeoutMs);listeners.add(receive);for(const value of notifications)receive(value);if(closed)finish(null);
 });}
 async function stop(){if(!current)return{state:'stopped_unknown'};current.stopRequested=true;if(!current.turnId)return{state:'stopped_unknown'};try{await rpc('turn/interrupt',{threadId:bound.threadId,turnId:current.turnId});return{state:'stop_requested'};}catch{return{state:'stopped_unknown'};}}
 async function run({effectId,issue,persist,report,reply}){
  if(attempted.has(effectId))throw error('native_effect_already_issued');
  if(current)throw error('native_effect_unresolved');
  if(!UUID.test(effectId??''))throw error('native_scope_invalid');
  attempted.add(effectId);current={effectId,turnId:null,stopRequested:false};let issued=false,terminalState=null;
  const metadata=state=>({effectId,threadId:bound.threadId,turnId:current.turnId,state});
  try{
   const disclosure=await issue();issued=true;
   if(typeof disclosure?.text!=='string'||disclosure.text.length===0||disclosure.text.length>8000||!UUID.test(disclosure.replyId??''))throw error('native_receipt_invalid');
   // Persist only source-free original identity before the sole turn/start write.
   await persist(metadata('issued_unknown'));
   // Disclosure is fenced already; a latched Stop must never submit a fresh turn.
   if(current.stopRequested)return{state:'issued_unknown'};
   const admitted=await rpc('turn/start',{threadId:bound.threadId,input:[{type:'text',text:disclosure.text}],approvalPolicy:'on-request',sandboxPolicy:{type:'readOnly',networkAccess:false}});
   if(!UUID.test(admitted?.turn?.id??'')||admitted.turn.status!=='inProgress')throw error('native_receipt_invalid');
   current.turnId=admitted.turn.id;if(current.stopRequested)await stop();await persist(metadata('running'));await report(metadata('running'));
   const outcome=await terminal(current.turnId);if(!outcome)return{state:'issued_unknown'};
   const state=outcome.status==='interrupted'?'stopped':outcome.status==='failed'?'failed':'completed';terminalState=state;await persist(metadata(state));await report(metadata(state));
   if(state==='completed'){
    if(!['full','summary','notLoaded'].includes(outcome.itemsView)||!Array.isArray(outcome.items))throw error('native_receipt_invalid');
    const items=outcome.itemsView==='full'?outcome.items:[...completedItems].filter(([key])=>key.startsWith(current.turnId+':')).map(([,item])=>item);
    const messages=items.filter(item=>item?.type==='agentMessage'&&(outcome.itemsView==='full'?item.phase!=='commentary':item.phase==='final_answer'));const text=messages.map(item=>item.text).join('\n');
    if(messages.some(item=>typeof item.text!=='string')||!text||text.length>8000)throw error('native_receipt_invalid');
    const receipt=await reply({effectId,replyId:disclosure.replyId,text});if(receipt?.replyId!==disclosure.replyId)throw error('native_receipt_invalid');
   }
   return{state,turnId:current.turnId};
  }catch{return terminalState?{state:terminalState,turnId:current.turnId,replyState:terminalState==='completed'?'unknown':'unavailable'}:{state:issued?'issued_unknown':'not_issued'};}finally{if(terminalState||!issued){current=null;completedItems.clear();}}
 }
 async function reconcileStop({effectId,threadId,turnId}){
  if(!UUID.test(effectId??'')||threadId!==bound.threadId||(turnId!==null&&!UUID.test(turnId??'')))throw error('native_scope_invalid');
  if(current&&(current.effectId!==effectId||current.turnId!==turnId))throw error('native_effect_unresolved');
  attempted.add(effectId);current??={effectId,turnId,stopRequested:true};
  return stop();
 }
 return{run,stop,reconcileStop,close};
}
