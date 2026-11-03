import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {workflowState,reconcileRecoveries} from '../src/group-workflow.mjs';
import {captureWorkBaseline,captureWorkDelta,captureIntegrationScope,integrationPreflight,verifyIntegration} from '../src/group-integration.mjs';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {groupActivity} from '../src/group-service.mjs';
import {randomUUID} from 'node:crypto';
const git=(root,...args)=>execFileSync('git',['-C',root,...args],{stdio:'pipe'}).toString().trim();
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-arch-')),repo=path.join(dir,'repo'),peer=path.join(dir,'peer');fs.mkdirSync(repo);git(repo,'init');fs.writeFileSync(path.join(repo,'tracked.txt'),'base');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base');const commit=git(repo,'rev-parse','HEAD');git(repo,'worktree','add','--detach',peer,commit);
 const store=new GroupStore(':memory:');t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})});const group=store.create({repo,models:{codex:{},harness:{}}});group.worktrees={codex:peer,harness:peer};group.contexts={codex:'c',harness:'h'};group.baseline={commit};return{repo,peer,store,group};
}
test('new ignore rules do not manufacture deletions during delta capture',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.peer,'temp'));fs.writeFileSync(path.join(f.peer,'temp','old.json'),'old');const before=captureWorkBaseline(f.group,'codex');fs.writeFileSync(path.join(f.peer,'.gitignore'),'temp/\n');let delta=captureWorkDelta(f.group,'codex',before);assert.deepEqual(Object.keys(delta.targets),['.gitignore']);
 fs.unlinkSync(path.join(f.peer,'temp','old.json'));delta=captureWorkDelta(f.group,'codex',before);assert.deepEqual(Object.keys(delta.targets),['.gitignore']);assert.equal(delta.missingSources['temp/old.json'].before,before.peer['temp/old.json']);
 fs.unlinkSync(path.join(f.peer,'tracked.txt'));delta=captureWorkDelta(f.group,'codex',before);assert.equal(delta.targets['tracked.txt'],null);
});
test('legacy baseline does not turn untracked cleanup into main deletion',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.peer,'old.json'),'data');const before=captureWorkBaseline(f.group,'codex');delete before.tracked;delete before.version;fs.unlinkSync(path.join(f.peer,'old.json'));const d=captureWorkDelta(f.group,'codex',before);assert.equal(Object.hasOwn(d.targets,'old.json'),false);assert.ok(d.missingSources['old.json']);
});
test('committed source deletion retains baseline provenance after leaving the member index',t=>{
 const f=fixture(t),baseline=captureWorkBaseline(f.group,'codex');git(f.peer,'rm','tracked.txt');git(f.peer,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','remove source');
 const delta=captureWorkDelta(f.group,'codex',baseline),scope={members:{codex:delta.targets},bases:{codex:delta.bases},deletions:{codex:delta.deletions}};
 assert.equal(scope.members.codex['tracked.txt'],null);assert.equal(delta.deletions['tracked.txt'].before,baseline.peer['tracked.txt']);assert.equal(integrationPreflight(f.group,null,scope).expected['tracked.txt'],null);
 delete scope.deletions;assert.throws(()=>integrationPreflight(f.group,null,scope),{reason:'scope_source_missing'});
});
test('workflow prioritizes pause, real approval and admitted execution over cached failure',()=>{
 const group={status:'blocked'},request={status:'awaiting_review'},delivery={id:'d',started:true,status:'pending',member:'codex',phase:'work'};
 assert.equal(workflowState({group,request,delivery,running:true}).kind,'running');assert.equal(workflowState({group,request,delivery}).nextAction,'recover_original');
 assert.equal(workflowState({group,request,delivery,running:true,approval:{id:'p',member:'codex'}}).kind,'approval');assert.equal(workflowState({group:{status:'paused'},request,delivery,running:true}).kind,'paused');
 assert.equal(workflowState({group,request:{...request,recoveryWait:{state:'needs_refresh'}},delivery}).needsUser,true);
 const fault={status:'paused',epoch:2,schedulerFault:{epoch:2}};
 assert.equal(workflowState({group:fault,request,delivery}).owner,'maintenance');
 assert.equal(workflowState({group:fault,request,delivery,approval:{id:'p',member:'codex'}}).kind,'approval');
 assert.equal(workflowState({group:{...fault,epoch:3},request,delivery}).kind,'paused');
});
test('recovery router is bounded, stops after one transition, never runs with permissions or delivery',()=>{
 let calls=[];const engine={store:{pendingPermissions:()=>[]},reconcileCompletedVerification:()=>{calls.push('completed');return false},repairRetainedCandidates:()=>false,repairMissingSources:()=>{calls.push('sources');return true},repairMainSourceScope:()=>{throw Error('must not execute after transition')}};
 const group={id:'g',status:'blocked',epoch:1},r={status:'blocked',revision:2};assert.equal(reconcileRecoveries(engine,group,r),'repairMissingSources');assert.deepEqual(calls,['completed','sources']);assert.equal(r.workflowTransitions.length,1);
 r.deliveryId='d';assert.equal(reconcileRecoveries(engine,group,r),null);delete r.deliveryId;engine.store.pendingPermissions=()=>[{}];assert.equal(reconcileRecoveries(engine,group,r),null);assert.equal(calls.length,2);
});
test('activity shows actual native execution instead of a stale waiting label',t=>{
 const f=fixture(t),{request:r}=f.store.input(f.group.id,{content:'execute'});f.group.activeRequestId=r.id;f.group.status='awaiting_review';f.store.save(f.group);r.status='awaiting_review';r.actions=[{phase:'work',member:'codex'}];r.deliveryId='d';f.store.saveRequest(r);f.store.saveDelivery({id:'d',groupId:f.group.id,requestId:r.id,status:'pending',started:true,member:'codex',phase:'work'});
 const activity=groupActivity(f.store,{running:new Map([[f.group.id,{}]]),runtime:{}},f.group.id);assert.equal(activity.members[0].state,'busy');assert.equal(activity.workflow.kind,'running');assert.equal(activity.needsUser,false);
});
test('idle adapter reconnect does not present a completed request as needing a host restart',t=>{
 const f=fixture(t);f.group.status='idle';f.store.save(f.group);const a=groupActivity(f.store,{running:new Map(),runtime:{adapter:()=>null}},f.group.id);assert.equal(a.workflow.kind,'idle');assert.equal(a.detail,'等待你的新需求');assert.doesNotMatch(a.detail,/重启/);
});
test('missing untracked source enters independent preservation review; retained bytes stay protected',async t=>{
 const f=fixture(t);for(const root of [f.repo,f.peer])fs.writeFileSync(path.join(root,'old.json'),'retained');fs.writeFileSync(path.join(f.peer,'feature.py'),'new');const baseline=captureWorkBaseline(f.group,'codex'),oldHash=baseline.main['old.json'];fs.unlinkSync(path.join(f.peer,'old.json'));
 const {request:r}=f.store.input(f.group.id,{content:'implement feature'});f.group.activeRequestId=r.id;f.group.status='blocked';f.group.integrationState={main:{'old.json':oldHash},peers:{}};f.store.save(f.group);r.phase='execution';r.status='blocked';r.workBaselines={codex:baseline};r.agreement={owner:'codex',integrator:'codex',review:true};r.actions=[{phase:'integrate',member:'codex'}];r.integrationScope=captureIntegrationScope(f.group,'codex',['feature.py','old.json'],r.revision);
 assert.throws(()=>integrationPreflight(f.group,null,r.integrationScope),{reason:'scope_source_missing'});
 // Recreate a persisted pre-v2 check; the new preflight refuses to create it.
 r.integrationCheck=integrationPreflight(f.group,null,captureIntegrationScope(f.group,'codex',['feature.py'],r.revision));r.integrationCheck.expected['old.json']=null;
 const id=randomUUID(),raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'c',messageId:id},content:JSON.stringify({status:'blocked',message:'missing source'})});f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,status:'received',phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,responseMessageId:raw.id});r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};f.store.saveRequest(r);
 let calls=0;const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{assert.equal(d.phase,'review');const files=++calls===1?[]:['feature.py'];return{text:JSON.stringify({status:'done',message:'source and retained file checked',summary:'ready',verification:['actual hashes checked'],integrationFiles:files,integrationFilesByMember:{codex:files},preservedFiles:['old.json']})};}});
 await e.tick(f.group.id);assert.equal(f.store.request(r.id).actions[0].phase,'review');assert.ok(f.store.request(r.id).actions[0].responseRepair);assert.equal(f.store.request(r.id).reviewRepairRounds??0,0);
 await e.tick(f.group.id);const after=f.store.request(r.id);assert.equal(after.status,'active');assert.deepEqual(after.integrationScope.preserved,{'old.json':oldHash});assert.equal(after.actions[0].phase,'integrate');assert.equal(after.sourceRecovery.originalScope.targets['old.json'],null);assert.equal(calls,2);
 const check=integrationPreflight(f.group,null,after.integrationScope);fs.copyFileSync(path.join(f.peer,'feature.py'),path.join(f.repo,'feature.py'));assert.ok(verifyIntegration(f.repo,check)['feature.py']);fs.writeFileSync(path.join(f.repo,'old.json'),'changed');assert.throws(()=>verifyIntegration(f.repo,check),{reason:'verification_mismatch'});
});
