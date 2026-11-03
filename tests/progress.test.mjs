import test from 'node:test';
import assert from 'node:assert/strict';
import { publicAnswer, harnessAnswer, codexAnswerItem, AnswerPreviews, createPreviewEmitter } from '../src/group-progress.mjs';

test('public previews extract only the protocol message, cap text and ignore partial escapes', () => {
  assert.equal(publicAnswer('{"message":"正在写入\\n中文'), '正在写入\n中文');
  assert.equal(publicAnswer('{"message":"yes","technical":"private"}'), 'yes');
  assert.equal(publicAnswer('{"summary":"not public yet"}'), '');
  assert.equal(publicAnswer('{"message":"incomplete\\u'), '');
  assert.equal(publicAnswer('x'.repeat(9000)).length, 2000);
  assert.equal(codexAnswerItem({type:'reasoning',phase:'final',text:'private'}),'');
  assert.equal(codexAnswerItem({type:'agentMessage',phase:'analysis',text:'private'}),'');
  assert.equal(codexAnswerItem({type:'agentMessage',text:'unclassified'}),'');
  assert.equal(codexAnswerItem({type:'agentMessage',phase:'final_answer',text:'public'}),'public');
});
test('Harness previews bind the exact native turn and exclude reasoning, other turns and ended replies', () => {
  const events=[{type:'turn/start',data:{turn:1}},{type:'user/message',data:{source:{kind:'user',rpcId:'group-d'},content:[{type:'text',text:'[Group delivery d]\nprompt'}]}},
    {type:'assistant/message',data:{turn:1,message:{content:[{type:'reasoning',text:'secret'},{type:'text',text:'public answer'}]}}},
    {type:'assistant/message',data:{turn:0,message:{content:[{type:'text',text:'old'}]}}}];
  assert.equal(harnessAnswer(events,'d'),'public answer');assert.equal(harnessAnswer(events,'other'),'');
  events.push({type:'turn/end',data:{turn:1}});assert.equal(harnessAnswer(events,'d'),'');
});
test('temporary previews reject stale scopes, throttle, expire and clear without storing any message', () => {
  let clock=0;const p=new AnswerPreviews({now:()=>clock}),g={id:'g',status:'active',activeRequestId:'r'},r={id:'r',status:'active',revision:1,deliveryId:'d'},d={id:'d',member:'codex',revision:1,started:true,status:'pending'};
  assert.equal(p.update(g,r,d,'one'),true);assert.equal(p.update(g,r,d,'two'),false);clock=500;assert.equal(p.update(g,r,d,'two'),true);
  assert.equal(p.read(g,r,d).text,'two');assert.equal(p.update(g,r,{...d,id:'old'},'stale'),false);assert.equal(p.read(g,r,d).text,'two');
  assert.equal(p.read(g,{...r,revision:2},d),null);assert.equal(p.entries.size,0);
  p.update(g,r,d,'again');assert.equal(p.read({...g,status:'paused'},r,d),null);
  clock=1000;p.update(g,r,d,'again');clock=17000;assert.equal(p.read(g,r,d),null);
  assert.equal(p.update(g,null,null,'bad'),false);assert.equal(p.update(g,r,{...d,status:'received'},'done'),false);
});
test('emitter coalesces, does not repeat identical text, and cancels trailing callbacks on close', async () => {
  const seen=[];const p=createPreviewEmitter(t=>seen.push(t));p.update('one');p.update('two');p.update('three');assert.deepEqual(seen,['one']);p.close();
  await new Promise(resolve=>setTimeout(resolve,520));assert.deepEqual(seen,['one']);
});
