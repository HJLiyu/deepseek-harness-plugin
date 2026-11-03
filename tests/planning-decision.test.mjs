import test from 'node:test';
import assert from 'node:assert/strict';
import { GroupStore } from '../src/group-store.mjs';
import { GroupEngine } from '../src/group-engine.mjs';
import { groupActivity } from '../src/group-service.mjs';

function fixture(t) {
 const store=new GroupStore(':memory:');t.after(()=>store.close());
 const group=store.create({repo:process.cwd(),models:{codex:{},harness:{}}});group.status='active';group.contexts={codex:'ct',harness:'ht'};store.save(group);
 const {request}=store.input(group.id,{content:'开始M0离线实现'});
 const p={message:'继续',summary:'继续已授权任务',owner:'both',integrator:'codex',tasks:{codex:'实现',harness:'测试'},review:true};
 request.plans={codex:structuredClone(p),harness:{...p,decision:{question:'当前不需要你操作；我们完成后汇报',options:['按此推进M0','回到方案']}}};
 return {store,group,request,p};
}
test('contradictory no-action decision receives one bounded planning correction',t=>{
 const {store,group,request,p}=fixture(t);const e=new GroupEngine(store,{});
 e.converge(group,request);assert.equal(request.status,'queued');assert.ok(request.plans.codex);assert.equal(request.plans.harness,undefined);
 assert.match(request.planningCorrections.harness.instruction,/不执行工作/);
 request.plans.harness={...p,decision:{question:'当前不需要你操作',options:['继续','暂停']}};
 e.converge(group,request);assert.equal(request.status,'blocked');assert.match(request.error,/没有真人审批/);
});
test('real permissions and substantive choices remain human-owned',t=>{
 const {store,group,request}=fixture(t);const e=new GroupEngine(store,{});
 request.plans.harness.decision.question='是否允许调用付费接口？';
 e.converge(group,request);assert.equal(request.status,'needs_decision');assert.equal(request.planningCorrections,undefined);
});
test('persisted false decision resumes by correcting the original member, with no work execution',async t=>{
 const {store,group,request,p}=fixture(t);let called;
 request.status='needs_decision';group.status='needs_decision';group.activeRequestId=request.id;store.saveRequest(request);store.save(group);
 const e=new GroupEngine(store,{appOpen:async()=>true,turn:async(_g,d)=>{called=structuredClone(d);return {text:JSON.stringify({...p,decision:null})};}});
 await e.tick(group.id);assert.equal(called.member,'harness');assert.equal(called.phase,'planning');
 assert.ok(JSON.parse(called.prompt).planningCorrection);assert.equal(store.request(request.id).status,'active');
 assert.equal(store.requests(group.id).length,1);
});

test('invalid planning JSON is corrected once without replaying work',async t=>{
 const {store,group,request,p}=fixture(t);delete request.plans.harness;store.saveRequest(request);group.activeRequestId=request.id;store.save(group);
 let calls=0;const e=new GroupEngine(store,{appOpen:async()=>true,turn:async(_g,d)=>{assert.equal(d.phase,'planning');calls++;return {text:calls===1?'invalid JSON':JSON.stringify(p)};}});
 await e.tick(group.id);let r=store.request(request.id);assert.equal(r.status,'queued');assert.ok(r.planningProtocolCorrections.harness);
 await e.tick(group.id);assert.equal(store.request(request.id).status,'active');assert.equal(calls,2);
});
test('persistent invalid JSON stops after one correction',async t=>{
 const {store,group,request}=fixture(t);delete request.plans.harness;store.saveRequest(request);group.activeRequestId=request.id;store.save(group);
 let calls=0;const e=new GroupEngine(store,{appOpen:async()=>true,turn:async()=>{calls++;return {text:'invalid JSON'};}});
 await e.tick(group.id);await e.tick(group.id);await e.tick(group.id);assert.equal(calls,2);assert.equal(store.request(request.id).status,'blocked');
});

test('a real writer permission blocker identifies the correct chat and responsible person',t=>{
 const {store,group,request}=fixture(t);group.title='肥鱼';group.activeRequestId=request.id;group.status='blocked';store.save(group);
 request.status='blocked';request.error='原生会话最近一轮为 read-only，当前阶段需要 workspace-write';store.saveRequest(request);
 const a=groupActivity(store,new GroupEngine(store,{}),group.id);
 assert.equal(a.needsUser,true);assert.match(a.detail,/肥鱼 · Codex/);assert.equal(a.members[0].label,'需要工作区写权限');assert.equal(a.members[1].state,'waiting');
});

test('quota failure shows the native retry hint rather than permission or approval guidance',t=>{
 const {store,group,request}=fixture(t);group.activeRequestId=request.id;group.status='blocked';store.save(group);
 request.status='blocked';request.nativeFailure={kind:'usage_limit',message:'try again at 8:40 PM.'};store.saveRequest(request);
 const a=groupActivity(store,new GroupEngine(store,{}),group.id);assert.equal(a.needsUser,false);assert.equal(a.members[0].label,'Codex 额度不足');assert.match(a.detail,/8:40 PM/);assert.match(a.detail,/没有自动续跑计时器/);
});
