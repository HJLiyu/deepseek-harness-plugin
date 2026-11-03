import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {fileHash} from '../src/project-files.mjs';
import {captureRetentionReview,importRetentionHistory,settleRetentionConsent} from '../src/artifact-policy.mjs';
import {captureWorkBaseline,captureWorkDelta,captureIntegrationScope,captureIntegrationConsent,integrationPreflight,verifyIntegration} from '../src/group-integration.mjs';

const git=(repo,...args)=>execFileSync('git',['-C',repo,...args],{stdio:'pipe'}).toString().trim();
const reply=v=>({text:JSON.stringify({status:'done',message:'verified',summary:'verified',verification:['fixture bytes checked'],...v})});
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'artifact-policy-')),repo=path.join(dir,'repo'),peer=path.join(dir,'peer');fs.mkdirSync(repo);git(repo,'init');fs.writeFileSync(path.join(repo,'base.py'),'base');git(repo,'add','.');git(repo,'-c','user.name=Test','-c','user.email=test@example.com','-c','commit.gpgsign=false','commit','-m','base');const commit=git(repo,'rev-parse','HEAD');git(repo,'worktree','add','--detach',peer,commit);
 for(const root of [repo,peer])fs.writeFileSync(path.join(root,'retained.sqlite'),'original database bytes');
 const file=path.join(dir,'groups.sqlite'),f={dir,repo,peer,file,store:new GroupStore(file)};t.after(()=>{f.store.close();fs.rmSync(dir,{recursive:true,force:true,maxRetries:3})});
 f.group=f.store.create({repo,models:{codex:{},harness:{}}});Object.assign(f.group,{status:'active',contexts:{codex:'c',harness:'h'},worktrees:{codex:peer,harness:peer},initialized:{codex:true,harness:true},baseline:{commit}});f.store.save(f.group);return f;
}
function demand(f,actions){
 const {request:r}=f.store.input(f.group.id,{content:'implement authorized next phase'});Object.assign(r,{status:'active',phase:'execution',agreement:{owner:'codex',integrator:'codex',review:true,tasks:{codex:'implementation',harness:'review'}},actions});f.group=f.store.group(f.group.id);f.group.activeRequestId=r.id;f.group.status='active';f.store.save(f.group);f.store.saveRequest(r);return r;
}
function nativeResult(f,r,phase,member,value,valid=true){
 const id=randomUUID(),raw=f.store.message(f.group.id,{sender:member,channel:'group',requestId:r.id,protocol:true,origin:{adapter:member+'-reply',sessionId:f.group.contexts[member],messageId:id},content:JSON.stringify(value)});
 f.store.saveDelivery({id,groupId:f.group.id,requestId:r.id,status:'received',phase,member,revision:r.revision,epoch:f.group.epoch,responseMessageId:valid?raw.id:'wrong'});r.results[phase+':'+member]={...value,messageId:raw.id};return raw;
}

test('retention declared in an ordinary readiness review survives completion and restart across three demands',async t=>{
 const f=fixture(t),r1=demand(f,[{phase:'review',member:'harness',integrationReadiness:true},{phase:'integrate',member:'codex'}]);
 let e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>reply(d.phase==='review'?{preserveMain:true,integrationFiles:[],preservedFiles:['retained.sqlite']}:{})});
 await e.tick(f.group.id);await e.tick(f.group.id);assert.equal(f.store.request(r1.id).status,'completed');const original=fileHash(f.repo,'retained.sqlite');assert.equal(f.store.group(f.group.id).artifactPolicy.files['retained.sqlite'].hash,original);
 f.store.close();f.store=new GroupStore(f.file);f.group=f.store.group(f.group.id);
 for(const [index,change] of [['2',()=>fs.writeFileSync(path.join(f.peer,'retained.sqlite'),'')],['3',()=>fs.unlinkSync(path.join(f.peer,'retained.sqlite'))]]){
   const feature='phase'+index+'.py',r=demand(f,[{phase:'work',member:'codex'},{phase:'integrate',member:'codex'}]);
   e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{
     if(d.phase==='work'){change();fs.writeFileSync(path.join(f.peer,feature),'feature'+index);}
     else{const selected=JSON.parse(d.prompt).integrationSelection.members.codex;assert.equal(Object.hasOwn(selected,'retained.sqlite'),false);fs.copyFileSync(path.join(f.peer,feature),path.join(f.repo,feature));}
     return reply({});
   }});
   await e.tick(f.group.id);const work=f.store.request(r.id);assert.equal(Object.hasOwn(work.integrationScope.members.codex,'retained.sqlite'),false);assert.ok(work.workCandidates.codex.retainedChanges['retained.sqlite']);
   await e.tick(f.group.id);assert.equal(f.store.request(r.id).status,'completed');assert.equal(fileHash(f.repo,'retained.sqlite'),original);
 }
});

test('history migration requires accepted native review plus coordinator snapshot, not paths or prose alone',t=>{
 const f=fixture(t),r=demand(f,[]),hash=fileHash(f.repo,'retained.sqlite');r.status='completed';r.integrationCheck={before:{'retained.sqlite':hash},expected:{}};nativeResult(f,r,'review','harness',{status:'done',preservedFiles:['retained.sqlite','invented.sqlite']});f.store.saveRequest(r);
 assert.equal(importRetentionHistory(f.store,f.group),true);assert.equal(f.group.artifactPolicy.files['retained.sqlite'].hash,hash);assert.equal(Object.hasOwn(f.group.artifactPolicy.files,'invented.sqlite'),false);assert.equal(importRetentionHistory(f.store,f.group),false);
 const g={...f.group,artifactPolicy:undefined};r.results['review:harness'].status='changes_requested';f.store.saveRequest(r);importRetentionHistory(f.store,g);assert.deepEqual(g.artifactPolicy.files,{});
});

test('an unbound historical review cannot seed retention',t=>{
 const f=fixture(t),r=demand(f,[]);r.status='completed';r.integrationCheck={before:{'retained.sqlite':fileHash(f.repo,'retained.sqlite')},expected:{}};nativeResult(f,r,'review','harness',{status:'done',preservedFiles:['retained.sqlite']},false);f.store.saveRequest(r);importRetentionHistory(f.store,f.group);assert.deepEqual(f.group.artifactPolicy.files,{});
});

test('retained local data cannot re-enter candidate scope; actual main changes still block',t=>{
 const f=fixture(t),before=captureWorkBaseline(f.group,'codex');f.group.artifactPolicy=captureRetentionReview(f.group,['retained.sqlite'],before,{requestId:'r',messageId:'review'});fs.writeFileSync(path.join(f.peer,'retained.sqlite'),'test output');
 const d=captureWorkDelta(f.group,'codex',before);assert.deepEqual(d.targets,{});assert.ok(d.retainedChanges['retained.sqlite']);const scope=captureIntegrationScope(f.group,'codex',['retained.sqlite'],0);assert.throws(()=>integrationPreflight(f.group,null,scope),{reason:'main_conflict'});
 fs.writeFileSync(path.join(f.repo,'retained.sqlite'),'human modification');assert.throws(()=>integrationPreflight(f.group,null,{members:{codex:{}},revision:0}),{reason:'main_conflict'});assert.throws(()=>captureRetentionReview(f.group,['retained.sqlite'],captureWorkBaseline(f.group,'codex'),{}),{reason:'main_conflict'});
});

test('exact existing human overwrite consent can update one retained file without broadening policy',t=>{
 const f=fixture(t),before=captureWorkBaseline(f.group,'codex');f.group.artifactPolicy=captureRetentionReview(f.group,['retained.sqlite'],before,{requestId:'r',messageId:'review'});fs.writeFileSync(path.join(f.peer,'retained.sqlite'),'authorized replacement');
 const consent=captureIntegrationConsent(f.group,{member:'codex',files:['retained.sqlite'],sourceMessageId:'human',requestId:'r',revision:0}),check=integrationPreflight(f.group,consent,{members:{codex:{}}});fs.copyFileSync(path.join(f.peer,'retained.sqlite'),path.join(f.repo,'retained.sqlite'));check.verified=verifyIntegration(f.repo,check);settleRetentionConsent(f.group,{id:'r',integrationConsent:consent,integrationCheck:check});assert.equal(f.group.artifactPolicy.files['retained.sqlite'].hash,fileHash(f.repo,'retained.sqlite'));assert.equal(f.group.artifactPolicy.files['retained.sqlite'].sourceMessageId,'human');
});

test('legacy nonempty or truncated artifact candidates get independent scope repair without asking again',async t=>{
 const f=fixture(t),before=captureWorkBaseline(f.group,'codex');f.group.artifactPolicy=captureRetentionReview(f.group,['retained.sqlite'],before,{requestId:'old',messageId:'old-review'});f.group.artifactPolicy.historyImported=true;f.store.save(f.group);
 fs.writeFileSync(path.join(f.peer,'retained.sqlite'),'');fs.writeFileSync(path.join(f.peer,'feature.py'),'new');const r=demand(f,[{phase:'integrate',member:'codex'}]);r.status='blocked';r.integrationScope=captureIntegrationScope(f.group,'codex',['retained.sqlite','feature.py'],r.revision);r.integrationScope.bases={codex:{'retained.sqlite':before.main['retained.sqlite'],'feature.py':null}};r.integrationCheck=integrationPreflight({...f.group,artifactPolicy:undefined},null,r.integrationScope);nativeResult(f,r,'integrate','codex',{status:'blocked',message:'retained candidate conflict'});f.store.saveRequest(r);f.group.status='blocked';f.store.save(f.group);
 const calls=[],e=new GroupEngine(f.store,{appOpen:async()=>true,turn:async(_g,d)=>{calls.push(d.phase);assert.equal(d.phase,'review');return reply({integrationFiles:['feature.py'],integrationFilesByMember:{codex:['feature.py']},preservedFiles:['retained.sqlite']});}});
 await e.tick(f.group.id);const after=f.store.request(r.id);assert.deepEqual(calls,['review']);assert.equal(after.status,'active');assert.equal(after.actions[0].phase,'integrate');assert.ok(after.retentionRepair.originalScope.targets['retained.sqlite']);assert.equal(Object.hasOwn(after.integrationScope.members.codex,'retained.sqlite'),false);assert.equal(after.humanDecisions?.length??0,0);
});
