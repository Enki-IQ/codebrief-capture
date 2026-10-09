import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {validateRoomResponse} from './room-discussion.js';
import {validateRoomToolResponse} from './room-tools.js';
const message=()=>({id:randomUUID(),sequence:1,canErase:false,author:{userId:null,label:'Deleted member'},provenance:{kind:'unavailable',originalKind:'agent',reason:'author_deleted'},text:'Retained discussion',erased:false,createdAt:'2026-10-08T00:00:00Z'});
const read=m=>validateRoomResponse({operation:'read',input:{stream:'messages'}},{messages:[m],nextCursor:null});
test('deleted human and agent messages preserve explicitly unavailable provenance',()=>{for(const kind of ['human','agent']){const m=message();m.provenance.originalKind=kind;assert.equal(read(m).messages[0].provenance.originalKind,kind);}});
test('deleted message identity and provenance must be an exact pair',()=>{for(const mutate of [m=>m.author.label='Alice',m=>m.author.userId='live-user',m=>m.provenance.reason='unknown',m=>m.provenance.originalKind='coding_agent',m=>m.provenance.sessionId=randomUUID(),m=>m.provenance={kind:'human'},m=>m.provenance={kind:'agent'}]){const m=message();mutate(m);assert.throws(()=>read(m));}});
const actor=()=>({kind:'unavailable',originalKind:'coding_agent',userId:null,sessionId:null,projectId:null,actionId:null,attemptId:null,generation:null,provenance:null});
test('deleted tool actors retain original kind with no fabricated identity',()=>{for(const kind of ['human','coding_agent']){const a=actor();a.originalKind=kind;assert.equal(validateRoomToolResponse({invocation:{actor:a}}).invocation.actor.originalKind,kind);}});
test('tool unavailable provenance rejects partial identities, wrong kinds and extra fields',()=>{for(const mutate of [a=>a.userId='live-user',a=>a.sessionId=randomUUID(),a=>a.generation=1,a=>a.provenance={provider:'claude'},a=>a.originalKind='agent',a=>delete a.originalKind,a=>a.reason='author_deleted',a=>a.kind='human']){const a=actor();mutate(a);assert.throws(()=>validateRoomToolResponse({invocation:{actor:a}}));}});
test('live messages and tool actors keep their original strict identity requirements',()=>{
 const m=message();m.author={userId:'current-user',label:'Current member'};m.provenance={kind:'agent',sessionId:randomUUID(),actionId:randomUUID(),attemptId:randomUUID(),generation:1,provider:'codex',model:null};assert.equal(read(m).messages[0].provenance.kind,'agent');m.author.userId=null;assert.throws(()=>read(m));
 const a={kind:'coding_agent',userId:'current-user',sessionId:randomUUID(),projectId:randomUUID(),actionId:randomUUID(),attemptId:randomUUID(),generation:1,provenance:{provider:'claude',model:null,runtimeId:null}};assert.equal(validateRoomToolResponse({invocation:{actor:a}}).invocation.actor.kind,'coding_agent');a.userId=null;assert.throws(()=>validateRoomToolResponse({invocation:{actor:a}}));
});
