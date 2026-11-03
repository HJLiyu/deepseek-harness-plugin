import test from 'node:test';
import assert from 'node:assert/strict';
import {waitHarnessReply} from '../companion/index.mjs';

const start=id=>[{type:'turn/start',seq:1,data:{turn:7}},{type:'user/message',seq:2,data:{source:{kind:'user',rpcId:`group-${id}`},content:[{type:'text',text:`[Group delivery ${id}]\nwork`}]}}];
const end=[{type:'assistant/message',seq:3,data:{turn:7,message:{content:[{type:'text',text:'verified'}]}}},{type:'turn/end',seq:4,data:{turn:7,reason:{kind:'completed'}}}];
function fixture(){let clock=0;const events=[],agent={status:'idle',inbox:{nextStep:[],nextTurn:[]},session:{},ctx:{parallel:async()=>{}},whenIdle:async()=>{}};return {agent,events,now:()=>clock,advance:()=>clock+=100};}

test('queued prompt idle edge cannot finish the delivery before its own native turn',async()=>{
 const f=fixture();let waits=0;
 const result=await waitHarnessReply(f.agent,async()=>f.events,'d',{now:f.now,delay:async()=>{waits++;f.advance();if(waits===1){f.events.push(...start('d'));f.agent.status='running';}if(waits===2){f.events.push(...end);f.agent.status='idle';}}});
 assert.equal(waits,2);assert.equal(result.text,'verified');assert.equal(result.proof.turn,7);
});
test('other native reply and idle without admission never become this delivery result',async()=>{
 const f=fixture();f.events.push(...start('other'),...end);
 const result=await waitHarnessReply(f.agent,async()=>f.events,'d',{now:f.now,startupMs:200,delay:async()=>f.advance()});assert.equal(result,null);
});
test('unended native delivery stays unknown at the bounded deadline',async()=>{
 const f=fixture();f.events.push(...start('d'));f.agent.status='running';
 const result=await waitHarnessReply(f.agent,async()=>f.events,'d',{now:f.now,timeoutMs:200,delay:async()=>f.advance()});assert.equal(result,null);
});
