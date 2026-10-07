import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {withPrivateStateDirectory,withPrivateStateLock,readPrivateStateJson,writePrivateStateJson,withSubmissionLock} from './handoff-state.js';
import {inspectScope,inspectReviewRevision} from './tandem-scope.js';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const ORIGIN='https://app.codebrief.ai';
export function validateBootstrapExchangeResponse(response,launchId){
 const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join()===keys.sort().join();
 const claim=response?.claim,identity=response?.identity;
 if(!exact(response,['launchId','instanceId','credential','claim','identity'])||response.launchId!==launchId||!UUID.test(response.instanceId)||!exact(identity,['accountId','orgId','repoId'])||Object.values(identity).some(value=>!UUID.test(value))||typeof response.credential!=='string'||!new RegExp(`^${identity.orgId}\\.[A-Za-z0-9_-]{43}$`).test(response.credential)||!exact(claim,['attemptId','handoffId','actionId','actionVersion','instanceId','generation','version','leaseExpiresAt'])||['attemptId','handoffId','actionId','instanceId'].some(key=>!UUID.test(claim[key]))||claim.instanceId!==response.instanceId||['actionVersion','generation','version'].some(key=>!Number.isSafeInteger(claim[key])||claim[key]<1)||typeof claim.leaseExpiresAt!=='string'||!Number.isFinite(Date.parse(claim.leaseExpiresAt)))throw new Error('Invalid scoped exchange response');
 return response;
}
async function post(launchId,operation,payload,credential,fetchImpl=fetch){
 if(!UUID.test(launchId))throw new Error('Invalid launch identity');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetchImpl(`${ORIGIN}/api/conductor/launches/${launchId}/${operation}`,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(payload)});
 if(!response.ok){const error=new Error(`Launch Capture request failed (${response.status})`);error.status=response.status;throw error;}
 const reader=response.body?.getReader();if(!reader)throw new Error('Invalid launch response');let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){void reader.cancel();throw new Error('Launch response too large');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}
 }finally{clearTimeout(timer);}
}
export async function launchRelayRequest({session,operation,payload,fetchImpl}){
 if(operation==='register'&&payload?.verify){operation='verify';payload={...payload.verify,workspaceId:session.workspaceId};}
 else if(operation==='review'&&payload?.phase==='submit'){payload={receipt:payload.receipt,mutation:payload.mutation};}
 else if(operation==='recover'&&payload?.disposition!=='resume')throw new Error('Launch-bound recovery can only resume this workspace. Replacement requires a separately authorized new launch.');
 else if(!['renew','return','review','recover','inbox','request','ack','reply'].includes(operation))throw new Error('Unsupported command for launch-bound Capture; use explicit bootstrap, heartbeat, checkpoint, return or review submit.');
 return post(session.launchId,'relay',{operation,payload},session.credential,fetchImpl);
}
function privateState(id,options,fn){return withPrivateStateDirectory('conductor/bootstrap',options,{create:true},({directoryPath,verify})=>withPrivateStateLock(directoryPath,verify,()=>fn({load:()=>readPrivateStateJson(join(directoryPath,`${id}.json`),verify),save:value=>writePrivateStateJson(join(directoryPath,`${id}.json`),value,verify)})));}
/** No secret is accepted in command arguments or returned to stdout. Exact envelope survives lost responses. */
export async function bootstrapConductorCapture({workspaceId,sessionId,root=process.cwd(),options,env=process.env,fetchImpl=fetch,now=()=>Date.now(),inspect=inspectScope,install}){
 const launchId=env.CODEBRIEF_LAUNCH_ID,expectedSha=env.CODEBRIEF_EXPECTED_SHA,token=env.CODEBRIEF_BOOTSTRAP_TOKEN;
 if(env.CODEBRIEF_API_ORIGIN!==ORIGIN||!UUID.test(launchId)||!/^[a-f0-9]{40}$/.test(expectedSha)||!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)||!PROVIDER.test(workspaceId)||!PROVIDER.test(sessionId))throw new Error('Invalid bounded launch bootstrap configuration');
 const head=()=>execFileSync('git',['-C',root,'rev-parse','--verify','HEAD^{commit}'],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'}}).trim();
 if(head()!==expectedSha)throw new Error('base_revision_mismatch');
 const deadline=now()+60000;
 return withSubmissionLock(launchId,async()=>{
  let local=privateState(launchId,options,s=>s.load());
  const envelope={token,workspaceId,sessionId,nonce:local?.envelope?.nonce??randomBytes(32).toString('base64url')};
  if(local&&JSON.stringify(local.envelope)!==JSON.stringify(envelope))throw new Error('Bootstrap is already bound to another exact exchange');
  if(!local){local={envelope};privateState(launchId,options,s=>s.save(local));}
  while(!local.response){try{local={...local,response:await post(launchId,'exchange',envelope,null,fetchImpl)};privateState(launchId,options,s=>s.save(local));}catch(error){if(![0,503,undefined].includes(error.status)||now()+1000>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}
  const response=validateBootstrapExchangeResponse(local.response,launchId);
  const setup=await post(launchId,'relay',{operation:'setup',payload:{}},response.credential,fetchImpl);
  if(!Array.isArray(setup.plannedFiles)||!setup.plannedFiles.length)throw new Error('Launch requires frozen planned files');
  const scope=setup.plannedFiles.map(path=>({kind:'file',path})),inspection=await inspect(root,expectedSha,scope);
  if(inspection.headSha!==expectedSha||inspection.violations.length||(setup.purpose==='review'&&!inspection.clean))throw new Error('Launch worktree preflight failed');
  if(setup.purpose==='review'){const {validateAuthorReceipt}=await import('./tandem-client.js');const revision=validateAuthorReceipt(setup.authorReceipt);if(revision.headSha!==expectedSha||revision.authorInstanceId===response.instanceId)throw new Error('Invalid isolated author revision');await inspectReviewRevision(root,revision);}
  if(setup.purpose==='implement'){
   if(!local.pendingScope&&!local.scopeClaim){local={...local,pendingScope:{claim:response.claim,mutation:{requestId:randomUUID(),expectedVersion:response.claim.version,generation:response.claim.generation},canonicalScope:scope}};privateState(launchId,options,s=>s.save(local));}
   if(local.pendingScope){const scoped=await post(launchId,'relay',{operation:'scope',payload:local.pendingScope},response.credential,fetchImpl);local={...local,scopeClaim:scoped.claim};delete local.pendingScope;privateState(launchId,options,s=>s.save(local));}
  }
  const candidates=[setup.claim,local.scopeClaim,response.claim].filter(Boolean);
  for(const candidate of candidates){validateBootstrapExchangeResponse({...response,claim:candidate},launchId);if(['attemptId','instanceId','handoffId','actionId','actionVersion'].some(key=>candidate[key]!==response.claim[key]))throw new Error('Invalid scoped Capture claim');}
  const claim=candidates.reduce((latest,candidate)=>candidate.generation>latest.generation||(candidate.generation===latest.generation&&candidate.version>latest.version)?candidate:latest);
  const installed=JSON.parse(readFileSync(new URL("../../package.json",import.meta.url),"utf8"));
  if(!["codebrief-capture","codebrief-capture-codex"].includes(installed.name)||!/^0\.(?:9|[1-9]\d+)\.\d+$/.test(installed.version))throw new Error("Capture version does not support launch preflight");
  if(head()!==expectedSha)throw new Error('base_revision_mismatch');
  const installer=install??(await import('./tandem-client.js')).installConductorSession;
  const installedSession=installer(root,{...response,claim,launchId,workspaceId,sessionId,canonicalScope:scope,reviewRevision:setup.authorReceipt},options);
  if(installedSession?.pendingRenewal||installedSession?.pendingRecovery)throw new Error("Resolve pending Capture mutation before rerunning preflight");
  const readyClaim=installedSession?.claim??claim;
  await post(launchId,'ready',{claim:readyClaim,workspaceId,sessionId,headSha:expectedSha,captureVersion:installed.version,clean:inspection.clean},response.credential,fetchImpl);
  return {ready:true,launchId,attemptId:claim.attemptId};
 },options);
}
