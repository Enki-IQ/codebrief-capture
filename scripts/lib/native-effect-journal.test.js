import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNativeEffectJournal} from './connected-agent-state.js';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const bound={repo:{fullName:'Acme/Repo'},runtimeId:id(1),sessionId:id(2),claim:{attemptId:id(3),handoffId:id(4),actionId:id(5),actionVersion:1,instanceId:id(6),generation:1,version:1,leaseExpiresAt:'2030-01-01T00:00:00.000Z'},workspaceId:'worktree',threadId:id(7)};
const ref={...bound,requestId:id(8),digest:'a'.repeat(64)};
const row={version:1,ref,lease:{effectId:id(8),leaseToken:id(9),leaseGeneration:1,replyId:id(10)},threadId:id(7),turnId:null,state:'reserved'};
function fixture(run){const baseDir=realpathSync(mkdtempSync(join(tmpdir(),'native-journal-')));try{return run({baseDir},'b'.repeat(64));}finally{rmSync(baseDir,{recursive:true,force:true});}}
test('restart preserves original source-free unresolved fence across different request',()=>fixture((options,key)=>{const first=createNativeEffectJournal(key,bound,options);first.save(ref,row);const restarted=createNativeEffectJournal(key,bound,options);assert.deepEqual(restarted.loadActive(bound),row);assert.equal(restarted.load({...ref,requestId:id(11)}),null);assert.deepEqual(restarted.load(ref),row);const raw=readFileSync(join(options.baseDir,'connected-agents/v1',key,'native-effects.json'),'utf8');assert.ok(!raw.includes('text'));}));
test('journal rejects arbitrary body fields and changed original binding or turn',()=>fixture((options,key)=>{const journal=createNativeEffectJournal(key,bound,options);assert.throws(()=>journal.save(ref,{...row,text:'SOURCE'}),/native_journal_invalid/);journal.save(ref,{...row,turnId:id(12),state:'running'});assert.throws(()=>journal.save(ref,{...row,turnId:id(13),state:'running'}),/native_journal_scope_conflict/);assert.throws(()=>journal.load({...ref,digest:'c'.repeat(64)}),/native_journal_scope_conflict/);assert.throws(()=>journal.load({...ref,runtimeId:id(14)}),/native_journal_scope_conflict/);}));
test('terminal journal cannot reopen and no longer counts as unresolved',()=>fixture((options,key)=>{const journal=createNativeEffectJournal(key,bound,options);journal.save(ref,{...row,state:'completed',turnId:id(12)});assert.equal(journal.loadActive(bound),null);assert.throws(()=>journal.save(ref,{...row,state:'issued_unknown',turnId:id(12)}),/native_journal_scope_conflict/);assert.equal(journal.load(ref).state,'completed');}));
