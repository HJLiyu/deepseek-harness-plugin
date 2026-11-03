import test from 'node:test';
import assert from 'node:assert/strict';
import {recoverDesktopDelivery} from '../src/desktop.mjs';
for(const status of ['completed','running','interrupted','failed','missing'])test(`read-only desktop recovery preserves ${status} outcome and closes only its own bridge`,async()=>{
 let closed=0;const calls=[];
 const result=await recoverDesktopDelivery({threadId:'ct',prompt:'original dispatch',bridgeFactory:()=>({async close(){closed++},async call(name){calls.push(name);return {thread:{id:'ct'},turns:status==='missing'?[]:[{id:'original-turn',status,items:[{type:'userMessage',content:[{type:'text',text:'original dispatch'}]},{type:'agentMessage',phase:'final',text:'verified final'}]}]}}})});
 assert.equal(closed,1);assert.deepEqual(calls,['read_thread']);
 if(status==='completed')assert.equal(result.text,'verified final');
 if(status==='running')assert.equal(result.pending,true);
 if(status==='interrupted')assert.equal(result.interrupted,true);
 if(status==='failed')assert.equal(result.nativeFailure.kind,'native_error');
 if(status==='missing')assert.equal(result,null);
});
test('read-only recovery cleanup never masks the original read error or sends another turn',async()=>{
 let closed=0;await assert.rejects(recoverDesktopDelivery({threadId:'ct',prompt:'original',bridgeFactory:()=>({async close(){closed++},async call(name){assert.equal(name,'read_thread');throw Error('original read failed')}})}),/original read failed/);assert.equal(closed,1);
});
