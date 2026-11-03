import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {attachDiagnostics} from '../src/integration-diagnostics.mjs';
import {captureWorkBaseline,captureWorkDelta,captureIntegrationScope,captureReviewedIntegration,captureReviewedMain,captureReviewedClosure,integrationPreflight,verifyIntegration} from '../src/group-integration.mjs';
const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'}).toString().trim();
test('completed native integration reconciles an ignore visibility error without another turn',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.repo,'temporary.json'),'retained');fs.writeFileSync(path.join(f.peer,'.gitignore'),'temporary.json\n');
 const {request:r}=f.store.input(f.group.id,{content:'忽略临时结果并提交'});r.phase='execution';r.status='blocked';r.agreement={owner:'codex',integrator:'codex',review:false};r.actions=[{phase:'integrate',member:'codex'}];r.integrationScope=captureIntegrationScope(f.group,'codex',['.gitignore'],r.revision);r.integrationCheck=integrationPreflight(f.group,null,r.integrationScope);
 fs.copyFileSync(path.join(f.peer,'.gitignore'),path.join(f.repo,'.gitignore'));git(f.repo,'add','.gitignore');f.commit();const head=git(f.repo,'rev-parse','HEAD');
 const id=randomUUID(),raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id},content:JSON.stringify({status:'done'})});f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,status:'received',phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,responseMessageId:raw.id});r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};attachDiagnostics(r,{reason:'verification_mismatch',technical:{file:'temporary.json'}});
 const e=new GroupEngine(f.store,{});assert.equal(e.reconcileCompletedVerification(f.group,r),true);assert.equal(r.results['integrate:codex'].status,'done');assert.equal(git(f.repo,'rev-parse','HEAD'),head);assert.equal(fs.readFileSync(path.join(f.repo,'temporary.json'),'utf8'),'retained');
});
test('ignore rules cannot turn retained files into deletions or hide real modifications',t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.repo,'scratch'));fs.writeFileSync(path.join(f.repo,'scratch','result.json'),'original');fs.writeFileSync(path.join(f.peer,'.gitignore'),'scratch/\n');
 const scope=captureIntegrationScope(f.group,'codex',['.gitignore'],0),check=integrationPreflight(f.group,null,scope);fs.copyFileSync(path.join(f.peer,'.gitignore'),path.join(f.repo,'.gitignore'));
 assert.equal(verifyIntegration(f.repo,check)['.gitignore'],scope.targets['.gitignore']);
 fs.writeFileSync(path.join(f.repo,'scratch','result.json'),'changed');assert.throws(()=>verifyIntegration(f.repo,check),{reason:'verification_mismatch'});
 fs.unlinkSync(path.join(f.repo,'scratch','result.json'));assert.throws(()=>verifyIntegration(f.repo,check),{reason:'verification_mismatch'});
});
test('readiness freezes reviewed files from both member sources',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.peer,'implementation.py'),'code');fs.writeFileSync(path.join(f.peer,'checker.py'),'check');f.group.status='active';f.store.save(f.group);const {request:r}=f.store.input(f.group.id,{content:'整合双方已交付文件'});f.group.activeRequestId=r.id;f.store.save(f.group);r.status='active';r.phase='execution';r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'整合',harness:'复核'}};r.actions=[{phase:'review',member:'harness',integrationReadiness:true},{phase:'integrate',member:'codex'}];f.store.saveRequest(r);
 const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>({text:JSON.stringify({status:'done',message:'双方来源已核对',summary:'完整范围',verification:['逐文件核对'],integrationFiles:['implementation.py','checker.py'],integrationFilesByMember:{codex:['implementation.py'],harness:['checker.py']}})})});
 await e.tick(f.group.id);const after=f.store.request(r.id);assert.equal(after.status,'active');assert.deepEqual(Object.keys(after.integrationScope.members.codex),['implementation.py']);assert.deepEqual(Object.keys(after.integrationScope.members.harness),['checker.py']);assert.equal(after.actions[0].phase,'integrate');
});
test('readiness scope conflict returns missing implementation to work without dropping requirements',async t=>{
 const f=fixture(t);f.group.status='active';f.store.save(f.group);const {request:r}=f.store.input(f.group.id,{content:'新增忽略文件并提交'});f.group.activeRequestId=r.id;f.group.status='blocked';f.store.save(f.group);
 r.phase='execution';r.status='blocked';r.agreement={owner:'codex',integrator:'codex',review:true,tasks:{codex:'新增.gitignore后提交',harness:'独立复核'}};r.actions=[{phase:'integrate',member:'codex',task:r.agreement.tasks.codex}];r.integrationScope=captureReviewedMain(f.group,['acceptance.json'],f.before,r.revision);r.integrationCheck=integrationPreflight(f.group,null,r.integrationScope);
 const id=randomUUID(),raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id},content:JSON.stringify({status:'blocked',message:'范围存在冲突：清单遗漏原要求的新文件'})});
 f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,status:'received',phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,responseMessageId:raw.id});r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};f.store.saveRequest(r);
 const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{assert.equal(d.phase,'review');return{text:JSON.stringify({status:'changes_requested',message:'先在成员树补齐.gitignore，再复核',summary:'原要求保留',verification:['文件尚不存在'],repairMembers:['codex']})};}});
 await e.tick(f.group.id);const after=f.store.request(r.id);assert.equal(after.status,'active');assert.equal(after.actions[0].phase,'work');assert.equal(after.actions[0].member,'codex');assert.equal(after.actions[0].task,r.agreement.tasks.codex);assert.equal(fs.existsSync(path.join(f.repo,'.gitignore')),false);assert.equal(e.repairReadinessConflict(f.group,after),false);
});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'main-source-')),repo=path.join(dir,'repo'),peer=path.join(dir,'peer');fs.mkdirSync(repo);git(repo,'init');fs.writeFileSync(path.join(repo,'base'),'base');git(repo,'add','.');
 const commit=()=>git(repo,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','local');commit();const base=git(repo,'rev-parse','HEAD');git(repo,'worktree','add','--detach',peer,base);
 const store=new GroupStore(':memory:');t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true})});const group=store.create({repo,models:{codex:{},harness:{}}});group.worktrees={codex:peer,harness:peer};group.contexts={codex:'ct',harness:'ht'};group.baseline={commit:base};fs.writeFileSync(path.join(repo,'acceptance.json'),'accepted');const before=captureWorkBaseline(group,'codex');return{store,group,repo,peer,before,commit};
}
test('typed read-only integration freezes authenticated empty scope instead of accumulated worktree changes',t=>{
 const f=fixture(t),{request:r}=f.store.input(f.group.id,{content:'只读验收'});r.currentTaskId='ro';r.taskListRevision=r.revision;r.taskList=[{taskId:'ro',owner:'harness',readOnly:true}];r.actions=[{phase:'integrate',member:'codex',readOnly:true}];r.results={};
 for(const [member,phase]of [['harness','work'],['codex','review']]){const id=randomUUID(),m=f.store.message(f.group.id,{sender:member,channel:'group',requestId:r.id,protocol:true,origin:{adapter:member+'-reply',sessionId:member==='codex'?'ct':'ht',messageId:id},content:JSON.stringify({status:'done',integrationFiles:[],verification:['只读确认']})});f.store.saveDelivery({id,taskId:'ro',groupId:f.group.id,requestId:r.id,revision:r.revision,member,phase,status:'received',responseMessageId:m.id});r.results[phase+':'+member]={status:'done',messageId:m.id};}
 fs.writeFileSync(path.join(f.peer,'base'),'unrelated old peer change');const e=new GroupEngine(f.store,{});assert.equal(e.freezeReadOnlyScope(f.group,r),true);assert.deepEqual(r.integrationScope.targets,{});const check=integrationPreflight(f.group,null,r.integrationScope);assert.deepEqual(check.expected,{});assert.deepEqual(verifyIntegration(f.repo,check),{});
 fs.writeFileSync(path.join(f.repo,'base'),'unexpected write');assert.throws(()=>verifyIntegration(f.repo,check),{reason:'verification_mismatch'});
 delete r.integrationScope;r.taskList[0].readOnly=false;assert.equal(e.freezeReadOnlyScope(f.group,r),false);r.taskList[0].readOnly=true;delete r.results['review:codex'];assert.equal(e.freezeReadOnlyScope(f.group,r),false);
});

function appliedFixture(t){
 const f=fixture(t),{request:r}=f.store.input(f.group.id,{content:'完成界面与验证'});
 f.group.activeRequestId=r.id;f.group.status='blocked';f.store.save(f.group);
 r.phase='execution';r.status='blocked';r.agreement={owner:'codex',integrator:'codex',review:true};r.actions=[{phase:'integrate',member:'codex'}];
 fs.writeFileSync(path.join(f.peer,'ui.html'),'candidate');
 r.integrationScope=captureIntegrationScope(f.group,'codex',['ui.html'],r.revision);r.integrationCheck=integrationPreflight(f.group,null,r.integrationScope);
 fs.copyFileSync(path.join(f.peer,'ui.html'),path.join(f.repo,'ui.html'));fs.writeFileSync(path.join(f.repo,'fixture.mjs'),'repaired fixture');
 const id=randomUUID(),raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id},content:JSON.stringify({status:'blocked',message:'已写入，验证失败',integrationFiles:['ui.html']})});
 f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,status:'received',responseMessageId:raw.id});
 r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};f.store.saveRequest(r);
 return {...f,r,id};
}
test('applied integration freezes repairs for independent validation without replaying the merge',async t=>{
 const f=appliedFixture(t);let calls=0;
 const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls++;assert.equal(d.phase,'review');assert.equal(d.member,'harness');return{text:JSON.stringify({status:'done',message:'当前阶段验证通过',summary:'独立验证',verification:['相关测试通过'],preserveMain:true,validationPassed:true,integrationFiles:['ui.html','fixture.mjs']})};}});
 await e.tick(f.group.id);assert.equal(calls,1);const r=f.store.request(f.r.id);assert.equal(r.status,'completed');assert.equal(r.results['integrate:codex'].status,'done');assert.equal(r.mainScopeRepair.originalScope.targets['ui.html'],r.integrationScope.mainTargets['ui.html']);assert.equal(fs.readFileSync(path.join(f.repo,'fixture.mjs'),'utf8'),'repaired fixture');
});
test('applied integration rejects unknown, stale, changed candidates, index and absent applied files',t=>{
 for(const mutation of [f=>f.r.deliveryId='unknown',f=>{const d=f.store.delivery(f.id);d.epoch++;f.store.saveDelivery(d)},f=>fs.writeFileSync(path.join(f.peer,'ui.html'),'changed source'),f=>git(f.repo,'add','ui.html'),f=>fs.unlinkSync(path.join(f.repo,'ui.html')),f=>{f.r.results['integrate:codex'].messageId='missing'}]){
  const f=appliedFixture(t);mutation(f);assert.equal(new GroupEngine(f.store,{}).repairAppliedIntegration(f.group,f.r),false);
 }
});
test('applied integration is bounded and cannot accept files changed during independent review',async t=>{
 const f=appliedFixture(t),e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async()=>{fs.writeFileSync(path.join(f.repo,'fixture.mjs'),'changed after freeze');return{text:JSON.stringify({status:'done',message:'pass',summary:'pass',verification:['test'],preserveMain:true,validationPassed:true,integrationFiles:['ui.html','fixture.mjs']})}}});
 assert.equal(e.repairAppliedIntegration(f.group,f.r),true);f.store.saveRequest(f.r);f.store.save(f.group);assert.equal(e.repairAppliedIntegration(f.group,f.r),false);
 await e.tick(f.group.id);assert.equal(f.store.request(f.r.id).status,'blocked');assert.notEqual(f.store.request(f.r.id).results['integrate:codex'].status,'done');
});
test('missing member file is not a reviewed deletion; main-only commit validates unchanged bytes',t=>{
 const f=fixture(t);assert.throws(()=>captureReviewedIntegration(f.group,'codex',['acceptance.json'],f.before,0),{reason:'scope_source_missing'});
 const scope=captureReviewedMain(f.group,['acceptance.json'],f.before,0),check=integrationPreflight(f.group,null,scope);git(f.repo,'add','acceptance.json');f.commit();assert.equal(verifyIntegration(f.repo,check)['acceptance.json'],scope.mainTargets['acceptance.json']);
 fs.writeFileSync(path.join(f.repo,'acceptance.json'),'changed');assert.throws(()=>integrationPreflight(f.group,null,scope),{reason:'main_conflict'});
});
test('completed commit is reconciled only by independent review, without another integration or commit',async t=>{
 const f=fixture(t),scope=captureReviewedMain(f.group,['acceptance.json'],f.before,0);f.group.integrationState={main:scope.mainTargets,peers:{}};f.group.status='active';f.store.save(f.group);
 const {request:r}=f.store.input(f.group.id,{content:'把现有成果本地提交'});f.group.activeRequestId=r.id;f.group.status='blocked';f.store.save(f.group);
 r.phase='execution';r.status='blocked';r.agreement={owner:'codex',integrator:'codex',review:true};r.actions=[{phase:'integrate',member:'codex'}];r.integrationScope=captureIntegrationScope(f.group,'codex',['acceptance.json'],r.revision);
 assert.throws(()=>integrationPreflight(f.group,null,r.integrationScope),{reason:'scope_source_missing'});
 r.integrationCheck=integrationPreflight(f.group,null,scope);r.integrationCheck.expected['acceptance.json']=null; // saved legacy check
 const id=randomUUID();f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,status:'received'});
 const raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,content:JSON.stringify({status:'done'}),protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id}});r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};r.error='scope mismatch';attachDiagnostics(r,{reason:'verification_mismatch',technical:{expected:null}});f.store.saveRequest(r);
 git(f.repo,'add','acceptance.json');f.commit();const head=git(f.repo,'rev-parse','HEAD');let calls=0;
 const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls++;assert.equal(d.phase,'review');assert.equal(d.member,'harness');return{text:JSON.stringify({status:'done',message:'原提交完成且文件应保留',summary:'独立核对',verification:['HEAD及内容已核对'],preserveMain:true,integrationFiles:['acceptance.json']})};}});
 await e.tick(f.group.id);assert.equal(calls,1);assert.equal(f.store.request(r.id).status,'completed');assert.equal(git(f.repo,'rev-parse','HEAD'),head);assert.equal(f.store.request(r.id).results['integrate:codex'].status,'done');
});

test('login clarification preserves partial task provenance while invalidating prior acceptance',t=>{
 const f=fixture(t);f.group.status='active';f.store.save(f.group);const {request:r}=f.store.input(f.group.id,{content:'实现内容入口'});f.group.activeRequestId=r.id;f.store.save(f.group);r.workBaselines={codex:f.before};r.workCandidates={codex:{targets:{old:'hash'}}};r.integrationScope={revision:r.revision};r.integrationReadyReceipt={revision:r.revision};f.store.saveRequest(r);
 fs.writeFileSync(path.join(f.peer,'anonymous.py'),'saved anonymous implementation');
 f.store.input(f.group.id,{content:'允许隔离登录态验收，登录由我操作',mode:'supplement'});const after=f.store.request(r.id);
 assert.deepEqual(after.workBaselines.codex,f.before);assert.equal(after.workCandidates,undefined);assert.equal(after.integrationReadyReceipt,undefined);
 fs.writeFileSync(path.join(f.peer,'login.py'),'isolated login implementation');const delta=captureWorkDelta(f.group,'codex',after.workBaselines.codex);assert.deepEqual(Object.keys(delta.targets).sort(),['anonymous.py','login.py']);
 const fresh=f.store.input(f.group.id,{content:'独立的新需求',mode:'new'});assert.equal(fresh.request.workBaselines,undefined);
});


test('closure retains original sources and rejects changed or ignored files',t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.peer,'module.py'),'module');fs.writeFileSync(path.join(f.peer,'fixture.json'),'{}');fs.writeFileSync(path.join(f.peer,'.gitignore'),'.session/\n');fs.mkdirSync(path.join(f.peer,'.session'));fs.writeFileSync(path.join(f.peer,'.session','state.bin'),'private');
 const old=captureIntegrationScope(f.group,'codex',['module.py'],0),before={codex:captureWorkBaseline(f.group,'codex')};
 const scope=captureReviewedClosure(f.group,{codex:['module.py','fixture.json']},before,old,0);assert.equal(Object.keys(scope.members.codex).length,2);
 assert.throws(()=>captureReviewedClosure(f.group,{codex:['fixture.json']},before,old,0),/omit/);
 assert.throws(()=>captureReviewedClosure(f.group,{codex:['module.py','.session/state.bin']},before,old,0),/not captured/);
 fs.writeFileSync(path.join(f.peer,'fixture.json'),'changed');assert.throws(()=>captureReviewedClosure(f.group,{codex:['module.py','fixture.json']},before,old,0),{reason:'main_conflict'});
});

test('blocked integration receives independent closure review without touching main',async t=>{
 const f=fixture(t);fs.writeFileSync(path.join(f.peer,'module.py'),'module');fs.writeFileSync(path.join(f.peer,'fixture.json'),'{}');f.group.status='active';f.store.save(f.group);
 const {request:r}=f.store.input(f.group.id,{content:'实现完整模块并整合'});f.group.activeRequestId=r.id;f.group.status='blocked';f.store.save(f.group);
 r.phase='execution';r.status='blocked';r.agreement={owner:'codex',integrator:'codex',review:true};r.actions=[{phase:'integrate',member:'codex'}];r.integrationScope=captureIntegrationScope(f.group,'codex',['module.py'],r.revision);r.integrationCheck=integrationPreflight(f.group,null,r.integrationScope);
 const id=randomUUID();const raw=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,content:JSON.stringify({status:'blocked',message:'固定清单缺少fixture.json',summary:'缺少必要依赖',verification:['主项目未变']}),protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id}});
 f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,status:'received',responseMessageId:raw.id});r.results={'integrate:codex':{status:'blocked',messageId:raw.id}};r.error='清单缺少';f.store.saveRequest(r);let calls=0;
 const e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls++;assert.equal(d.phase,'review');assert.equal(d.member,'harness');return{text:JSON.stringify({status:'done',message:'已核对依赖完整',summary:'补入夹具',verification:['module依赖fixture，源树已核对'],integrationFilesByMember:{codex:['module.py','fixture.json']}})};}});
 await e.tick(f.group.id);const after=f.store.request(r.id);assert.equal(calls,1);assert.equal(after.status,'active');assert.deepEqual(Object.keys(after.integrationScope.members.codex).sort(),['fixture.json','module.py']);assert.equal(after.actions[0].phase,'integrate');assert.equal(fs.existsSync(path.join(f.repo,'module.py')),false);
 after.integrationCheck=integrationPreflight(f.group,null,after.integrationScope);fs.copyFileSync(path.join(f.peer,'module.py'),path.join(f.repo,'module.py'));
 const id2=randomUUID(),raw2=f.store.message(f.group.id,{sender:'codex',channel:'group',requestId:r.id,content:JSON.stringify({status:'blocked',message:'scope missing another required source'}),protocol:true,origin:{adapter:'codex-reply',sessionId:'ct',messageId:id2}});
 // Only exact already-selected partial writes qualify; unrelated edits do not.
 f.store.saveDelivery({id:id2,groupId:f.group.id,requestId:r.id,phase:'integrate',member:'codex',revision:r.revision,epoch:f.group.epoch,status:'received',responseMessageId:raw2.id});after.results['integrate:codex']={status:'blocked',messageId:raw2.id};after.status='blocked';
 fs.writeFileSync(path.join(f.repo,'unrelated'),'other');assert.equal(e.repairIntegrationClosure(f.group,after),false);fs.unlinkSync(path.join(f.repo,'unrelated'));
 assert.equal(e.repairIntegrationClosure(f.group,after),true);assert.equal(after.scopeClosureRepair.attempt,2);after.actions.shift();assert.equal(e.repairIntegrationClosure(f.group,after),false);
});
