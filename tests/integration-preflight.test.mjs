import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { captureIntegrationConsent, captureIntegrationScope, captureWorkBaseline, captureWorkDelta, captureReviewedIntegration, integrationPreflight } from '../src/group-integration.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const git = (root, ...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();

// Real git fixtures: these call the actual preflight instead of a hand-built Error,
// so they prove the diagnosis is derived from the checks that decide integration.
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'integration-diagnostics-'));
  const cleanup = {};
  t.after(() => { cleanup.store?.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
  const repo = path.join(dir, 'main'), member = path.join(dir, 'member');
  fs.mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@localhost');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.safecrlf', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'base');
  const baseline = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'worktree', 'add', '-b', 'member', member, baseline);
  return { dir, repo, member, baseline, cleanup };
}
const groupOf = (f, extra = {}) => ({ repo: f.repo, worktrees: { codex: f.member }, baseline: { commit: f.baseline }, ...extra });

test('normal integration still passes and is not turned into a failure by diagnostics', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'member\n');
  const check = integrationPreflight(groupOf(f));
  assert.equal(typeof check.expected['a.txt'], 'string');
  assert.equal(check.expected['a.txt'], sha('member\n'));
  // Nothing was written by the check itself.
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'base\n');
});

test('readiness review freezes the current main and candidate without granting unchecked overwrite',t=>{
 const f=fixture(t),g=groupOf(f);fs.writeFileSync(path.join(f.repo,'a.txt'),'current main\n');fs.writeFileSync(path.join(f.member,'a.txt'),'current main\nplus requested change\n');
 const before=captureWorkBaseline(g,'codex'),scope=captureReviewedIntegration(g,'codex',['a.txt'],before,4);
 assert.equal(scope.bases.codex['a.txt'],sha('current main\n'));assert.equal(integrationPreflight(g,undefined,scope).expected['a.txt'],sha('current main\nplus requested change\n'));
 assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'current main\n');
 fs.writeFileSync(path.join(f.repo,'a.txt'),'concurrent human edit\n');assert.throws(()=>captureReviewedIntegration(g,'codex',['a.txt'],before,4),{reason:'main_conflict'});assert.throws(()=>integrationPreflight(g,undefined,scope),{reason:'main_conflict'});
 fs.writeFileSync(path.join(f.repo,'a.txt'),'current main\n');fs.writeFileSync(path.join(f.member,'a.txt'),'changed candidate\n');assert.throws(()=>captureReviewedIntegration(g,'codex',['a.txt'],before,4),{reason:'main_conflict'});
});

test('a differing main file is still refused as main_conflict and left untouched', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'member\n');
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'human\n');
  assert.throws(() => integrationPreflight(groupOf(f)), error => {
    assert.equal(error.reason, 'main_conflict');
    assert.equal(error.details.technical.file, 'a.txt');
    assert.equal(error.details.technical.current, sha('human\n'));
    assert.equal(error.details.technical.wanted, sha('member\n'));
    assert.equal(error.details.technical.checkpointHasFile, false);
    assert.equal(typeof error.details.human.next, 'string');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'human\n');
});

test('continuous checkpoint still allows keeping main equal to the last integration product', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'previous-product\n');
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'next-product\n');
  const group = groupOf(f, { integrationState: { main: { 'a.txt': sha('previous-product\n') }, peers: {} } });
  const check = integrationPreflight(group);
  assert.equal(check.expected['a.txt'], sha('next-product\n'));
});

test('expired consent is refused with consent_expired and writes nothing', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'member\n');
  const group = groupOf(f);
  const consent = captureIntegrationConsent(group, { member: 'codex', files: ['a.txt'], sourceMessageId: 'm', requestId: 'r', revision: 0 });
  consent.expiresAt = Date.now() - 1;
  assert.throws(() => integrationPreflight(group, consent), error => {
    assert.equal(error.reason, 'consent_expired');
    assert.equal(error.details.technical.expiresAt, consent.expiresAt);
    assert.deepEqual(error.details.technical.files, ['a.txt']);
    assert.equal(error.details.technical.requestId, 'r');
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'base\n');
});

test('consent whose scope changed is refused with consent_files_changed', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'member\n');
  const group = groupOf(f);
  const consent = captureIntegrationConsent(group, { member: 'codex', files: ['a.txt'], sourceMessageId: 'm', requestId: 'r', revision: 0 });
  fs.writeFileSync(path.join(f.repo, 'a.txt'), 'changed-after-consent\n');
  assert.throws(() => integrationPreflight(group, consent), error => {
    assert.equal(error.reason, 'consent_files_changed');
    assert.equal(error.details.technical.before, sha('base\n'));
    assert.equal(error.details.technical.current, sha('changed-after-consent\n'));
    return true;
  });
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'changed-after-consent\n');
});

test('valid consent scopes the integration without relaxing the checks', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.member, 'a.txt'), 'member\n');
  const group = groupOf(f);
  const consent = captureIntegrationConsent(group, { member: 'codex', files: ['a.txt'], sourceMessageId: 'm', requestId: 'r', revision: 0 });
  const check = integrationPreflight(group, consent);
  assert.equal(check.expected['a.txt'], sha('member\n'));
  assert.equal(fs.readFileSync(path.join(f.repo, 'a.txt'), 'utf8'), 'base\n');
});

import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { integrationFailure, describeIntegrationFailure } from '../src/integration-diagnostics.mjs';

test('diagnostic file selection excludes unrelated old work without granting overwrite', t => {
 const f=fixture(t),g=groupOf(f);
 fs.writeFileSync(path.join(f.member,'a.txt'),'candidate\n');
 const scope=captureIntegrationScope(g,'codex',['a.txt'],0);
 fs.writeFileSync(path.join(f.member,'old.txt'),'old peer work');
 fs.writeFileSync(path.join(f.repo,'old.txt'),'new main work');
 const check=integrationPreflight(g,undefined,scope);assert.deepEqual(Object.keys(check.expected),['a.txt']);
 fs.writeFileSync(path.join(f.repo,'a.txt'),'human\n');
 assert.throws(()=>integrationPreflight(g,undefined,scope),{reason:'main_conflict'});
 g.integrationState={peers:{codex:{'a.txt':scope.targets['a.txt']}}};
 assert.throws(()=>integrationPreflight(g,undefined,scope),{reason:'main_conflict'});
 fs.writeFileSync(path.join(f.member,'a.txt'),'changed after diagnosis');
 assert.throws(()=>integrationPreflight(g,undefined,scope),e=>e.details.technical.kind==='candidate_changed_after_diagnosis');
 assert.throws(()=>captureIntegrationScope(g,'codex',['../outside'],0),{reason:'path_unsafe'});
});

test('preflight stall automatically dispatches one read-only diagnosis then completes scoped integration',async t=>{
 const f=fixture(t),e=engineFixture(t,f);
 fs.writeFileSync(path.join(f.member,'a.txt'),'candidate\n');
 fs.writeFileSync(path.join(f.member,'old.txt'),'old peer work');fs.writeFileSync(path.join(f.repo,'old.txt'),'new main work');
 const calls=[];
 e.engine.runtime.turn=async(g,d)=>{calls.push({...d});if(d.phase==='integrate')fs.copyFileSync(path.join(f.member,'a.txt'),path.join(f.repo,'a.txt'));return {text:JSON.stringify({message:'核对本次范围',summary:'保留历史改动',status:'done',verification:['实际核对文件'],integrationFiles:['a.txt']})}};
 await e.engine.tick(e.group.id);let r=e.store.request(e.request.id);
 assert.equal(r.status,'active');assert.ok(r.actions[0].diagnostic);assert.equal(calls.length,0);
 await e.engine.tick(e.group.id);assert.equal(calls[0].phase,'review');assert.match(JSON.parse(calls[0].prompt).instruction,/只读整合排查/);
 await e.engine.tick(e.group.id);r=e.store.request(r.id);assert.equal(r.status,'completed');assert.equal(calls.length,2);
 assert.equal(fs.readFileSync(path.join(f.repo,'old.txt'),'utf8'),'new main work');
});

test('a real conflict after automatic diagnosis stops clearly and never loops or overwrites',async t=>{
 const f=fixture(t),e=engineFixture(t,f);fs.writeFileSync(path.join(f.repo,'a.txt'),'human\n');fs.writeFileSync(path.join(f.member,'a.txt'),'candidate\n');let calls=0;
 e.engine.runtime.turn=async()=>{calls++;return {text:JSON.stringify({message:'存在真实差异',summary:'需要决定保留哪版',status:'done',verification:['核对文件'],integrationFiles:['a.txt']})}};
 for(let i=0;i<6;i++)await e.engine.tick(e.group.id);
 const r=e.store.request(e.request.id);assert.equal(calls,1);assert.equal(r.status,'blocked');assert.equal(r.errorDetails.human.needsUser,true);assert.match(r.errorDetails.human.next,/自动执行已停止/);assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'human\n');
});

test('diagnosis requesting ordinary repairs automatically schedules work and independent review',async t=>{
 const f=fixture(t),e=engineFixture(t,f);fs.writeFileSync(path.join(f.repo,'a.txt'),'human\n');fs.writeFileSync(path.join(f.member,'a.txt'),'candidate\n');
 e.engine.runtime.turn=async()=>({text:JSON.stringify({message:'先在工作树保留主项目新逻辑再复核',summary:'普通修复',status:'changes_requested',verification:['核对 diff']})});
 await e.engine.tick(e.group.id);await e.engine.tick(e.group.id);
 const r=e.store.request(e.request.id);assert.equal(r.status,'active');assert.deepEqual(r.actions.map(a=>[a.phase,a.member]),[['work','codex'],['review','harness'],['integrate','codex']]);assert.match(r.actions[0].repair.findings,/保留主项目/);
});

test('per-request delta excludes old peer work and uses an aligned new main baseline',t=>{
 const f=fixture(t),g=groupOf(f);
 fs.writeFileSync(path.join(f.repo,'a.txt'),'new main baseline\n');fs.writeFileSync(path.join(f.member,'a.txt'),'new main baseline\n');
 fs.writeFileSync(path.join(f.repo,'old.txt'),'main old feature');fs.writeFileSync(path.join(f.member,'old.txt'),'unintegrated historic feature');
 const baseline=captureWorkBaseline(g,'codex');fs.writeFileSync(path.join(f.member,'a.txt'),'new task result\n');
 const delta=captureWorkDelta(g,'codex',baseline),scope={members:{codex:delta.targets},bases:{codex:delta.bases}};
 assert.deepEqual(Object.keys(delta.targets),['a.txt']);assert.equal(delta.bases['a.txt'],sha('new main baseline\n'));
 assert.deepEqual(Object.keys(integrationPreflight(g,undefined,scope).expected),['a.txt']);
 fs.writeFileSync(path.join(f.repo,'a.txt'),'concurrent human edit\n');assert.throws(()=>integrationPreflight(g,undefined,scope),{reason:'main_conflict'});
});

test('a stale starting worktree gains no new baseline or overwrite authority from request delta',t=>{
 const f=fixture(t),g=groupOf(f);fs.writeFileSync(path.join(f.repo,'a.txt'),'human main\n');
 const baseline=captureWorkBaseline(g,'codex');fs.writeFileSync(path.join(f.member,'a.txt'),'changed stale peer\n');
 const delta=captureWorkDelta(g,'codex',baseline);assert.equal(Object.keys(delta.bases).length,0);
 assert.throws(()=>integrationPreflight(g,undefined,{members:{codex:delta.targets},bases:{codex:delta.bases}}),{reason:'main_conflict'});
});

test('verification-only work proceeds with an empty request delta despite historical peer conflicts',async t=>{
 const f=fixture(t),e=engineFixture(t,f);fs.writeFileSync(path.join(f.repo,'old.txt'),'main old feature');fs.writeFileSync(path.join(f.member,'old.txt'),'historic peer conflict');
 const r=e.request;r.actions.unshift({phase:'work',member:'codex',task:'read-only verify'});e.store.saveRequest(r);
 const calls=[];e.engine.runtime.turn=async(g,d)=>{calls.push(d.phase);return {text:JSON.stringify({status:'done',message:'read-only verification done',summary:'verified',verification:['checked files']})}};
 await e.engine.tick(e.group.id);let after=e.store.request(r.id);assert.deepEqual(after.integrationScope.members.codex,{});
 await e.engine.tick(e.group.id);after=e.store.request(r.id);assert.equal(after.status,'completed');assert.deepEqual(calls,['work','integrate']);assert.equal(after.workBaselines,undefined);assert.equal(after.workCandidates,undefined);
 assert.equal(fs.readFileSync(path.join(f.repo,'old.txt'),'utf8'),'main old feature');assert.deepEqual(after.integrationCheck.verified,{});
 const scope=captureIntegrationScope(e.group,'codex',[],0);assert.deepEqual(integrationPreflight(e.group,undefined,scope).expected,{});
});
function engineFixture(t,f) {
 const store=new GroupStore(path.join(f.dir,'groups.sqlite'));f.cleanup.store=store;
 const group=store.create({repo:f.repo,models:{codex:{model:'c'},harness:{model:'h'}}});
 group.status='idle';group.contexts={codex:'ct',harness:'ht'};group.initialized={codex:true,harness:true};group.worktrees={codex:f.member,harness:f.member};group.baseline={commit:f.baseline};store.save(group);
 const request=store.input(group.id,{content:'integrate fixture',origin:{adapter:'test',sessionId:'s',messageId:'m'}}).request;
 request.phase='execution';request.status='active';request.actions=[{phase:'integrate',member:'codex'}];request.agreement={owner:'codex',integrator:'codex',review:false,tasks:{codex:'',harness:''}};store.saveRequest(request);group.activeRequestId=request.id;store.save(group);
 let calls=0;const engine=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{calls++;return {text:JSON.stringify({message:'done',status:'done',summary:'done',verification:['fixture']})}}});
 return {store,group,request,engine,calls:()=>calls};
}
test('engine persists bound diagnostics and supplement/retry remove them', async t=>{
 const f=fixture(t),e=engineFixture(t,f);e.request.integrationDiagnosisRevision=e.request.revision;e.store.saveRequest(e.request);fs.writeFileSync(path.join(f.repo,'a.txt'),'human\n');fs.writeFileSync(path.join(f.member,'a.txt'),'member\n');
 await e.engine.tick(e.group.id);let r=e.store.request(e.request.id);assert.equal(e.calls(),0);assert.equal(r.errorDetails.reason,'main_conflict');assert.equal(r.errorDetails.binding.requestId,r.id);assert.equal(r.errorDetails.binding.revision,r.revision);
 e.engine.control(e.group.id,'retry');assert.equal(e.store.request(r.id).errorDetails,undefined);
 await e.engine.tick(e.group.id);assert.ok(e.store.request(r.id).errorDetails);
 e.store.input(e.group.id,{content:'new revision',mode:'supplement',origin:{adapter:'test',sessionId:'s',messageId:'new'}});r=e.store.request(r.id);assert.equal(r.errorDetails,undefined);assert.equal(r.error,undefined);
});
test('stale consent does not block an otherwise safe integration; success clears diagnostics',async t=>{
 const f=fixture(t),e=engineFixture(t,f);const r=e.request;
 r.integrationConsent={requestId:r.id,revision:r.revision-1,expiresAt:0,targets:{}};e.store.saveRequest(r);
 await e.engine.tick(e.group.id);const after=e.store.request(r.id);assert.equal(e.calls(),1);assert.equal(after.status,'completed');assert.equal(after.errorDetails,undefined);
});
test('stale consent cannot authorize a real conflict and is retained only as diagnostic context',async t=>{
 const f=fixture(t),e=engineFixture(t,f);fs.writeFileSync(path.join(f.repo,'a.txt'),'human\n');fs.writeFileSync(path.join(f.member,'a.txt'),'member\n');
 const r=e.request;r.integrationDiagnosisRevision=r.revision;r.integrationConsent={requestId:r.id,revision:r.revision-1,expiresAt:Date.now()+60000,targets:{'a.txt':{before:sha('human\n'),wanted:sha('member\n')}}};e.store.saveRequest(r);
 await e.engine.tick(e.group.id);const after=e.store.request(r.id);assert.equal(e.calls(),0);assert.equal(after.errorDetails.reason,'main_conflict');assert.equal(after.errorDetails.technical.staleConsent.currentRevision,r.revision);assert.equal(fs.readFileSync(path.join(f.repo,'a.txt'),'utf8'),'human\n');
});
test('post-integration verification failure persists typed diagnosis instead of claiming success',async t=>{
 const f=fixture(t),e=engineFixture(t,f);fs.writeFileSync(path.join(f.member,'a.txt'),'member\n');
 await e.engine.tick(e.group.id);const r=e.store.request(e.request.id);assert.equal(r.status,'blocked');assert.equal(r.errorDetails.reason,'verification_mismatch');assert.equal(r.errorDetails.technical.file,'a.txt');assert.equal(r.errorDetails.technical.inScope,true);
});
