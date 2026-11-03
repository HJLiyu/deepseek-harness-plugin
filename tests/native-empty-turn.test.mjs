import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {settleEmptyTurn,emptyNativeTurn} from '../src/native-empty-turn.mjs';

function fixture(t){
 const store=new GroupStore(':memory:');t.after(()=>store.close());
 const g=store.create({repo:process.cwd(),models:{codex:{},harness:{}}});
 g.contexts={codex:'context',harness:'h'};g.status='active';
 g.worktrees={codex:process.cwd(),harness:process.cwd()};
 const {request:r}=store.input(g.id,{content:'continue existing goal'});g.activeRequestId=r.id;
 r.status='active';r.actions=[{phase:'work',member:'codex',task:'remaining implementation'}];
 r.phase='execution';r.agreement={owner:'codex',integrator:'codex',tasks:{codex:'remaining implementation',harness:''},review:false};
 r.taskList=[{taskId:'done',key:'old',index:0,revision:r.revision,status:'done',evidenceRefs:['real old evidence'],receipts:{}}];
  r.taskListRevision=r.revision;
 r.taskList.push({taskId:'current',key:'next',index:1,revision:r.revision,status:'running',owner:'codex',deps:['old'],resources:{reads:[],writes:[]}});
 r.currentTaskId='current';
 const d={id:'delivery',groupId:g.id,requestId:r.id,revision:r.revision,epoch:g.epoch,member:'codex',phase:'work',started:true,status:'pending',prompt:'original',nativeTurnId:'turn'};
 d.nativeAdmission={threadId:'context',turnId:'turn',promptHash:store.hash('[Group delivery delivery]\noriginal')};
 r.deliveryId=d.id;store.save(g);store.saveRequest(r);store.saveDelivery(d);
 const answer=emptyNativeTurn('context',{id:'turn',status:'completed',items:[]},'turn');
 return {store,g,r,d,answer};
}

test('known empty native completion preserves revision, accepted tasks and old delivery; bounded continuation is idempotent',t=>{
 const f=fixture(t);settleEmptyTurn(f.store,f.g.id,f.d,f.answer);
 const r=f.store.request(f.r.id),d=f.store.delivery(f.d.id);
 assert.equal(r.revision,f.r.revision);assert.equal(r.taskList[0].status,'done');assert.deepEqual(r.taskList[0].evidenceRefs,['real old evidence']);
 assert.equal(r.status,'queued');assert.equal(r.deliveryId,undefined);assert.equal(r.actions[0].emptyNativeRecovery.attempt,1);
 assert.equal(r.usage.calls,1);assert.equal(r.usage.unknownCalls,1);
 assert.equal(d.status,'completed_without_reply');assert.equal(d.started,true);assert.equal(d.nativeTurnId,'turn');assert.equal(d.responseMessageId,undefined);
 assert.throws(()=>settleEmptyTurn(f.store,f.g.id,f.d,f.answer),/exact terminal/);
});

for(const bad of ['proof','prompt','approval','revision'])test(`empty turn cannot be settled with ${bad} mismatch`,t=>{
 const f=fixture(t);
 if(bad==='proof')f.answer.proof.turnId='other';
 if(bad==='prompt'){f.d.prompt='changed';f.store.saveDelivery(f.d);}
 if(bad==='approval')f.store.savePermission({id:'p',groupId:f.g.id,status:'pending',member:'codex'});
 if(bad==='revision'){f.r.revision++;f.store.saveRequest(f.r);}
 assert.throws(()=>settleEmptyTurn(f.store,f.g.id,f.d,f.answer),/exact terminal/);
 assert.equal(f.store.delivery(f.d.id).status,'pending');
});

test('explicit pause remains paused and repeated empty turns stop with maintenance ownership',t=>{
 const f=fixture(t);f.g.status='paused';f.store.save(f.g);
 f.r.actions[0].emptyNativeRecovery={attempt:2,deliveryIds:['a','b']};f.store.saveRequest(f.r);
 settleEmptyTurn(f.store,f.g.id,f.d,f.answer);
 assert.equal(f.store.group(f.g.id).status,'paused');
 const r=f.store.request(f.r.id);assert.equal(r.status,'blocked');assert.equal(r.errorDetails.human.needsUser,false);
});

test('engine recovery settles the original empty turn without sending input and releases only its proven empty reservation',async t=>{
 const f=fixture(t),ledger=f.store.admissions();
 assert.equal(ledger.reserve({groupId:f.g.id,requestId:f.r.id,taskId:'current',member:'codex',deliveryId:f.d.id}).admitted,true);
 f.r.status='needs_recovery';f.store.saveRequest(f.r);
 let reads=0;
 const engine=new GroupEngine(f.store,{appOpen:async()=>true,recover:async()=>{reads++;return f.answer;},turn:async()=>assert.fail('reconciliation cannot send a model turn')});
 await engine.runTick(f.g.id);
 const saved=f.store.request(f.r.id);
 assert.equal(reads,1);assert.equal(saved.status,'queued');assert.equal(saved.deliveryId,undefined);
 assert.equal(saved.revision,f.r.revision);assert.equal(saved.taskList[0].status,'done');
 assert.equal(ledger.rows()[0].state,'released');assert.equal(ledger.rows()[0].release.reason,'verified_empty_native_turn');
});
