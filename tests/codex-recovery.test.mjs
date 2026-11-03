import test from 'node:test';
import assert from 'node:assert/strict';
import { codexTurn, codexRecoverDelivery } from '../src/codex.mjs';
import { createHash } from 'node:crypto';

test('writer refusal before turn/start proves non-admission without dispatch', async () => {
  const calls = [];
  await assert.rejects(codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'pending', desktopAvailable: () => false,
    rpcFactory: () => ({ notify() {}, async close() {}, async request(method) {
      calls.push(method);
      if (method === 'thread/resume') throw Error('{"code":-32600,"message":"thread thread already has an active writer"}');
      return {};
    } }),
  }), error => error.code === 'GROUP_NOT_ADMITTED' && error.admissionFailure === 'codex_busy');
  assert.ok(!calls.includes('turn/start'));
});

test('a turn/start transport failure remains uncertain and cannot be retried as unadmitted', async () => {
  await assert.rejects(codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'pending', desktopAvailable: () => false,
    rpcFactory: () => ({ notify() {}, async close() {}, async request(method) {
      if (method === 'turn/start') throw Error('connection lost');
      return {};
    } }),
  }), error => error.message === 'connection lost' && error.code !== 'GROUP_NOT_ADMITTED');
});

const prompt = '[Group delivery delivery]\npending';
const refusal = { kind: 'codex-writer-refusal', threadId: 'thread', deliveryId: 'delivery', auditMessageId: 'audit' };
const native = turns => ({ id: 'thread', status: { type: 'idle' }, turns });

test('only an exact complete zero-item native turn yields empty-turn proof, never generic missing output',async()=>{
 const turn={id:'empty',status:'completed',items:[]};
 const result=await recover(fakeReader([native([turn])]),{nativeTurnId:'empty'});
 assert.equal(result.terminalEmpty,true);assert.equal(result.proof.turnId,'empty');assert.equal(result.notAdmitted,undefined);
 for(const bad of [{...turn,items:undefined},{...turn,items:[{type:'commandExecution',status:'completed'}]},
   {...turn,itemsTruncated:true},{...turn,status:'failed'}]){
   const answer=await recover(fakeReader([native([bad])]),{nativeTurnId:'empty'}).catch(()=>null);
   assert.notEqual(answer?.terminalEmpty,true);
 }
 assert.equal(await recover(fakeReader([native([turn])])),null);
 assert.equal(await recover(fakeReader([native([turn])]),{nativeTurnId:'wrong'}),null);
});
const input = text => ({ type: 'userMessage', content: [{ type: 'text', text }] });

test('unavailable desktop outcome reads are typed connection waits, never non-admission proof',async()=>{
 await assert.rejects(codexRecoverDelivery({threadId:'thread',cwd:process.cwd(),prompt,
  desktopAvailable:()=>true,desktopRecover:async()=>{throw Error('connect ENOENT old private connection')},
  rpcFactory:()=>({notify(){},async close(){},async request(method){if(method==='thread/read')return {thread:native([])};return {}}})
 }),e=>e.code==='GROUP_RECOVERY_UNAVAILABLE'&&e.code!=='GROUP_NOT_ADMITTED');
});
function fakeReader(reads, busy = false) {
  const calls = []; let index = 0, closed = false;
  return { calls, get closed() { return closed; }, rpcFactory: () => ({ notify() {}, async close() { closed = true; }, async request(method) {
    calls.push(method);
    assert.ok(['initialize', 'thread/read', 'thread/resume'].includes(method), 'recovery must never send model input');
    if (method === 'thread/read') return { thread: reads[Math.min(index++, reads.length - 1)] };
    if (method === 'thread/resume' && busy) throw Error('thread thread already has an active writer');
    return {};
  } }) };
}
async function recover(reader, extra = {}) {
  return codexRecoverDelivery({ threadId: 'thread', cwd: process.cwd(), prompt, rpcFactory: reader.rpcFactory, desktopAvailable: () => false, ...extra });
}

test('recovery identifies both native user and desktop delegation input, selecting the actual final reply', async () => {
  const hash = createHash('sha256').update('thread\0' + prompt).digest('hex');
  for (const item of [input(prompt), { type: 'functionCallOutput', namespace: 'codex_app', name: 'send_message_to_thread',
    output: { text: '<codex_delegation><input>[Harness delivery ' + hash + ']\n' + prompt, truncated: true } }]) {
    const reader = fakeReader([native([{ id: 'turn', status: 'completed', items: [item,
      { type: 'agentMessage', text: 'FINAL', phase: 'final_answer' }, { type: 'agentMessage', text: 'COMMENTARY', phase: 'commentary' }] }])]);
    const result = await recover(reader);
    assert.equal(result.text, 'FINAL'); assert.equal(result.recovered, true); assert.equal(result.usage, null);
    assert.ok(!reader.calls.includes('thread/resume')); assert.equal(reader.closed, true);
  }
});

test('missing input without an original refusal audit remains uncertain', async () => {
  const reader = fakeReader([native([])]);
  assert.equal(await recover(reader), null);
  assert.ok(!reader.calls.includes('thread/resume'));
});

test('native start receipt recovers an empty interrupted turn without guessing from time or position',async()=>{
 const reader=fakeReader([native([{id:'empty-admitted',status:'interrupted',items:[]}])]);
 assert.equal(await recover(reader),null);
 const result=await recover(reader,{nativeTurnId:'empty-admitted'});
 assert.equal(result.interrupted,true);assert.equal(result.turnId,'empty-admitted');
 assert.equal(await recover(reader,{nativeTurnId:'unrelated'}),null);
});

test('unmatched superseded read-only recovery needs both complete terminal history and authoritative desktop idle proof',async()=>{
 const extra={allowSupersededReadOnly:true,desktopAvailable:()=>true,desktopRecover:async()=>({unmatched:true,idle:true,threadId:'thread',status:'notLoaded'})};
 const result=await recover(fakeReader([native([{id:'empty',status:'interrupted',items:[]}])]),extra);
 assert.equal(result.supersededReadOnly,true);assert.equal(result.notAdmitted,undefined);
 assert.equal(await recover(fakeReader([native([])]),{...extra,allowSupersededReadOnly:false}),null);
 assert.equal(await recover(fakeReader([native([{id:'active',status:'inProgress',items:[]}])]),extra),null);
 assert.equal(await recover(fakeReader([native([])]),{...extra,desktopRecover:async()=>null}),null);
});

test('turn start receipt is delivered before completion so crashes need not depend on persisted prompt text',async()=>{
 const order=[];
 const result=await codexTurn({threadId:'thread',cwd:process.cwd(),prompt:'readonly',desktopAvailable:()=>false,
 onAdmitted:r=>{order.push('receipt');assert.deepEqual(r,{threadId:'thread',turnId:'native',route:'app-server'});},
 rpcFactory:(_cwd,h)=>({notify(){},async close(){},async request(method){
  if(method==='turn/start'){setImmediate(()=>{order.push('completion');h.onNotification('item/completed',{item:{type:'agentMessage',text:'DONE'}});h.onNotification('turn/completed',{turn:{id:'native',status:'completed'}});});return {turn:{id:'native'}};}return {};
 }})});
 assert.deepEqual(order,['receipt','completion']);assert.equal(result.text,'DONE');
});

test('legacy writer refusal is cleared only after exclusive ownership and a second complete idle read', async () => {
  const reader = fakeReader([native([])]);
  const result = await recover(reader, { refusal });
  assert.equal(result.notAdmitted, true); assert.equal(result.proof.auditMessageId, 'audit');
  assert.deepEqual(reader.calls, ['initialize', 'thread/read', 'thread/resume', 'thread/read']);
  assert.equal(reader.closed, true);
});

test('busy writer, active turn and mismatched audit cannot release the old checkpoint', async () => {
  const busy = fakeReader([native([])], true);
  assert.equal(await recover(busy, { refusal }), null);
  const active = fakeReader([native([]), native([{ id: 'other', status: 'inProgress', items: [] }])]);
  assert.equal(await recover(active, { refusal }), null);
  const wrong = fakeReader([native([])]);
  assert.equal(await recover(wrong, { refusal: { ...refusal, threadId: 'other' } }), null);
  assert.equal(await recover(wrong, { refusal: { ...refusal, deliveryId: 'other' } }), null);
  assert.ok(!wrong.calls.includes('thread/resume'));
});

test('a reply arriving before exclusive read is recovered rather than released for duplicate execution', async () => {
  const reader = fakeReader([native([]), native([{ id: 'arrived', status: 'completed', items: [input(prompt), { type: 'agentMessage', text: 'ARRIVED' }] }])]);
  const result = await recover(reader, { refusal });
  assert.equal(result.text, 'ARRIVED'); assert.equal(result.notAdmitted, undefined);
});

test('partial native reply stays pending, interrupted execution is recorded, wrong thread is rejected', async () => {
  for (const variation of [{ status: 'inProgress' }, { truncated: true }, { textTruncated: true }]) {
    const { status = 'completed', ...flags } = variation;
    const reader = fakeReader([native([{ id: 'turn', status, items: [input(prompt), { type: 'agentMessage', text: 'partial', ...flags }] }])]);
    const result = await recover(reader, { refusal });
    if (status === 'inProgress') { assert.deepEqual(result, { pending: true, turnId: 'turn' }); assert.equal(result.text, undefined); }
    else assert.equal(result, null);
    assert.ok(!reader.calls.includes('thread/resume'));
  }
  const interrupted = fakeReader([native([{ id: 'turn', status: 'interrupted', items: [input(prompt)] }])]);
  assert.equal((await recover(interrupted)).interrupted, true);
  const wrong = fakeReader([{ id: 'other', turns: [] }]);
  await assert.rejects(recover(wrong, { refusal }), /original thread/); assert.equal(wrong.closed, true);
});

test('writer errors after turn/start cannot trigger desktop fallback', async () => {
  let dispatched = false;
  await assert.rejects(codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt, desktopAvailable: () => true,
    desktop: async () => { dispatched = true; }, rpcFactory: () => ({ notify() {}, async close() {}, async request(method) {
      if (method === 'turn/start') throw Error('already has an active writer');
      return {};
    } }),
  }), error => error.code !== 'GROUP_NOT_ADMITTED');
  assert.equal(dispatched, false);
});


test('app-server string delegation output recovers only the exact original delivery', async () => {
 const hash=createHash('sha256').update('thread\0'+prompt).digest('hex');
 const item={type:'functionCallOutput',namespace:'codex_app',name:'send_message_to_thread',output:'<codex_delegation><input>[Harness delivery '+hash+']\n'+prompt+'</input></codex_delegation>'};
 const reader=fakeReader([native([{id:'turn',status:'completed',items:[item,{type:'agentMessage',phase:'final_answer',text:'RECOVERED'}]}])]);
 assert.equal((await recover(reader))?.text,'RECOVERED');assert.ok(!reader.calls.includes('thread/resume'));
 const wrong=fakeReader([native([{id:'turn',status:'completed',items:[{...item,output:item.output.replace(hash,'wrong')},{type:'agentMessage',phase:'final_answer',text:'UNRELATED'}]}])]);
 assert.equal(await recover(wrong),null);
});


test('desktop running or completed status takes precedence over stale sidecar interrupted status', async () => {
 for(const answer of [{pending:true,turnId:'t'},{text:'FINAL',recovered:true,turnId:'t'},null]){
 const reader=fakeReader([native([{id:'t',status:'interrupted',items:[input(prompt)]}])]);
 const r=await recover(reader,{desktopAvailable:()=>true,desktopRecover:async()=>answer});assert.deepEqual(r,answer);
 }
});
test('persisted pre-dispatch busy audit releases only the original absent delivery in an idle thread', async () => {
 const proof={kind:'desktop-pre-dispatch-busy',threadId:'thread',deliveryId:'delivery',auditMessageId:'audit'};
 assert.equal((await recover(fakeReader([native([])]),{refusal:proof})).notAdmitted,true);
 assert.equal(await recover(fakeReader([native([])]),{refusal:{...proof,deliveryId:'wrong'}}),null);
 const active=native([]);active.status={type:'active'};assert.equal(await recover(fakeReader([active]),{refusal:proof}),null);
});


test('known quota failure is a terminal outcome, never an unknown pending reply',async()=>{
 const reader=fakeReader([native([{id:'quota-turn',status:'failed',error:{message:'You have hit your usage limit'},items:[input(prompt)]}])]);
 const result=await recover(reader);assert.equal(result.nativeFailure.kind,'usage_limit');assert.equal(result.interrupted,true);assert.match(result.text,/额度不足/);assert.equal(result.pending,undefined);
});

test('a live quota failure returns a terminal outcome with its exact native admission receipt',async()=>{
 let starts=0,receipts=0;
 const result=await codexTurn({threadId:'thread',cwd:process.cwd(),prompt:'read-only pending',desktopAvailable:()=>false,
  onAdmitted:r=>{receipts++;assert.equal(r.turnId,'quota-live');},
  rpcFactory:(_cwd,h)=>({notify(){},async close(){},async request(method){
   if(method==='turn/start'){starts++;setImmediate(()=>h.onNotification('turn/completed',{threadId:'thread',turn:{id:'quota-live',status:'failed',error:{message:'You have hit your usage limit',codexErrorInfo:'usageLimitExceeded'}}}));return {turn:{id:'quota-live'}};}return {};
  }})});
 assert.equal(starts,1);assert.equal(receipts,1);assert.equal(result.nativeFailure.kind,'usage_limit');assert.equal(result.turnId,'quota-live');assert.equal(result.interrupted,true);
});
