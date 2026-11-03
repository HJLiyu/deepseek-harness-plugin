import test from 'node:test';
import assert from 'node:assert/strict';
import {assertInstallerIdle,reusablePlugin,waitForAdapter} from '../src/install-guard.mjs';

test('installer refuses its own group or any running turn before replacing files',()=>{
 const bindings=[{contexts:{codex:'codex-member',harness:'harness-member'}}];
 for(const id of ['codex-member','harness-member'])assert.throws(()=>assertInstallerIdle({running:0},bindings,id),/原生回合/);
 assert.throws(()=>assertInstallerIdle({running:1},bindings,'maintenance'),/执行中的回合/);
 assert.doesNotThrow(()=>assertInstallerIdle({running:0},bindings,'maintenance'));
});
test('same enabled installed version reuses registration; other versions and disabled entries do not',()=>{
 const p={pluginId:'codex-deepseek-harness@haoju-local',installed:true,enabled:true,version:'0.3.2'};
 assert.equal(reusablePlugin({installed:[p]},'0.3.2'),true);
 for(const changed of [{version:'0.3.1'},{enabled:false},{installed:false},{pluginId:'other'}])assert.equal(reusablePlugin({installed:[{...p,...changed}]},'0.3.2'),false);
});
test('installer waits for the existing host heartbeat after coordinator restart and bounds offline waiting',async()=>{
 for(const online of [true,false]){
  let clock=0,reads=0;
  const h=await waitForAdapter(async()=>{reads++;return {adapters:clock>=4000&&online?[{adapterId:'harness-desktop',connected:true}]:[]};},'harness-desktop',{now:()=>clock,delay:async ms=>{clock+=ms;},timeoutMs:6000});
  assert.equal(Boolean(h.adapters[0]?.connected),online);assert.equal(clock,online?4000:6000);assert.ok(reads<=13);
 }
});
