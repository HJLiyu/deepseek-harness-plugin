import test from 'node:test';import assert from 'node:assert/strict';
import {deliveryPermissionPreset} from '../companion/index.mjs';
import {configureIdleEffort} from '../companion/effort.mjs';
test('Harness enforces typed read-only work in its original host preset, while write work keeps its workspace boundary',()=>{
 for(const phase of ['planning','review'])assert.equal(deliveryPermissionPreset({phase,prompt:'invalid'}),'read-only');
 for(const payload of [{assignment:{readOnly:true}},{currentTask:{assignment:{readOnly:true}}}])
   assert.equal(deliveryPermissionPreset({phase:'work',prompt:JSON.stringify(payload)}),'read-only');
 for(const payload of [{assignment:{readOnly:false}},{assignment:{readOnly:'true'}},{assignment:{task:'implement files'}}])
   assert.equal(deliveryPermissionPreset({phase:'work',prompt:JSON.stringify(payload)}),'workspace-write');
 assert.equal(deliveryPermissionPreset({phase:'work',prompt:'invalid'}),'workspace-write');
 assert.equal(deliveryPermissionPreset({phase:'integrate',prompt:JSON.stringify({assignment:{readOnly:true}})}),'workspace-write');
});
test('an absent effort selection never configures or requires an idle agent; actual configuration still requires idle',async()=>{
 const input={agent:{status:'running',inbox:{nextTurn:[],nextStep:[]}},busy:true,sessionController:{selectModel:()=>assert.fail('must not configure')},sessionId:'s',model:{provider:'p',model:'m'}};
 assert.deepEqual(await configureIdleEffort(input),{requested:null,confirmed:null});
 await assert.rejects(configureIdleEffort({...input,effort:'high'}),/must be idle/);
});
