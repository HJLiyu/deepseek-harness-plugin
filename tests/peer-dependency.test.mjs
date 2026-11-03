import test from 'node:test';
import assert from 'node:assert/strict';
import {GroupStore} from '../src/group-store.mjs';
import {GroupEngine} from '../src/group-engine.mjs';
import {groupActivity} from '../src/group-service.mjs';
function fixture(t){
 const store=new GroupStore(':memory:');t.after(()=>store.close());const group=store.create({repo:process.cwd(),models:{codex:{},harness:{}}});group.contexts={codex:'ct',harness:'ht'};group.worktrees={codex:process.cwd(),harness:process.cwd()};group.status='awaiting_review';
 const {request}=store.input(group.id,{content:'实现并验收离线M0'});group.activeRequestId=request.id;store.save(group);
 request.phase='execution';request.status='awaiting_review';request.agreement={owner:'both',integrator:'codex',review:true};request.actions=[{phase:'work',member:'harness',task:'交付验收文件'},{phase:'review',member:'harness'},{phase:'integrate',member:'codex'}];request.deferred=[{phase:'work',member:'codex',task:'实现核心并对接验收',why:'blocked',reason:'等待队友验收文件'}];request.results={'work:codex':{status:'blocked',messageId:'old-result'}};store.saveRequest(request);return {store,group,request};
}
test('peer dependency is diagnosed read-only then provider runs and consumer resumes',async t=>{
 const {store,group,request}=fixture(t),calls=[];const e=new GroupEngine(store,{appOpen:async()=>true,turn:async(_g,d)=>{
  const p=JSON.parse(d.prompt);calls.push({member:d.member,phase:d.phase,p});
  return {text:JSON.stringify({message:'已核实',summary:'有证据',verification:['本轮检查通过'],status:'done',...(p.assignment.dependencyCheck?{waitingFor:'harness',dependencyReady:true}:{})})};
 }});
 await e.tick(group.id);assert.equal(calls[0].phase,'review');assert.equal(calls[0].member,'codex');assert.match(calls[0].p.instruction,/不执行或重做/);
 await e.tick(group.id);assert.equal(calls[1].member,'harness');assert.equal(calls[1].phase,'work');assert.match(calls[1].p.instruction,/不要反过来等待/);
 const r=store.request(request.id);assert.equal(r.actions[0].member,'codex');assert.equal(r.deferred.length,0);assert.equal(r.actions[0].resumeAfterDependency.previousResult,'old-result');
 await e.tick(group.id);assert.equal(calls[2].member,'codex');assert.match(calls[2].p.instruction,/不从头重做/);
});
test('a true external blocker stops after one dependency diagnosis',async t=>{
 const {store,group,request}=fixture(t);let calls=0;const e=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{calls++;return{text:JSON.stringify({status:'blocked',message:'缺少真人授权',summary:'需要授权',verification:['已核对']})}}});
 await e.tick(group.id);await e.tick(group.id);assert.equal(calls,1);assert.equal(store.request(request.id).status,'blocked');assert.equal(store.request(request.id).deferred.length,1);
});

test('retry preserves an existing dependency diagnosis instead of requeueing the blocked work',t=>{
 const {store,group,request}=fixture(t);request.actions.unshift({phase:'review',member:'codex',dependencyCheck:{waitingFor:'harness',consumer:'codex'}});request.status='blocked';store.saveRequest(request);
 const e=new GroupEngine(store,{});e.control(group.id,'retry');const r=store.request(request.id);assert.equal(r.actions[0].phase,'review');assert.equal(r.deferred.length,1);
});

test('active provider and waiting consumer are both explained in activity',t=>{
 const {store,group,request}=fixture(t);group.status='active';store.save(group);request.status='active';request.deferred[0].why='dependency';request.deferred[0].waitingFor='harness';request.deliveryId='provider';store.saveRequest(request);store.saveDelivery({id:'provider',groupId:group.id,requestId:request.id,member:'harness',phase:'work',revision:request.revision,status:'pending',started:true});
 const e=new GroupEngine(store,{});e.running.set(group.id,new AbortController());const activity=groupActivity(store,e,group.id);assert.equal(activity.members[0].label,'等待队友成果');assert.equal(activity.members[1].state,'busy');assert.match(activity.detail,/自动接回/);
 const draining=groupActivity(store,e,group.id,{draining:true});assert.equal(draining.members[1].state,'busy');assert.match(draining.detail,/当前回合继续运行/);
});
