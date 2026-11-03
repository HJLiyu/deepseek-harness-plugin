import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {companionBuildHash} from '../companion/build.mjs';

// Presentation only: this module never decides permissions or dispatches work.
export function explainState(record = {}) {
 const status=record.status;
 let reason='状态尚未确认',next='先核对任务详情与原执行检查点。';
 if(status==='pending'||status==='awaiting_approval') {reason='有一条操作在等你的决定';next='需要你操作：在提示指定的原生会话发送该编号的批准或拒绝指令。';}
 else if(status==='rejected'){reason='这条操作已被拒绝';next='你现在不需要操作；如需重新执行，请重新提出需求。';}
 else if(status==='expired'){reason='旧审批已过期，不会复用';next='先核对当前要求与原执行检查点；未知结果不重放。';}
 else if(status==='cancelled'){
  const causes={connection_disconnected:'应用连接断开',execution_interrupted:'执行过程被打断',transport_timeout:'等待超时'};
  reason=(causes[record.cancelSource]||'原因尚未确认')+'；此编号已失效';
  next='核对原执行检查点与意图保留情况；不要重发旧编号，未知结果不重放。';
 }else if(status==='needs_recovery'||status==='unknown'){reason='原执行结果仍未确认';next='保留检查点，核对原回复；不派发替代执行，需要时按提示刷新连接。';}
 return {status,reason,next};
}
const hash=entries=>{const h=createHash('sha256');for(const [n,b]of entries)h.update(n).update(b);return h.digest('hex')};
export function diskEvidence(root){
 const read=n=>fs.readFileSync(path.join(root,n));
 const runtime=['group-worker.mjs','companion/approval-text.mjs',...fs.readdirSync(path.join(root,'src')).filter(n=>n.endsWith('.mjs')).map(n=>'src/'+n)].sort();
 const legacy=['group-worker.mjs','src/group-store.mjs','src/group-engine.mjs','src/group-runtime.mjs','src/group-permissions.mjs','src/group-http.mjs','src/group-service.mjs','src/codex.mjs','src/git.mjs','web/group.html'];
 return {runtimeHash:hash(runtime.map(n=>[n,read(n)])),buildHash:hash(legacy.map(n=>[n,read(n)])),adapterHash:companionBuildHash(path.join(root,'companion'))};
}
export function readiness(candidate={},installed={},running={}){
 const valid=v=>typeof v==='string'&&/^[a-f0-9]{64}$/i.test(v);
 const compare=(a,b)=>!valid(a)||!valid(b)?'unknown':a===b?'match':'mismatch';
 const layers={installed:compare(candidate.runtimeHash,installed.runtimeHash),runtime:compare(installed.runtimeHash,running.runtimeHash),page:compare(candidate.buildHash,running.buildHash),adapter:compare(candidate.adapterHash,running.adapterHash)};
 const state=Object.values(layers).includes('mismatch')?'mismatch':Object.values(layers).includes('unknown')?'unknown':'ready';
 return {state,layers,candidate,installed,running,message:state==='ready'?'已加载并生效':state==='unknown'?'尚未确认':'尚未生效',next:state==='ready'?'你现在不需要操作。':'由独立维护上下文核对候选与安装闭包，按正常更新协议加载并检查 applied 回执；页面不一致时刷新页面。'};
}
