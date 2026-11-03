import test from 'node:test';
import assert from 'node:assert/strict';
import {createTurnDeadline, nativeProgress, turnTiming} from '../src/turn-deadline.mjs';
import {codexTurn} from '../src/codex.mjs';
import {desktopTurn} from '../src/desktop.mjs';

function clock(options = {}) {
  let time = 0, id = 0; const pending = new Map();
  const d = createTurnDeadline({idleMs:30, maxMs:120, now:()=>time,
    setTimer:(f,ms)=>{const key=++id;pending.set(key,{f,at:time+ms});return key;},clearTimer:key=>pending.delete(key),...options});
  const error = d.promise.catch(e=>e);
  return {d,error,pending,advance(ms){const end=time+ms;while(true){const next=[...pending].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;time=next[1].at;pending.delete(next[0]);next[1].f();}time=end;}};
}
test('active work crosses the former wall limit, but idle and absolute limits remain bounded',async()=>{
  const f=clock();for(let i=0;i<5;i++){f.advance(20);f.d.touch();}assert.equal(f.pending.size,1);
  f.advance(20);assert.equal((await f.error).code,'CODEX_TURN_ABSOLUTE_TIMEOUT');
  const idle=clock();idle.advance(30);assert.equal((await idle.error).code,'CODEX_TURN_IDLE_TIMEOUT');
});
test('approval holds suspend idle only, release is idempotent, and completed turns clear timers',async()=>{
  const f=clock(),release=f.d.hold();f.advance(50);release();release();f.advance(29);f.d.close();assert.equal(f.pending.size,0);
  const capped=clock();capped.d.hold();capped.advance(120);assert.equal((await capped.error).code,'CODEX_TURN_ABSOLUTE_TIMEOUT');
});
test('only the exact native turn and real items or nonempty agent output renew idle',()=>{
  const p={threadId:'t',turnId:'v',item:{id:'i',type:'commandExecution'}};
  assert.equal(nativeProgress('item/completed',p,'t','v'),true);
  for(const x of [{...p,threadId:'other'},{...p,turnId:'old'}, {...p,item:{}}])assert.equal(nativeProgress('item/completed',x,'t','v'),false);
  assert.equal(nativeProgress('thread/tokenUsage/updated',p,'t','v'),false);
  assert.equal(nativeProgress('item/agentMessage/delta',{...p,delta:''},'t','v'),false);
});
test('explicit wall limits are preserved and idle cannot exceed them',()=>{
  assert.deepEqual(turnTiming({}),{maxMs:7200000,idleMs:1800000});
  assert.deepEqual(turnTiming({CODEX_TURN_TIMEOUT_MS:'900000',CODEX_TURN_IDLE_TIMEOUT_MS:'1800000'}),{maxMs:900000,idleMs:900000});
});
test('native client uses and disposes the progress clock without changing admission or approvals',async()=>{
  let touches=0,closed=0,held=0,released=0;const never=new Promise(()=>{});
  const result=await codexTurn({threadId:'t',cwd:process.cwd(),prompt:'fixture',onApproval:async()=>false,
    deadlineFactory:()=>({promise:never,touch(){touches++;},close(){closed++;},hold(){held++;return()=>released++;}}),
    rpcFactory:(_cwd,h)=>({notify(){},async close(){},async request(method){
      if(method==='turn/start'){setImmediate(async()=>{
        h.onNotification('item/completed',{threadId:'wrong',turnId:'v',item:{id:'x',type:'commandExecution'}});
        h.onNotification('item/completed',{threadId:'t',turnId:'v',item:{id:'x',type:'commandExecution'}});
        const decision=await h.onRequest('item/commandExecution/requestApproval',{threadId:'t',turnId:'v',availableDecisions:['accept']});assert.equal(decision.decision,'decline');
        h.onNotification('item/completed',{threadId:'t',turnId:'v',item:{id:'f',type:'agentMessage',text:'DONE'}});
        h.onNotification('turn/completed',{turn:{id:'v',status:'completed'}});
      });return{turn:{id:'v'}};}return{};
    }})});
  assert.equal(result.text,'DONE');assert.deepEqual({touches,closed,held,released},{touches:2,closed:1,held:1,released:1});
});
test('desktop repeated snapshots, other turns and hidden reasoning text do not renew idle',async()=>{
  let reads=0,closed=0;const touched=[];
  const result=await desktopTurn({threadId:'t',prompt:'fixture',delay:async()=>{},
    deadlineFactory:()=>({promise:new Promise(()=>{}),touch(){touched.push(reads);},close(){closed++;}}),
    bridgeFactory:()=>({async close(){},async call(name){assert.equal(name,'read_thread');reads++;return{thread:{id:'t'},turns:[
      {id:'unrelated',status:'inProgress',items:[{type:'agentMessage',text:'changing other turn '+reads}]},
      {id:'v',status:reads>=6?'completed':'inProgress',items:[{id:'u',type:'userMessage',content:[{type:'text',text:'fixture'}]},
        {id:'r',type:'reasoning',text:'private '+reads},...(reads>=4?[{id:'a',type:'agentMessage',phase:reads>=6?'final_answer':'commentary',text:reads>=6?'DONE':'public progress'}]:[])]},
    ]};}})});
  assert.equal(result.text,'DONE');assert.deepEqual(touched,[2,4,6]);assert.equal(closed,1);
});
test('desktop deadline during an admitted read remains uncertain and closes its poller without resending',async()=>{
  let reads=0,closed=false,disposed=false;const error=Object.assign(Error('fixture idle timeout'),{code:'CODEX_TURN_IDLE_TIMEOUT'});
  await assert.rejects(desktopTurn({threadId:'t',prompt:'fixture',
    deadlineFactory:()=>{let reject;const promise=new Promise((_,r)=>reject=r);queueMicrotask(()=>reject(error));return{promise,touch(){},close(){disposed=true;}};},
    bridgeFactory:()=>({async close(){closed=true;},async call(name){assert.equal(name,'read_thread');if(++reads>1)return new Promise(()=>{});return{turns:[{id:'v',status:'inProgress',items:[{type:'userMessage',content:[{type:'text',text:'fixture'}]}]}]};}}),
  }),e=>e===error&&e.code!=='GROUP_NOT_ADMITTED');
  assert.equal(closed,true);assert.equal(disposed,true);assert.equal(reads,2);
});
