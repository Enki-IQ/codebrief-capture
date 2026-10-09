import {randomBytes,randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {verifyCaptureRelease} from './release-installation.js';
import {withPrivateStateDirectory,withPrivateStateLock,readPrivateStateJson,writePrivateStateJson,withSubmissionLock} from './handoff-state.js';
import {inspectScope,inspectReviewRevision} from './tandem-scope.js';
const UUID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const PROVIDER=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;
const ORIGIN='https://app.codebrief.ai';
const ORIGINS=new Set([ORIGIN]);
function origin(value=ORIGIN){if(!ORIGINS.has(value))throw new Error('Invalid bounded launch origin');return value;}
export function validateBootstrapExchangeResponse(response,launchId){
 const exact=(row,keys)=>row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).sort().join()===keys.sort().join();
 const claim=response?.claim,identity=response?.identity;
 if(!exact(response,['launchId','instanceId','credential','claim','identity'])||response.launchId!==launchId||!UUID.test(response.instanceId)||!exact(identity,['accountId','orgId','repoId'])||Object.values(identity).some(value=>!UUID.test(value))||typeof response.credential!=='string'||!new RegExp(`^${identity.orgId}\\.[A-Za-z0-9_-]{43}$`).test(response.credential)||!exact(claim,['attemptId','handoffId','actionId','actionVersion','instanceId','generation','version','leaseExpiresAt'])||['attemptId','handoffId','actionId','instanceId'].some(key=>!UUID.test(claim[key]))||claim.instanceId!==response.instanceId||['actionVersion','generation','version'].some(key=>!Number.isSafeInteger(claim[key])||claim[key]<1)||typeof claim.leaseExpiresAt!=='string'||!Number.isFinite(Date.parse(claim.leaseExpiresAt)))throw new Error('Invalid scoped exchange response');
 return response;
}
async function request(url,payload,credential,fetchImpl=fetch){
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
 try{const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:controller.signal,headers:{'content-type':'application/json',...(credential?{authorization:`Bearer ${credential}`}:{})},body:JSON.stringify(payload)});
 if(!response.ok){const error=new Error(`Launch Capture request failed (${response.status})`);error.status=response.status;throw error;}
 const reader=response.body?.getReader();if(!reader)throw new Error('Invalid launch response');let size=0;const chunks=[];
 try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072){void reader.cancel();throw new Error('Launch response too large');}chunks.push(value);}return JSON.parse(Buffer.concat(chunks).toString('utf8'));}finally{reader.releaseLock();}
 }finally{clearTimeout(timer);}
}
async function post(launchId,operation,payload,credential,fetchImpl=fetch,apiOrigin=ORIGIN){
 if(!UUID.test(launchId))throw new Error('Invalid launch identity');
 return request(`${origin(apiOrigin)}/api/conductor/launches/${launchId}/${operation}`,payload,credential,fetchImpl);
}
/** Setup can begin before the provider create receipt. Polling never renews authority. */
export async function resolveConductorBootstrap({env=process.env,fetchImpl=fetch,now=()=>Date.now(),wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}){
 const launchId=env.CODEBRIEF_LAUNCH_ID,baseSha=env.CODEBRIEF_EXPECTED_SHA,token=env.CODEBRIEF_BOOTSTRAP_TOKEN,apiOrigin=origin(env.CODEBRIEF_API_ORIGIN);
 if(!ORIGINS.has(env.CODEBRIEF_API_ORIGIN)||!UUID.test(launchId)||!/^[a-f0-9]{40}$/.test(baseSha)||!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token))throw new Error('Invalid bounded launch bootstrap configuration');
 const deadline=now()+60000;let expiry;
 while(true){
  const value=await request(`${apiOrigin}/api/conductor/bootstrap/resolve`,{token},null,fetchImpl);
  const keys=value?.state==='pending'?['state','expiresAt']:['state','expiresAt','launchId','attemptId','baseSha','workspaceId','sessionId'];
  if(!value||Object.keys(value).sort().join()!==keys.sort().join()||!['pending','bound'].includes(value.state)||typeof value.expiresAt!=='string'||!Number.isFinite(Date.parse(value.expiresAt)))throw new Error('Invalid bootstrap resolution');
  const expires=Date.parse(value.expiresAt);
  if(expires<=now()||(expiry!==undefined&&expires!==expiry))throw new Error('Bootstrap authority expired or changed');
  expiry=expires;
  if(value.state==='bound'){
   if(value.launchId!==launchId||value.baseSha!==baseSha||!UUID.test(value.attemptId)||!PROVIDER.test(value.workspaceId)||!PROVIDER.test(value.sessionId))throw new Error('Invalid exact bootstrap binding');
   return value;
  }
  if(now()+1000>=Math.min(deadline,expiry))throw new Error('Bootstrap pending: retry Setup before original token expiry');
  await wait(1000);
 }
}
export async function launchRelayRequest({session,operation,payload,fetchImpl}){
 if(operation==='register'&&payload?.verify){operation='verify';payload={...payload.verify,workspaceId:session.workspaceId};}
 else if(operation==='review'&&payload?.phase==='submit'){payload={receipt:payload.receipt,mutation:payload.mutation};}
 else if(operation==='recover'&&payload?.disposition!=='resume')throw new Error('Launch-bound recovery can only resume this workspace. Replacement requires a separately authorized new launch.');
 else if(!['renew','return','review','recover','inbox','request','ack','reply','room_tool','room_post','room_read'].includes(operation))throw new Error('Unsupported command for launch-bound Capture; use explicit bootstrap, heartbeat, checkpoint, return or review submit.');
 return post(session.launchId,'relay',{operation,payload},session.credential,fetchImpl,session.apiOrigin);
}
function privateState(id,options,fn){return withPrivateStateDirectory('conductor/bootstrap',options,{create:true},({directoryPath,verify})=>withPrivateStateLock(directoryPath,verify,()=>fn({load:()=>readPrivateStateJson(join(directoryPath,`${id}.json`),verify),save:value=>writePrivateStateJson(join(directoryPath,`${id}.json`),value,verify)})));}
/** No secret is accepted in command arguments or returned to stdout. Exact envelope survives lost responses. */
export async function bootstrapConductorCapture({workspaceId,sessionId,root=process.cwd(),releaseRoot=fileURLToPath(new URL('../../',import.meta.url)),options,env=process.env,fetchImpl=fetch,now=()=>Date.now(),inspect=inspectScope,install}){
 // The reviewed Setup pin is independent of the local completion receipt.
 verifyCaptureRelease({root:releaseRoot,manifestSha256:env.CODEBRIEF_CAPTURE_RELEASE_MANIFEST_SHA256});
 const launchId=env.CODEBRIEF_LAUNCH_ID,expectedSha=env.CODEBRIEF_EXPECTED_SHA,token=env.CODEBRIEF_BOOTSTRAP_TOKEN;
 if(!ORIGINS.has(env.CODEBRIEF_API_ORIGIN)||!UUID.test(launchId)||!/^[a-f0-9]{40}$/.test(expectedSha)||!/^[a-f0-9-]{36}\.[A-Za-z0-9_-]{43}$/.test(token)||(workspaceId===undefined)!==(sessionId===undefined)||(workspaceId!==undefined&&(!PROVIDER.test(workspaceId)||!PROVIDER.test(sessionId))))throw new Error('Invalid bounded launch bootstrap configuration');
 const head=()=>execFileSync('git',['-C',root,'rev-parse','--verify','HEAD^{commit}'],{encoding:'utf8',env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_COUNT:'0'}}).trim();
 if(head()!==expectedSha)throw new Error('base_revision_mismatch');
 const apiOrigin=origin(env.CODEBRIEF_API_ORIGIN);
 let expectedAttempt,expires;const startedDeadline=now()+60000;
 if(workspaceId===undefined){const bound=await resolveConductorBootstrap({env,fetchImpl,now});workspaceId=bound.workspaceId;sessionId=bound.sessionId;expectedAttempt=bound.attemptId;expires=Date.parse(bound.expiresAt);}
 const deadline=Math.min(startedDeadline,expires??Infinity);
 return withSubmissionLock(launchId,async()=>{
  let local=privateState(launchId,options,s=>s.load());
  const envelope={token,workspaceId,sessionId,nonce:local?.envelope?.nonce??randomBytes(32).toString('base64url')};
  if(local&&JSON.stringify(local.envelope)!==JSON.stringify(envelope))throw new Error('Bootstrap is already bound to another exact exchange');
  if(!local){local={envelope};privateState(launchId,options,s=>s.save(local));}
  while(!local.response){if(expires!==undefined&&now()>=expires)throw new Error('Bootstrap authority expired');try{local={...local,response:await post(launchId,'exchange',envelope,null,fetchImpl,apiOrigin)};privateState(launchId,options,s=>s.save(local));}catch(error){if(![0,503,undefined].includes(error.status)||now()+1000>=deadline)throw error;await new Promise(resolve=>setTimeout(resolve,1000));}}
  const response=validateBootstrapExchangeResponse(local.response,launchId);
  if(expectedAttempt&&response.claim.attemptId!==expectedAttempt)throw new Error('Invalid exact bootstrap attempt');
  const setup=await post(launchId,'relay',{operation:'setup',payload:{}},response.credential,fetchImpl,apiOrigin);
  if(!Array.isArray(setup.plannedFiles)||!setup.plannedFiles.length)throw new Error('Launch requires frozen planned files');
  const scope=setup.plannedFiles.map(path=>({kind:'file',path})),inspection=await inspect(root,expectedSha,scope);
  if(inspection.headSha!==expectedSha||inspection.violations.length||(setup.purpose==='review'&&!inspection.clean))throw new Error('Launch worktree preflight failed');
  if(setup.purpose==='review'){const {validateAuthorReceipt}=await import('./tandem-client.js');const revision=validateAuthorReceipt(setup.authorReceipt);if(revision.headSha!==expectedSha||revision.authorInstanceId===response.instanceId)throw new Error('Invalid isolated author revision');await inspectReviewRevision(root,revision);}
  if(setup.purpose==='implement'){
   if(!local.pendingScope&&!local.scopeClaim){local={...local,pendingScope:{claim:response.claim,mutation:{requestId:randomUUID(),expectedVersion:response.claim.version,generation:response.claim.generation},canonicalScope:scope}};privateState(launchId,options,s=>s.save(local));}
   if(local.pendingScope){const scoped=await post(launchId,'relay',{operation:'scope',payload:local.pendingScope},response.credential,fetchImpl,apiOrigin);local={...local,scopeClaim:scoped.claim};delete local.pendingScope;privateState(launchId,options,s=>s.save(local));}
  }
  const candidates=[setup.claim,local.scopeClaim,response.claim].filter(Boolean);
  for(const candidate of candidates){validateBootstrapExchangeResponse({...response,claim:candidate},launchId);if(['attemptId','instanceId','handoffId','actionId','actionVersion'].some(key=>candidate[key]!==response.claim[key]))throw new Error('Invalid scoped Capture claim');}
  const claim=candidates.reduce((latest,candidate)=>candidate.generation>latest.generation||(candidate.generation===latest.generation&&candidate.version>latest.version)?candidate:latest);
  const installed=JSON.parse(readFileSync(new URL("../../package.json",import.meta.url),"utf8"));
  if(!["codebrief-capture","codebrief-capture-codex"].includes(installed.name)||installed.version!=='0.10.2')throw new Error("Capture version does not support launch preflight");
  if(head()!==expectedSha)throw new Error('base_revision_mismatch');
  const installer=install??(await import('./tandem-client.js')).installConductorSession;
  const installedSession=installer(root,{...response,claim,launchId,workspaceId,sessionId,apiOrigin,canonicalScope:scope,reviewRevision:setup.authorReceipt},options);
  if(installedSession?.pendingRenewal||installedSession?.pendingRecovery)throw new Error("Resolve pending Capture mutation before rerunning preflight");
  const readyClaim=installedSession?.claim??claim;
  await post(launchId,'ready',{claim:readyClaim,workspaceId,sessionId,headSha:expectedSha,captureVersion:installed.version,clean:inspection.clean},response.credential,fetchImpl,apiOrigin);
  return {ready:true,launchId,attemptId:claim.attemptId};
 },options);
}
