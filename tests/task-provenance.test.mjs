import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync}from'node:child_process';import{randomUUID}from'node:crypto';
import{activateTaskLane,laneRequest,prepareLaneSave}from'../src/task-lanes.mjs';
import{GroupStore}from'../src/group-store.mjs';import{GroupEngine}from'../src/group-engine.mjs';import{captureWorkBaseline}from'../src/group-integration.mjs';

test('task switching keeps each artifact baseline and selection separate through serialization',()=>{
  const r={id:'r',revision:0};const old=activateTaskLane(r,'dispatch');
  r.workBaselines={codex:{peer:{'parallel.mjs':'partial'}}};r.workCandidates={codex:{'parallel.mjs':'partial'}};r.integrationScope={targets:{'parallel.mjs':'partial'}};
  activateTaskLane(r,'admission-fix');assert.equal(r.workBaselines,undefined);assert.equal(r.integrationScope,undefined);assert.equal(old.workCandidates.codex['parallel.mjs'],'partial');
  r.workBaselines={codex:{peer:{'admission.mjs':'fixed'}}};const reopened=laneRequest(JSON.parse(JSON.stringify(r)));
  assert.equal(reopened.workBaselines.codex.peer['admission.mjs'],'fixed');activateTaskLane(reopened,'dispatch');assert.equal(reopened.integrationScope.targets['parallel.mjs'],'partial');
  delete reopened.workCandidates;prepareLaneSave(reopened);assert.equal(reopened.lanes['r:0:dispatch'].workCandidates,undefined);
});
test('legacy active artifact facts migrate once and a new task never inherits them',()=>{
  const r={id:'r',revision:0,workBaselines:{codex:{peer:{x:'old'}}},integrationCheck:{before:{x:'old'}}};
  laneRequest(r);assert.deepEqual(r.lanes[r.activeLaneKey].integrationCheck,{before:{x:'old'}});
  activateTaskLane(r,'next');assert.equal(r.integrationCheck,undefined);assert.equal(r.workBaselines,undefined);
});
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'task-provenance-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,stdio:'pipe'});git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.invalid');fs.writeFileSync(path.join(dir,'a'),'base');git('add','a');git('commit','-qm','fixture');
  const s=new GroupStore(':memory:');t.after(()=>s.close());const g=s.create({repo:dir,models:{}});g.status='blocked';g.contexts={codex:'c',harness:'h'};g.worktrees={codex:dir,harness:dir};s.save(g);
  const{request:r}=s.input(g.id,{content:'Two tasks'});r.status='blocked';r.phase='execution';r.agreement={integrator:'codex',owner:'codex'};r.actions=[{phase:'integrate',member:'codex'}];r.currentTaskId='a';r.integrationCheck={before:captureWorkBaseline(g,'codex').main};
  const id=randomUUID(),m=s.message(g.id,{sender:'codex',channel:'group',requestId:r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'c',messageId:id},content:JSON.stringify({status:'blocked',message:'本轮整合因固定文件范围不一致而暂停，主项目未改动。'})});
  s.saveDelivery({id,groupId:g.id,requestId:r.id,phase:'integrate',member:'codex',status:'received',responseMessageId:m.id,revision:r.revision,epoch:g.epoch});r.results={'integrate:codex':{status:'blocked',messageId:m.id}};s.saveRequest(r);
  return{s,g,r,e:new GroupEngine(s,{})};
}
test('scope mismatch schedules read-only reconciliation once per task, preserving the integration action',t=>{
  const f=fixture(t);assert.equal(f.e.repairReadinessConflict(f.g,f.r),true);assert.equal(f.r.actions[0].integrationReadiness,true);assert.equal(f.r.actions[1].phase,'integrate');
  f.r.actions.shift();assert.equal(f.e.repairReadinessConflict(f.g,f.r),false);
  const other=fixture(t);other.r.readinessConflictRepairs=[`${other.r.revision}:a`];other.r.currentTaskId='b';assert.equal(other.e.repairReadinessConflict(other.g,other.r),true);
});
test('scope recovery cannot acknowledge a concurrent main edit or an uncertain delivery',t=>{
  const f=fixture(t);f.r.deliveryId='unknown';assert.equal(f.e.repairReadinessConflict(f.g,f.r),false);delete f.r.deliveryId;
  fs.writeFileSync(path.join(f.g.repo,'a'),'human edit');assert.equal(f.e.repairReadinessConflict(f.g,f.r),false);assert.equal(fs.readFileSync(path.join(f.g.repo,'a'),'utf8'),'human edit');
});
test('received work declaration allows only a fixed narrower proposal after unrelated maintenance',t=>{
  const f=fixture(t),id=randomUUID();const work=f.s.message(f.g.id,{sender:'codex',channel:'group',requestId:f.r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'c',messageId:id},content:JSON.stringify({status:'done',integrationFiles:['a']})});
  f.s.saveDelivery({id,groupId:f.g.id,requestId:f.r.id,phase:'work',member:'codex',status:'received',responseMessageId:work.id,revision:f.r.revision,epoch:f.g.epoch});f.r.results['work:codex']={messageId:work.id};
  f.r.integrationScope={revision:f.r.revision,members:{codex:{a:captureWorkBaseline(f.g,'codex').peer.a,'unreviewed.mjs':null}}};
  fs.writeFileSync(path.join(f.g.repo,'maintenance.txt'),'preserve');assert.equal(f.e.repairReadinessConflict(f.g,f.r),true);
  assert.deepEqual(Object.keys(f.r.actions[0].integrationSnapshot.targets),['a']);assert.ok(Object.hasOwn(f.r.actions[0].readinessConflict.originalScope.members.codex,'unreviewed.mjs'));
  assert.ok(Object.hasOwn(f.r.integrationScope.members.codex,'unreviewed.mjs'),'scope is not silently approved or overwritten');
  assert.equal(fs.readFileSync(path.join(f.g.repo,'maintenance.txt'),'utf8'),'preserve');
});
test('fixed task-scope proposal reaches native read-only review with complete bases, including saved legacy shape',async t=>{
  for(const legacy of [false,true]){
    const f=fixture(t),base=captureWorkBaseline(f.g,'codex').main.a,id=randomUUID();
    f.g.baseline={commit:execFileSync('git',['rev-parse','HEAD'],{cwd:f.g.repo,encoding:'utf8'}).trim()};f.g.activeRequestId=f.r.id;
    const work=f.s.message(f.g.id,{sender:'codex',channel:'group',requestId:f.r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'c',messageId:id},content:JSON.stringify({status:'done',integrationFiles:['a']})});
    f.s.saveDelivery({id,groupId:f.g.id,requestId:f.r.id,phase:'work',member:'codex',status:'received',responseMessageId:work.id,revision:f.r.revision,epoch:f.g.epoch});f.r.results['work:codex']={messageId:work.id};
    f.r.integrationScope={revision:f.r.revision,members:{codex:{a:base,'unreviewed.mjs':null}},bases:{codex:{a:base,'unreviewed.mjs':null}}};
    assert.equal(f.e.repairReadinessConflict(f.g,f.r),true);if(legacy)delete f.r.actions[0].integrationSnapshot.bases;
    f.s.saveRequest(f.r);f.s.save(f.g);let calls=0;
    f.e.runtime={appOpen:async()=>true,turn:async(_g,d)=>{calls++;assert.equal(d.phase,'review');return{text:JSON.stringify({status:'done',message:'Only a reviewed',summary:'Verified',integrationFiles:['a'],...(legacy?{integrationFilesByMember:{codex:['a']}}:{}),verification:['Fixture bytes verified']})};}};
    await f.e.tick(f.g.id);const current=f.s.request(f.r.id);
    assert.equal(calls,1);assert.equal(current.actions[0].phase,'integrate');assert.deepEqual(Object.keys(current.integrationScope.targets??current.integrationScope.members.codex),['a']);assert.ok(current.integrationReadyReceipt);
    assert.equal(fs.readFileSync(path.join(f.g.repo,'a'),'utf8'),'base');
  }
});
