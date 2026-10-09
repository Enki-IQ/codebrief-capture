import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createBoundOwnedThread,readBoundOwnedThread} from './native-agent-runtime.js';
const cwd='/private/tmp/codebrief-owned-worktree';
const thread={id:'019d1234-1111-7111-8111-111111111111',sessionId:'019d1234-2222-7222-8222-222222222222',cwd,cliVersion:'0.145.0'};
const response={thread,cwd,model:'gpt-6.1',modelProvider:'openai',approvalPolicy:'on-request',sandbox:{type:'readOnly',networkAccess:false}};
test('creates exact scoped read-only owned thread and retains actual identity',async()=>{
 const calls=[];const actual=await createBoundOwnedThread({cwd},async(method,params)=>{calls.push({method,params});return response;});
 assert.deepEqual(calls,[{method:'thread/start',params:{cwd,sandbox:'read-only',approvalPolicy:'on-request'}}]);
 assert.deepEqual(actual,{threadId:thread.id,sessionId:thread.sessionId,cwd,cliVersion:'0.145.0',model:'gpt-6.1',modelProvider:'openai'});
});
test('rejects foreign cwd/version/identity without returning provider payload',async()=>{
 for(const bad of [{...response,cwd:'/wrong'},{...response,thread:{...thread,cwd:'/wrong'}},{...response,thread:{...thread,cliVersion:'0.144.0'}},{...response,thread:{...thread,id:'invented'}},{...response,sandbox:{type:'dangerFullAccess'}}])await assert.rejects(createBoundOwnedThread({cwd},async()=>bad),{code:'native_receipt_invalid'});
});
test('exact thread read validates original immutable binding and never starts another',async()=>{
 const bound=await createBoundOwnedThread({cwd},async()=>response),calls=[];
 await readBoundOwnedThread(bound,async(method,params)=>{calls.push({method,params});return {thread};});
 assert.deepEqual(calls,[{method:'thread/read',params:{threadId:thread.id,includeTurns:false}}]);
 await assert.rejects(readBoundOwnedThread(bound,async()=>({thread:{...thread,sessionId:'019d1234-3333-7333-8333-333333333333'}})),{code:'native_receipt_invalid'});
});

test('validates stored binding before any RPC and bounds model metadata',async()=>{
 const bound=await createBoundOwnedThread({cwd},async()=>response);
 for(const bad of [{...bound,extra:true},{...bound,cwd:'/tmp/../wrong'},{...bound,model:'x'.repeat(129)},{...bound,modelProvider:'openai\n'}]) {
  let calls=0; await assert.rejects(readBoundOwnedThread(bad,async()=>{calls++;return {thread};}),{code:'native_scope_invalid'}); assert.equal(calls,0);
 }
 for(const model of ['x'.repeat(129),'gpt\n']) await assert.rejects(createBoundOwnedThread({cwd},async()=>({...response,model})),{code:'native_receipt_invalid'});
 const version4={...thread,id:'12345678-1111-4111-8111-111111111111',sessionId:'12345678-2222-4222-8222-222222222222'};
 assert.equal((await createBoundOwnedThread({cwd},async()=>({...response,thread:version4}))).threadId,version4.id);
});
