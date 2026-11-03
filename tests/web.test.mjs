import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { randomUUID } from 'node:crypto';

function element() {
  const e = { value: '', textContent: '', children: [], style: {}, dataset: {}, hidden: false, disabled: false, scrollHeight: 500, scrollTop: 500, clientHeight: 300,
    append(...v) { this.children.push(...v); }, replaceChildren(...v) { this.children = v; }, matches: () => false, contains: () => false,
    setAttribute() {}, addEventListener() {}, scrollIntoView() {}, focus() {}, classList: { toggle() {} }, querySelectorAll: () => [] };
  Object.defineProperty(e, 'childElementCount', { get: () => e.children.length });
  e.elements = { namedItem: () => element() };
  e.showModal=function(){this.open=true;};e.close=function(){this.open=false;this.onclose?.();};
  e.querySelector = () => e.label ??= element();
  return e;
}
function defer() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const flush = () => new Promise(setImmediate);

test('workspace keeps existing controls and accessible responsive landmarks', () => {
  const html = fs.readFileSync(new URL('../web/group.html', import.meta.url), 'utf8');
  for (const id of ['groups','refresh','newGroup','settings','pause','resume','retry','settle','older','latest','text','sendButton','requestFilter','alertTokens','permissions']) assert.match(html, new RegExp('id="'+id+'"'));
  assert.match(html, /aria-label="协作概览"/); assert.match(html, /协作交流/);
  assert.match(html, /@media\(max-width:480px\)/); assert.match(html, /textarea:focus-visible/);
  assert.match(html, /awaiting_review:'等待依赖'/);
  const toolbar=html.match(/<nav class="toolbar">([\s\S]*?)<\/nav>/)[1], menu=toolbar.match(/<details id="threadMenu"([\s\S]*?)<\/details>/)[1];
  for (const id of ['pause','resume','showRequests']) { assert.match(toolbar,new RegExp('id="'+id+'"')); assert.doesNotMatch(menu,new RegExp('id="'+id+'"')); }
  assert.match(html, /<div id="aiIssue"[^>]*>[\s\S]*?id="settle"[\s\S]*?id="retry"/);
  for (const id of ['pause','resume','settle','retry','sendButton']) assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1);
  assert.match(html,/button,\.menu>summary,\.budget>summary\{min-height:40px\}/);
});

test('model management opens inside the workspace and preserves the current group draft',async()=>{
 const p=await page();p.type('keep my current group draft');p.get('openConnections').onclick();assert.equal(p.get('connectionsDialog').open,true);assert.equal(p.get('connectionsFrame').src,'/connections#test');assert.equal(p.get('text').value,'keep my current group draft');p.get('closeConnections').onclick();assert.equal(p.get('connectionsFrame').src,'about:blank');assert.equal(p.get('text').value,'keep my current group draft');
});

test('only the owned model frame can select a saved connection for a new group',async()=>{
 const id='12345678-1234-4234-8234-123456789012',p=await page(new Map(),{connectionCatalog:{connections:[{id,name:'test API',kind:'api',model:'test-model'}]},location:{pathname:'/g/aa',hash:'#test',origin:'http://127.0.0.1'}});
 const frame={};p.get('connectionsFrame').contentWindow=frame;p.get('createForm').elements.harnessModel.value='unchanged';
 p.context.handoff={origin:'https://evil.example',source:frame,data:{type:'model-connection:use',id}};await vm.runInContext('handleConnectionMessage(handoff)',p.context);assert.equal(p.get('createForm').elements.harnessModel.value,'unchanged');
 p.context.handoff={origin:'http://127.0.0.1',source:{},data:{type:'model-connection:use',id}};await vm.runInContext('handleConnectionMessage(handoff)',p.context);assert.equal(p.get('createForm').elements.harnessModel.value,'unchanged');
 p.context.handoff={origin:'http://127.0.0.1',source:frame,data:{type:'model-connection:use',id}};await vm.runInContext('handleConnectionMessage(handoff)',p.context);assert.equal(p.get('peerConnection').value,id);assert.equal(p.get('createForm').elements.harnessModel.value,'test-model');assert.equal(p.get('settingsDialog').open,true);assert.equal(p.get('approvalOwnerThreadId').required,true);assert.equal(p.state.inputs.length,0);
});

test('desktop answer sidebar and backdrop are direct children of the conversation grid', () => {
  const html = fs.readFileSync(new URL('../web/group.html', import.meta.url), 'utf8');
  const body = html.split('<body>')[1].split('<script>')[0];
  const stack = [], parents = new Map();
  const voids = new Set(['input', 'meta', 'link', 'hr', 'br', 'img', 'source', 'wbr']);
  for (const match of body.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    const tag = match[1].toLowerCase();
    if (match[0].startsWith('</')) { assert.equal(stack.pop()?.tag, tag); continue; }
    const id = /\bid="([^"]+)"/.exec(match[2])?.[1];
    if (id) parents.set(id, stack.at(-1)?.id);
    if (!voids.has(tag) && !match[0].endsWith('/>')) stack.push({ tag, id });
  }
  for (const id of ['answerPreview', 'previewBackdrop', 'threadContent']) assert.equal(parents.get(id), 'groupApp', id);
  assert.match(html, /\.app\.preview-open\{[^}]*grid-template-areas:'overview topbar preview'/);
});
async function page(storage = new Map(), browser = {}) {
  const html=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
  const formNames=new Map([...html.matchAll(/<form\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)].map(m=>[m[1],[...m[2].matchAll(/\bname="([^"]+)"/g)].map(x=>x[1])]));
  const elements = new Map(), get = id => {
    if (!elements.has(id)) {
      const e=element();for(const name of formNames.get(id)??[])e.elements[name]=element();
      const fallback=e.elements.namedItem;e.elements.namedItem=name=>e.elements[name]??fallback(name);
      elements.set(id,e);
    }
    return elements.get(id);
  };
  const tabs = ['group', 'collaboration'].map(channel => Object.assign(element(), { dataset: { channel } }));
  const group = id => ({ id, title: id, status: id === 'aa' ? 'idle' : 'paused', repo: '/' + id, contexts: {}, models: { codex: { model: 'c' }, harness: { model: 'h' } } });
  const state = { intercept: null, inputs: [] };
  const fetch = async (url, options) => {
    const route = url.slice(4); let data;
    if (state.intercept) data = await state.intercept(route, options);
    if (data === undefined) {
      if (route === '/projects/defaults') data = { projectsRoot: '/projects' };
      else if(route==='/connections')data=browser.connectionCatalog||{connections:[]};
      else if (route === '/groups') data = { groups: ['aa', 'bb'].map(group) };
      else if (/\/messages\?/.test(route)) data = { messages: [], nextCursor: 0 };
      else if (/\/input$/.test(route)) { state.inputs.push({ route, body: JSON.parse(options.body) }); data = {}; }
      else data = { group: group(route.split('/')[2]), requests: [], permissions: [], activity: { members: [], detail: '待命' } };
    }
    return { ok: true, json: async () => data };
  };
  const context = vm.createContext({ document: { documentElement: element(), getElementById: get, querySelectorAll: selector => selector === '[data-channel]' ? tabs : [], createElement: element, addEventListener() {}, activeElement: null },
    location: { pathname: '/g/aa', hash: '#test' }, history: { replaceState() {} }, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    fetch, crypto: { randomUUID }, AbortSignal, setInterval() {}, setTimeout() {}, clearTimeout() {}, navigator: {}, ...browser });
  let script = fs.readFileSync(new URL('../web/group.html', import.meta.url), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
  script = script.replace(/refresh\(\);\s*$/, 'globalThis.boot=refresh();');
  vm.runInContext(script, context); await context.boot;
  const change = async id => { get('groups').value = id; get('groups').onchange(); await flush(); };
  const type = value => { get('text').value = value; get('text').oninput(); };
  return { context, get, state, tabs, change, type, refresh: () => vm.runInContext('refresh()', context), storage };
}

test('expanded surfaces retain rounded inset boundaries on desktop and mobile', () => {
  const html = fs.readFileSync(new URL('../web/group.html', import.meta.url), 'utf8');
  assert.match(html, /dialog#settingsDialog\{[^}]*border-radius:var\(--radius-panel\)/);
  assert.match(html, /@media\(max-width:480px\)\{dialog#settingsDialog\{inset:8px/);
  assert.match(html, /\.panel-head\{[^}]*border-radius:var\(--radius-panel\) var\(--radius-panel\) 0 0/);
  assert.match(html, /\.budget-panel\{position:fixed;[^}]*max-height:calc\(100dvh - 24px\)/);
});

test('budget popover clamps offscreen anchors within viewport and repositions after resize', async () => {
  const p = await page(), style = {};
  const panel = { style, getBoundingClientRect: () => ({ width:260, height:140 }) };
  const anchor = { getBoundingClientRect: () => ({ left:900, top:1000 }) };
  p.context.popover = { open:true, querySelector: selector => selector === 'summary' ? anchor : panel };
  Object.assign(p.context, { innerWidth:1280, innerHeight:900 });
  vm.runInContext('placeBudgetPopover(popover)', p.context);
  assert.equal(style.left, '900px'); assert.equal(style.top, '748px');
  Object.assign(p.context, { innerWidth:390, innerHeight:844 });
  vm.runInContext('placeBudgetPopover(popover)', p.context);
  assert.equal(style.left, '118px'); assert.equal(style.top, '692px');
  anchor.getBoundingClientRect = () => ({ left:-80, top:-20 });
  vm.runInContext('placeBudgetPopover(popover)', p.context);
  assert.equal(style.left, '12px'); assert.equal(style.top, '12px');
  p.context.popover.open = false; style.left = 'untouched';
  vm.runInContext('placeBudgetPopover(popover)', p.context);
  assert.equal(style.left, 'untouched');
});

test('drafts stay with their group and channel and survive reload', async () => {
  const p = await page(); p.type('项目 A 草稿'); await p.change('bb');
  assert.equal(p.get('text').value, ''); p.type('项目 B 草稿');
  await p.change('aa'); assert.equal(p.get('text').value, '项目 A 草稿');
  p.tabs[1].onclick(); assert.equal(p.get('text').value, ''); p.type('协作补充');
  p.tabs[0].onclick(); assert.equal(p.get('text').value, '项目 A 草稿');
  const reloaded = await page(p.storage); assert.equal(reloaded.get('text').value, '项目 A 草稿');
});

test('awaiting dependencies has readable labels, overview and explicit retry access', async () => {
  const p = await page();
  p.state.intercept = route => route === '/groups/aa' ? { group: { id:'aa',title:'设计项目',status:'awaiting_review',activeRequestId:'r',models:{codex:{},harness:{}},contexts:{} },requests:[{id:'r',status:'awaiting_review',phase:'execution',actions:[{phase:'review'}],usage:{knownTokens:120},error:'等待独立复核'}],permissions:[] } : undefined;
  await p.refresh();
  assert.equal(p.get('status').textContent,'等待依赖'); assert.equal(p.get('overviewTask').textContent,'任务进行中');
  assert.equal(p.get('retry').disabled,false); assert.equal(p.get('aiIssue').hidden,false);
  assert.equal(p.get('retry').hidden,false); assert.equal(p.get('settle').hidden,true);
  assert.match(p.get('resume').title,/未暂停/);
  assert.equal(p.get('overviewPhase').textContent,'复核结果');
});

test('direct pause and resume controls dispatch once and explain disabled states', async () => {
  const p=await page(); let status='active'; const actions=[];
  p.state.intercept=(route,options)=>{
    if(route==='/groups/aa/control'){const action=JSON.parse(options.body).action; actions.push(action);status=action==='pause'?'paused':'active';return {};}
    if(route==='/groups/aa')return {group:{id:'aa',status,models:{codex:{},harness:{}}},requests:[],permissions:[]};
  };
  await p.refresh(); assert.equal(p.get('pause').disabled,false); assert.equal(p.get('resume').disabled,true);
  assert.match(p.get('resume').title,/未暂停/);
  await p.get('pause').onclick(); assert.equal(p.get('status').textContent,'已暂停');
  assert.equal(p.get('resume').disabled,false); assert.ok(p.get('pause').title);
  await p.get('resume').onclick(); assert.deepEqual(actions,['pause','resume']);
  assert.equal(p.get('status').textContent,'协作中');
});

test('Enter submits once while Shift+Enter and IME composition never submit', async () => {
  const p=await page(); p.type('键盘发送'); let submitted=0;
  p.get('sendForm').requestSubmit=()=>{submitted++;return p.get('sendForm').onsubmit({preventDefault(){}})};
  const key=(shiftKey,isComposing=false)=>({key:'Enter',shiftKey,isComposing,preventDefault(){}});
  p.get('text').onkeydown(key(true)); p.get('text').onkeydown(key(false,true));
  assert.equal(submitted,0); assert.equal(p.state.inputs.length,0);
  p.get('text').onkeydown(key(false)); await flush();
  assert.equal(submitted,1); assert.equal(p.state.inputs.length,1); assert.equal(p.get('text').value,'');
});

test('both channels default to server-resolved automatic routing as the active request changes', async () => {
  const p = await page(); assert.equal(p.get('mode').value, 'auto'); p.tabs[1].onclick(); assert.equal(p.get('mode').value, 'auto');
  p.type('请 DeepSeek 确认'); await p.get('sendForm').onsubmit({ preventDefault() {} });
  assert.equal(p.state.inputs[0].body.channel, 'collaboration'); assert.equal(p.state.inputs[0].body.mode, 'auto');
  p.state.intercept = route => route === '/groups/aa' ? { group: { id: 'aa', status: 'active', activeRequestId: 'r', models: { codex: {}, harness: {} } },
    requests: [{ id: 'r', status: 'active', phase: 'planning', usage: {} }], permissions: [] } : undefined;
  await p.refresh(); p.tabs[0].onclick(); p.tabs[1].onclick(); assert.equal(p.get('mode').value, 'auto');
});

test('collaboration shows historical peer outcomes with stage and reply context as plain text', async () => {
  const p = await page();
  p.state.intercept = route => route.includes('/messages?') ? { nextCursor: 3, messages: [
    { id: 'demand', seq: 1, sender: 'human', channel: 'group', content: '请确认方案' },
    { id: 'codex', seq: 2, sender: 'codex', channel: 'collaboration', content: JSON.stringify({ message: '提案' }), protocol: true, phase: 'planning', replyTo: 'demand' },
    { id: 'harness', seq: 3, sender: 'harness', channel: 'group', content: JSON.stringify({ message: '确认 <script>' }), protocol: true, phase: 'work', replyTo: 'codex' },
  ] } : undefined;
  await p.refresh(); p.tabs[1].onclick();
  const messages = p.get('messages').children;
  assert.equal(messages.length, 3);
  assert.ok(messages[2].children[0].children.some(e => e.textContent === '回应 Codex'));
  assert.equal(messages[2].children[1].textContent, '确认 <script>');
});

test('slow previous-group refresh cannot block or overwrite a new group', async () => {
  const p = await page(), slow = defer();
  p.state.intercept = route => route === '/groups/aa' ? slow.promise : undefined;
  const old = p.refresh(); await flush(); await p.change('bb');
  const newer = p.get('contexts').textContent;
  slow.resolve({ group: { id: 'aa', status: 'idle', models: { codex: {}, harness: {} } }, requests: [], permissions: [] }); await old;
  assert.equal(JSON.parse(newer).project, '/bb'); assert.equal(p.get('contexts').textContent, newer);
});

test('late send acknowledgement clears only the submitted draft and preserves another group input', async () => {
  const p = await page(), ack = defer(); p.type('相同文字');
  p.state.intercept = route => route === '/groups/aa/input' ? ack.promise : undefined;
  const sending = p.get('sendForm').onsubmit({ preventDefault() {} }); await flush();
  await p.change('bb'); p.type('相同文字'); ack.resolve({}); await sending;
  assert.equal(p.get('text').value, '相同文字'); await p.change('aa'); assert.equal(p.get('text').value, '');
});

test('retry after reload reuses the submitted input identity instead of dispatching a duplicate', async () => {
  const p = await page(); p.type('只执行一次'); let firstId;
  p.state.intercept = (route, options) => { if (route.endsWith('/input')) { firstId = JSON.parse(options.body).origin.messageId; throw Error('response lost after admission'); } };
  await p.get('sendForm').onsubmit({ preventDefault() {} });
  const reloaded = await page(p.storage); let retryId;
  reloaded.state.intercept = (route, options) => { if (route.endsWith('/input')) { retryId = JSON.parse(options.body).origin.messageId; return {}; } };
  await reloaded.get('sendForm').onsubmit({ preventDefault() {} });
  assert.equal(retryId, firstId); assert.equal(reloaded.get('text').value, '');
});

test('unavailable session storage preserves drafts in memory and reports the limitation', async () => {
  const p = await page(); p.context.sessionStorage.setItem = () => { throw Error('quota'); };
  p.type('内存草稿'); await p.change('bb'); await p.change('aa');
  assert.equal(p.get('text').value, '内存草稿');
  assert.equal(p.get('draftHint').textContent, '草稿仅保留在当前页面');
});

test('a late message page cannot replace the new group cursor', async () => {
  const p = await page(), slow = defer();
  p.state.intercept = route => route.startsWith('/groups/aa/messages?') ? slow.promise : route.includes('/messages?') ? { messages: [], nextCursor: 21 } : undefined;
  const old = p.refresh(); await flush(); await p.change('bb'); slow.resolve({ messages: [], nextCursor: 99 }); await old;
  assert.equal(vm.runInContext('cursor', p.context), 21);
  assert.equal(JSON.parse(p.get('contexts').textContent).project, '/bb');
});

function recoveryState() {
  const request = { id: 'r', messageId: 'm', status: 'needs_recovery', phase: 'planning', deliveryId: 'd', error: '上次结果尚未确认', contentPreview: '核对项目当前情况', discussionRounds: 0, maxDiscussionRounds: 3, usage: { knownTokens: 0, unknownCalls: 1 } };
  return { group: { id: 'aa', activeRequestId: 'r', status: 'needs_recovery', models: { codex: {}, harness: {} } }, requests: [request], permissions: [], activity: { members: [], detail: '待核对' } };
}

test('connection recovery and exhausted reads never ask the human to approve, restart or inspect manually',async()=>{
 const p=await page();
 const r={id:'r',status:'needs_recovery',deliveryId:'d',error:'desktop connection unavailable',recoveryWait:{kind:'desktop_connection',deliveryId:'d'}};
 p.context.r=r;let g=vm.runInContext('blockedGuidance(r)',p.context);
 assert.equal(g.needsUser,false);assert.equal(g.action,undefined);assert.equal(g.retryable,false);assert.match(g.next,/有限次数/);assert.match(g.next,/不自动取得新凭据/);
 r.recoveryWait.state='needs_refresh';g=vm.runInContext('blockedGuidance(r)',p.context);assert.equal(g.needsUser,true);assert.match(g.next,/请刷新协作连接/);assert.equal(g.retryable,false);
 r.recoveryWait.deliveryId='old';g=vm.runInContext('blockedGuidance(r)',p.context);assert.equal(g.action,'inspect','stale recovery metadata cannot hide unknown results');
 r.status='needs_decision';r.error='恢复次数已达上限；保留原投递';g=vm.runInContext('blockedGuidance(r)',p.context);assert.equal(g.needsUser,false);assert.equal(g.owner,'插件维护方');assert.equal(g.action,undefined);
 r.status='awaiting_approval';g=vm.runInContext('blockedGuidance(r)',p.context);assert.equal(g.needsUser,true);
});

test('stale admission connection shows an actionable request even when the group is active',async()=>{
 const p=await page();p.context.s={group:{id:'aa',activeRequestId:'r',status:'active'},requests:[{id:'r',status:'queued',revision:1,admissionWait:{kind:'desktop_connection',revision:1,state:'needs_refresh'}}]};
 const guidance=vm.runInContext('activeGuidance(s)',p.context);assert.equal(guidance.needsUser,true);assert.equal(guidance.retryable,false);assert.match(guidance.next,/请刷新协作连接/);
 p.context.s.group.status='paused';assert.equal(vm.runInContext('activeGuidance(s)',p.context),null);
});

test('current host initialization failure belongs to maintenance even when its report mentions approvals',async()=>{
 const p=await page();p.context.r={id:'r',status:'awaiting_review',error:'Harness 的前置任务受阻：0xC0000142，新的审批无法发出，普通用户重启仍失败。'};
 const g=vm.runInContext('blockedGuidance(r)',p.context),detail=vm.runInContext('taskExplanation(r)',p.context);
 assert.equal(g.needsUser,false);assert.equal(g.retryable,false);assert.equal(g.action,undefined);assert.match(g.owner,/维护方/);assert.match(detail.next,/无需盲目重启/);
 p.context.r.status='awaiting_approval';assert.equal(vm.runInContext('blockedGuidance(r).needsUser',p.context),true);
});

test('uncertain reply exposes reason and read-check action but disables execution retry', async () => {
  const p = await page(); let writes = 0;
  p.state.intercept = (route, options) => { if (options.method === 'POST') writes++; return route === '/groups/aa' ? recoveryState() : undefined; };
  await p.refresh();
  assert.equal(p.get('aiIssue').hidden, false);
  assert.match(p.get('aiReason').textContent, /上次结果尚未确认/);
  assert.equal(p.get('retry').disabled, true);
  assert.equal(p.get('settle').disabled, false);
  assert.equal(writes, 0);
});

test('duplicate control clicks submit once, and late control does not overwrite a switched group', async () => {
  const p = await page(), ack = defer(); let writes = 0;
  p.state.intercept = (route, options) => { if (route === '/groups/aa') return recoveryState(); if (route.endsWith('/control')) { writes++; assert.equal(JSON.parse(options.body).action, 'settle'); return ack.promise; } };
  await p.refresh(); const operation = p.get('settle').onclick(); await flush();
  await p.get('settle').onclick(); assert.equal(writes, 1); assert.equal(p.get('settle').disabled, true);
  await p.change('bb'); ack.resolve({}); await operation;
  assert.equal(p.get('aiIssue').hidden, true);
  assert.equal(p.get('resume').disabled, false);
  assert.equal(p.get('status').textContent, '已暂停');
});

test('task queue filters completed entries and shows original demand text as plain text', async () => {
  const p = await page(), state = recoveryState();
  state.requests.push({ ...state.requests[0], id: 'done', status: 'completed', deliveryId: null, contentPreview: '<img src=x onerror=alert(1)> 完成项目' });
  p.state.intercept = route => route === '/groups/aa' ? state : undefined;
  await p.refresh(); assert.equal(p.get('requests').children.length, 1);
  p.get('requestFilter').value = 'all'; p.get('requestFilter').onchange(); assert.equal(p.get('requests').children.length, 2);
  p.get('requestFilter').value = 'completed'; p.get('requestFilter').onchange();
  const card = p.get('requests').children[0], summary = card.children[0];
  assert.equal(summary.children[0].textContent, '已完成');
  assert.equal(summary.children[1].textContent, state.requests[1].contentPreview);
  assert.equal(p.get('requests').children.length, 1);
});


test('blocked task offers a visible direct link to its task details', async () => {
 const p=await page();p.get('settingsDialog').showModal=()=>{p.get('settingsDialog').open=true};
 vm.runInContext("currentGroupState={group:{status:'blocked',repo:'/aa',activeRequestId:'r'},requests:[{id:'r',status:'blocked',error:'integration mismatch'}]};renderTaskNotice(currentGroupState)",p.context);
 assert.equal(p.get('aiInspect').hidden,false);assert.equal(p.get('aiInspect').textContent,'查看任务详情');
 p.get('aiInspect').onclick();assert.equal(p.get('queueSection').open,true);
});

function choiceHarness(id = 'mode') {
  const listeners = new Map(), nodes = [], doc = { body:null, activeElement:null };
  function node() {
    const attrs = {}, events = {};
    const n = { children:[], style:{}, hidden:false, disabled:false, className:'', textContent:'',
      append(...children){this.children.push(...children)}, replaceChildren(...children){this.children=children},
      setAttribute(k,v){attrs[k]=v},getAttribute:k=>attrs[k],
      addEventListener(k,fn){(events[k]??=[]).push(fn)},
      dispatchEvent(e){for(const fn of events[e.type]||[])fn(e)},
      fire(key){let prevented=false;this.dispatchEvent({type:'keydown',key,preventDefault(){prevented=true}});return prevented},
      click(){this.dispatchEvent({type:'click',target:this})},
      contains(target){return this===target||this.children.some(c=>c.contains(target))},
      focus(){doc.activeElement=this},after(){},scrollIntoView(){},classList:{toggle(){}},
      getBoundingClientRect(){return {left:340,top:760,bottom:800,width:this.style.width?parseFloat(this.style.width):160,height:180}} };
    nodes.push(n);return n;
  }
  doc.body=node();doc.createElement=node;doc.addEventListener=(name,fn)=>(listeners.get(name)||listeners.set(name,[]).get(name)).push(fn);
  const select=node();select.id=id;select.value='auto';select.setAttribute('aria-label','消息处理方式');
  select.options=['auto','new','supplement','urgent'].map(value=>({value,textContent:value}));
  let changes=0;select.addEventListener('change',()=>changes++);
  const context=vm.createContext({document:doc,innerWidth:390,innerHeight:844,Event:class{constructor(type){this.type=type}},$:()=>select});
  const script=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
  vm.runInContext(script.slice(script.indexOf('const choiceWidgets='),script.indexOf("for(const id of ['groups','mode'])enhanceSelect")),context);
  context.select=select;const widget=vm.runInContext('enhanceSelect(select)',context);
  const trigger=nodes.find(n=>n.id===id+'Choice'),list=nodes.find(n=>n.id===id+'Options');
  return {select,trigger,list,widget,doc,get changes(){return changes},outside(){for(const fn of listeners.get('click'))fn({target:doc.body})}};
}

test('custom choices keep selection, keyboard navigation, dismissal and focus semantics', () => {
  const p=choiceHarness();assert.equal(p.select.hidden,true);assert.equal(p.select.value,'auto');
  p.trigger.fire('ArrowDown');assert.equal(p.list.hidden,false);assert.equal(p.trigger.getAttribute('aria-expanded'),'true');
  assert.equal(p.list.getAttribute('role'),'listbox');assert.equal(p.doc.activeElement,p.list);
  p.list.fire('ArrowDown');assert.equal(p.list.getAttribute('aria-activedescendant'),'modeOptions-1');
  p.list.fire('End');p.list.fire('Enter');assert.equal(p.select.value,'urgent');assert.equal(p.changes,1);assert.equal(p.doc.activeElement,p.trigger);
  p.trigger.click();p.list.fire('Home');p.list.fire('Enter');assert.equal(p.select.value,'auto');assert.equal(p.changes,2);
  p.trigger.fire('ArrowUp');assert.equal(p.list.getAttribute('aria-activedescendant'),'modeOptions-3');
  p.list.fire('Escape');assert.equal(p.select.value,'auto');assert.equal(p.doc.activeElement,p.trigger);
  p.trigger.click();assert.equal(p.list.fire('Tab'),false);assert.equal(p.list.hidden,true);assert.equal(p.doc.activeElement,p.trigger);
  p.trigger.click();p.outside();assert.equal(p.list.hidden,true);assert.equal(p.trigger.getAttribute('aria-expanded'),'false');
  p.trigger.click();p.list.children[2].click();assert.equal(p.select.value,'supplement');assert.equal(p.changes,3);
  p.trigger.click();p.list.fire('n');p.list.fire('Enter');assert.equal(p.select.value,'new');
});

test('custom choice viewport bounds and external draft/group changes stay synchronized', () => {
  for(const id of ['groups','mode']){
    const p=choiceHarness(id);p.widget.open();assert.equal(p.list.style.left,'118px');assert.equal(p.list.style.top,'572px');
    p.widget.close();p.select.value='supplement';p.widget.sync();assert.equal(p.trigger.children[0].textContent,'supplement');
    p.select.options=[];p.widget.sync();assert.equal(p.trigger.disabled,true);p.widget.open();assert.equal(p.list.hidden,true);
  }
});


test('task explanation separates recovery from active work and retains technical evidence in disclosure', async () => {
 const p=await page();
 const explain=r=>{p.context.task=r;return vm.runInContext('taskExplanation(task)',p.context)};
 assert.match(explain({status:'needs_recovery',deliveryId:'d'}).next,/核对原回复/);
 assert.doesNotMatch(explain({status:'active',deliveryId:'d'}).next,/暂停/);
 assert.match(explain({status:'blocked',error:'Integration verification failed: web/group.html'}).reason,/文件.*不一致/);
 vm.runInContext("renderRequests([{id:'x',status:'blocked',contentPreview:'修复菜单',error:'Integration verification failed: web/group.html',actions:[{phase:'integrate'}],results:{'review:harness':{status:'done',summary:'复核通过',verification:['17 tests passed']}}}])",p.context);
 const card=p.get('requests').children[0];assert.ok(card.children.some(e=>e.textContent.startsWith('你可以怎么做：')));
 const text=e=>e.textContent+' '+e.children.map(text).join(' ');
 assert.match(text(card),/复核通过/);assert.match(text(card),/17 tests passed/);assert.match(text(card),/技术记录（排障时查看）/);
});

test('a real human decision shows the concrete question and options instead of a generic deadlock',async()=>{
 const p=await page();p.context.r={status:'needs_decision',humanDecisions:[{member:'codex',question:'是否删除旧数据？',options:['保留旧数据','删除旧数据']}]};
 const g=vm.runInContext('blockedGuidance(r)',p.context);assert.equal(g.detail,'是否删除旧数据？');assert.match(g.next,/保留旧数据/);assert.match(g.next,/删除旧数据/);assert.equal(g.needsUser,true);assert.equal(g.action,undefined);
 p.context.r.deliveryId='pending';assert.equal(vm.runInContext('blockedGuidance(r).action',p.context),'inspect');
});

test('full-goal task cards expose the complete original requirement ledger and unfinished steps',async()=>{
 const p=await page();p.context.r={id:'goal',status:'active',phase:'execution',actions:[{phase:'review',goalAudit:true}],goal:{cycles:1,requirements:[],checklist:[{id:'R01',title:'原始功能A',status:'done',evidence:['通过']},{id:'R02',title:'原始功能B',status:'pending',evidence:[],task:'继续实现B'}]},results:{}};
 vm.runInContext('renderRequests([r])',p.context);const text=e=>e.textContent+' '+e.children.map(text).join(' ');const rendered=text(p.get('requests'));
 assert.match(rendered,/完整目标：1\/2 项已核验/);assert.match(rendered,/已自动接续 1 轮/);assert.match(rendered,/待推进 · 原始功能B：继续实现B/);assert.equal(vm.runInContext('taskExplanation(r).phase',p.context),'核对全部原始需求');
});

test('settings choices use provider/model catalog and only observed Codex configurations', async()=>{
 const p=await page();p.context.fixture={groups:[{id:'provider-a',name:'Provider A',models:[{id:'model-a',name:'Model A',reasoning:{efforts:[{id:'high',name:'High'}]}}]},{id:'not-routable',models:[]}],routableProviders:['provider-a']};
 vm.runInContext("settingsCatalog=fixture;knownCodex=[{model:'observed',effort:'low'}]",p.context);
 const values={harnessProvider:'provider-a',harnessModel:'model-a',codexModel:'observed'};p.context.form={elements:{namedItem:name=>({value:values[name]})}};
 const choices=name=>JSON.parse(JSON.stringify(vm.runInContext('modelChoices(form,'+JSON.stringify(name)+')',p.context)));
 assert.deepEqual(choices('harnessProvider').map(o=>o.value),['provider-a']);
 assert.deepEqual(choices('harnessModel').map(o=>o.value),['model-a']);
 assert.deepEqual(choices('harnessEffort').map(o=>o.value),['','high']);
 assert.deepEqual(choices('codexModel').map(o=>o.value),['observed']);
 values.harnessModel='unknown';assert.deepEqual(choices('harnessEffort').map(o=>o.value),['']);
 vm.runInContext('settingsCatalog=null',p.context);assert.deepEqual(choices('harnessProvider'),[]);
});

test('settings preserve unknown current values and custom input without inventing capabilities', async()=>{
 const p=await page(),input={name:'harnessModel',value:'legacy-private',hidden:false},select=element();
 const field={select,manual:false};const form={querySelectorAll:()=>[input],elements:{namedItem:()=>({value:'offline'})}};
 p.context.input=input;p.context.field=field;p.context.form=form;
 vm.runInContext('settingsFields.set(input,field);syncModelSuggestions(form)',p.context);
 assert.equal(select.children[0].value,'legacy-private');assert.match(select.children[0].textContent,/当前值/);assert.equal(select.value,'legacy-private');
 field.manual=true;input.value='typed-private';vm.runInContext('syncModelSuggestions(form)',p.context);
 assert.equal(input.value,'typed-private');assert.equal(input.hidden,false);assert.equal(select.value,'__custom__');
});

test('settings polling preserves unsaved edits and saving requires pause with no pending delivery',async()=>{
 const p=await page(),f=p.get('modelForm'),fields=new Map();f.elements={namedItem:name=>{if(!fields.has(name))fields.set(name,element());return fields.get(name)}};
 p.context.g={id:'aa',title:'Project',repo:'/project',status:'active',models:{codex:{model:'original'},harness:{model:'original-h',provider:'p'}}};
 vm.runInContext('currentGroupState={group:g,requests:[]};renderSettings(g)',p.context);
 assert.equal(fields.get('codexModel').value,'original');f.dataset.dirty='true';fields.get('codexModel').value='edited';
 vm.runInContext('renderSettings(g)',p.context);assert.equal(fields.get('codexModel').value,'edited');assert.equal(p.get('modelSave').disabled,true);
 vm.runInContext("g.status='paused';updateModelSave()",p.context);assert.equal(p.get('modelSave').disabled,false);
 vm.runInContext("currentGroupState.requests=[{deliveryId:'pending'}];updateModelSave()",p.context);assert.equal(p.get('modelSave').disabled,true);assert.match(p.get('modelSaveHint').textContent,/在途/);
 p.get('modelReset').onclick();assert.equal(fields.get('codexModel').value,'original');assert.equal(f.dataset.dirty,'');
});

test('navigation moves the same sidebar between desktop rail and mobile modal with focus return',()=>{
 const elements=new Map(),events=new Map();let location='rail',choiceClosed=0;
 const get=id=>{if(!elements.has(id)){const attrs={},handlers={};const n={id,hidden:false,open:false,setAttribute(k,v){attrs[k]=v},getAttribute:k=>attrs[k],focus(){context.document.activeElement=this},append(){location='drawer'},after(){location='rail'},addEventListener(k,fn){handlers[k]=fn},showModal(){this.open=true},close(){this.open=false;handlers.close?.()},getBoundingClientRect:()=>({left:0,right:300,top:0,bottom:844})};elements.set(id,n)}return elements.get(id)};
 const classes=new Set(),app={classList:{contains:k=>classes.has(k),toggle(k){if(classes.has(k)){classes.delete(k);return false}classes.add(k);return true}}};
 const media={matches:true,addEventListener:(k,fn)=>events.set(k,fn)};
 const context=vm.createContext({document:{getElementById:get,querySelector:()=>app,activeElement:null},$:get,matchMedia:()=>media,choiceWidgets:new Map([['groups',{close(){choiceClosed++}}]])});
 const html=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');vm.runInContext(html.slice(html.indexOf('let navigationMedia=null;'),html.indexOf('\nsetupNavigation();'))+'\nsetupNavigation();',context);
 assert.equal(location,'drawer');assert.equal(get('sidebarToggle').getAttribute('aria-expanded'),'false');
 get('sidebarToggle').onclick();assert.equal(get('sidebarDialog').open,true);assert.equal(context.document.activeElement,get('closeSidebar'));
 get('closeSidebar').onclick();assert.equal(get('sidebarDialog').open,false);assert.equal(context.document.activeElement,get('sidebarToggle'));
 get('sidebarToggle').onclick();get('settingsDialog').open=true;vm.runInContext('closeNavigation()',context);assert.equal(get('sidebarDialog').open,false);
 get('settingsDialog').open=false;media.matches=false;events.get('change')();assert.equal(location,'rail');assert.equal(get('workspaceSidebar').hidden,false);assert.equal(get('sidebarToggle').getAttribute('aria-expanded'),'true');
 get('sidebarToggle').onclick();assert.equal(get('workspaceSidebar').hidden,true);assert.equal(get('sidebarToggle').getAttribute('aria-expanded'),'false');
 get('sidebarToggle').onclick();assert.equal(get('workspaceSidebar').hidden,false);assert.ok(choiceClosed>=2);
});

test('Codex-like shell retains single operation controls and explicit mobile navigation',()=>{
 const html=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
 for(const id of ['workspaceSidebar','sidebarDialog','sidebarToggle','closeSidebar','groups','newGroup','pause','resume','showRequests','settings','sendForm','permissions','settle','retry'])assert.equal((html.match(new RegExp('id="'+id+'"','g'))||[]).length,1,id);
 assert.match(html, /grid-template-areas:'overview topbar' 'overview toolbar' 'overview thread' 'overview composer'/);
 assert.match(html, /<dialog id="sidebarDialog" aria-label="项目与协作导航"/);
 assert.match(html, /function switchGroup\(id\)\{closeNavigation\(\)/);
 assert.match(html, /function showPanel\(section\)\{closeNavigation\(\)/);
 assert.match(html, /select\.closest\?\.\('dialog'\)\|\|document\.body/);
});


test('blocker guidance names previous pending phase and prepares requests without sending or overwriting drafts',async()=>{
 const p=await page();p.context.req={status:'needs_decision',deliveryId:'d',phase:'planning',waitingFor:{member:'codex',phase:'integrate',isPreviousRevision:true}};
 const g=vm.runInContext('blockedGuidance(req)',p.context);assert.match(g.detail,/整合汇报/);assert.match(g.detail,/上一轮/);assert.equal(g.action,'inspect');
 p.context.req={status:'awaiting_review',error:'dependency',results:{'work:codex':{status:'blocked',summary:'浏览器预览访问被拒绝，缺少授权'}}};
 assert.equal(vm.runInContext('blockedGuidance(req).action',p.context),'diagnose');

});

function issueState(request,others=[]){return {group:{id:'aa',title:'Project',status:request.status,activeRequestId:request.id,models:{codex:{},harness:{}},contexts:{}},requests:[request,...others],permissions:[]}}

test('settled host wait is readable and does not turn requirement titles into a new permission request',async()=>{
 const p=await page();const r={id:'r',revision:2,status:'blocked',actions:[],error:'权限、审批和目标外操作：需宿主维护方修复；真人暂缓',goal:{auditMessageId:'audit'},goalWait:{requestId:'r',revision:2,auditMessageId:'audit',detail:'18 项已完成；1 项等待 Harness 宿主修复，1 项按你的要求暂缓。',next:'不需要重复批准、重启或反复重试。',owner:'维护方处理宿主能力；暂缓项保持待命',needsUser:false,retryable:false}};
 let s=issueState(r);p.state.intercept=route=>route==='/groups/aa'?s:undefined;await p.refresh();
 assert.match(p.get('aiReason').textContent,/18 项已完成/);assert.match(p.get('aiNext').textContent,/需要你处理：暂时不需要/);assert.equal(p.get('helpAction').hidden,true);assert.equal(p.get('retry').hidden,true);
 r.goalWait.revision=1;await p.refresh();assert.doesNotMatch(p.get('aiReason').textContent,/18 项已完成/);
 r.goalWait.revision=2;r.deliveryId='unknown';r.status='needs_recovery';s=issueState(r);await p.refresh();assert.equal(p.get('helpAction').dataset.action,'inspect');
});

test('historical blocked results cannot create a preview action for completed or replaced requests',async()=>{
 const p=await page();let s=issueState({id:'current',revision:2,status:'active',results:{'work:codex':{status:'blocked',summary:'浏览器预览许可被拒绝'}}},[{id:'old',status:'blocked',error:'浏览器预览许可被拒绝'}]);
 p.state.intercept=route=>route==='/groups/aa'?s:undefined;await p.refresh();assert.equal(p.get('helpAction').hidden,true);assert.equal(p.get('aiIssue').hidden,true);
 s=issueState({id:'current',revision:2,status:'completed',error:'浏览器预览许可被拒绝'});s.group.status='blocked';await p.refresh();assert.equal(p.get('helpAction').hidden,true);
 s.group.activeRequestId='missing';await p.refresh();assert.equal(p.get('aiIssue').hidden,true);
});

test('current request error wins over old phase results and yields readable four-part guidance',async()=>{
 const p=await page();const s=issueState({id:'current',revision:3,status:'blocked',error:'Main project integration conflict: file',results:{'work:codex':{status:'blocked',summary:'浏览器预览许可被拒绝'},'integrate:codex':{status:'done'}}});
 p.state.intercept=route=>route==='/groups/aa'?s:undefined;await p.refresh();
 assert.equal(p.get('helpAction').dataset.action,'diagnose');assert.match(p.get('aiReason').textContent,/发生了什么：整合/);
 for(const label of ['需要你处理：','由谁处理：','下一步：'])assert.ok(p.get('aiNext').textContent.includes(label));
 assert.doesNotMatch(p.get('aiReason').textContent,/Main project|浏览器/);
});

test('help actions refresh current request and reject stale revision before touching drafts or sending controls',async()=>{
 const p=await page();let s=issueState({id:'current',revision:0,status:'blocked',error:'浏览器预览许可被拒绝'});let controls=0;
 p.state.intercept=route=>{if(route==='/groups/aa')return s;if(route.endsWith('/control')){controls++;return {}}};await p.refresh();assert.equal(p.get('helpAction').dataset.action,'preview');
 s=issueState({id:'current',revision:1,status:'active'});await p.get('helpAction').onclick();assert.equal(p.get('text').value,'');assert.equal(controls,0);assert.equal(p.state.inputs.length,0);assert.match(p.get('inputReceipt').textContent,/状态已变化/);
 s=issueState({id:'next',revision:0,status:'blocked',error:'浏览器预览许可被拒绝'});await p.refresh();p.get('text').value='my draft';await p.get('helpAction').onclick();assert.equal(p.get('text').value,'my draft');assert.equal(p.state.inputs.length,0);
 p.get('text').value='';await p.get('helpAction').onclick();assert.match(p.get('text').value,/当前任务（next）/);assert.equal(p.get('mode').value,'supplement');assert.equal(p.state.inputs.length,0);
});

test('pending checkpoints and approvals remain human decisions, and raw unknown errors stay in details',async()=>{
 const p=await page();p.context.r={status:'needs_decision',deliveryId:'d',error:'浏览器预览许可被拒绝'};
 assert.equal(vm.runInContext('blockedGuidance(r).action',p.context),'inspect');
 p.context.r={status:'awaiting_approval',error:'浏览器预览许可被拒绝'};assert.equal(vm.runInContext('blockedGuidance(r).action',p.context),undefined);assert.equal(vm.runInContext('blockedGuidance(r).needsUser',p.context),true);
 p.context.r={status:'blocked',error:'{"secret":"raw stacktrace"}'};const g=vm.runInContext('blockedGuidance(r)',p.context);assert.doesNotMatch(g.detail+g.next,/secret|stacktrace/);
 const html=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');assert.doesNotMatch(html,/note\.textContent=input\.name\.startsWith/);assert.match(html,/Codex 候选来自已用配置，非完整能力目录；Harness 候选来自宿主实时目录/);
});

test('retry revalidates the active request before dispatching and never retries its replacement',async()=>{
 const p=await page();let s=issueState({id:'old',revision:0,status:'blocked',error:'needs review'});const controls=[];
 p.state.intercept=(route,options)=>{if(route==='/groups/aa')return s;if(route.endsWith('/control')){controls.push(JSON.parse(options.body));return {}}};await p.refresh();assert.equal(p.get('retry').disabled,false);
 s=issueState({id:'replacement',revision:0,status:'blocked',error:'different issue'});await p.get('retry').onclick();assert.deepEqual(controls,[]);assert.match(p.get('inputReceipt').textContent,/取消旧操作/);
 await p.get('retry').onclick();assert.deepEqual(controls,[{action:'retry'}]);
});

test('paused in-flight requests keep safe inspection while approvals never generate replacement actions',async()=>{
 const p=await page();p.context.s=issueState({id:'pending',revision:1,status:'active',deliveryId:'d'});p.context.s.group.status='paused';assert.equal(vm.runInContext('activeGuidance(s).action',p.context),'inspect');
 p.context.r={status:'awaiting_approval',deliveryId:'d',error:'浏览器许可被拒绝'};assert.equal(vm.runInContext('blockedGuidance(r).action',p.context),undefined);
});

test('overview splits project identity, task and phase without repeating global state',async()=>{
 const p=await page();const s=issueState({id:'task',status:'awaiting_review',phase:'review',contentPreview:'检查输入框',actions:[{phase:'review'}]});
 p.state.intercept=route=>route==='/groups/aa'?s:undefined;await p.refresh();
 assert.equal(p.get('threadTitle').textContent,'Project');assert.equal(p.get('overviewTask').textContent,'检查输入框');assert.equal(p.get('overviewPhase').textContent,'复核结果');assert.equal(p.get('status').textContent,'等待依赖');
 s.group.activeRequestId=null;s.group.status='idle';await p.refresh();assert.equal(p.get('overviewPhase').hidden,true);
});

test('detailed blocker guidance replaces generic activity only while an issue is visible',async()=>{
 const p=await page();let s=issueState({id:'task',status:'blocked',error:'conflict'});p.state.intercept=route=>route==='/groups/aa'?s:undefined;await p.refresh();
 assert.equal(p.get('aiDetail').hidden,true);assert.equal(p.get('aiIssue').hidden,false);assert.match(p.get('aiNext').textContent,/由谁处理/);
 s=issueState({id:'task',status:'active'});await p.refresh();assert.equal(p.get('aiDetail').hidden,false);assert.equal(p.get('aiIssue').hidden,true);
});

test('multiple approval cards share one explanation but retain each destination and decision',async()=>{
 const p=await page();p.context.records=[{member:'codex',status:'pending',confirmBy:'harness',allowPhrase:'allow-a',rejectPhrase:'deny-a'},{member:'harness',status:'pending',confirmBy:'codex',allowPhrase:'allow-b',rejectPhrase:'deny-b'}];
 vm.runInContext('renderPermissions(records)',p.context);const root=p.get('permissions'),text=n=>(n.textContent||'')+n.children.map(text).join(' '),all=text(root);
 assert.equal((all.match(/只有核验新增真人记录后才会生效/g)||[]).length,1);assert.match(all,/普通聊天或重试不等于批准/);assert.match(all,/确认入口：Harness 原生会话/);assert.match(all,/确认入口：Codex 原生会话/);
 assert.equal((all.match(/复制批准指令/g)||[]).length,2);assert.equal((all.match(/复制拒绝指令/g)||[]).length,2);
});

test('valid dirty model settings state does not repeat the unsaved-change message',async()=>{
 const p=await page();p.get('modelForm').dataset.dirty='true';p.context.s=issueState({id:'task',status:'paused'});vm.runInContext('currentGroupState=s;updateModelSave()',p.context);
 assert.equal((p.get('modelSaveHint').textContent.match(/有未保存修改/g)||[]).length,1);assert.equal(p.get('modelSave').disabled,false);
});


test('successful supplement restores automatic routing without clearing an edited draft',async()=>{
 const p=await page();p.get('mode').value='supplement';p.type('follow up');
 await p.get('sendForm').onsubmit({preventDefault(){}});
 assert.equal(p.get('mode').value,'auto');assert.equal(p.get('text').value,'');assert.equal(p.state.inputs.length,1);
});

test('bound integration diagnostics respect approval/checkpoint priority and reject stale revisions',async()=>{
 const p=await page();p.context.r={id:'r',revision:2,status:'blocked',error:'conflict',errorDetails:{reason:'main_conflict',human:{detail:'版本不同',next:'列出差异',owner:'整合者',needsUser:false,action:'diagnose'},technical:{file:'a.txt'},binding:{requestId:'r',revision:2,error:'conflict'}}};
 assert.equal(vm.runInContext('blockedGuidance(r).detail',p.context),'版本不同');
 vm.runInContext("r.deliveryId='d'",p.context);assert.equal(vm.runInContext('blockedGuidance(r).action',p.context),'inspect');
 vm.runInContext("r.status='awaiting_approval'",p.context);assert.match(vm.runInContext('blockedGuidance(r).detail',p.context),/单次审批/);
 vm.runInContext("delete r.deliveryId;r.status='blocked';r.revision++",p.context);assert.equal(vm.runInContext('requestDiagnostics(r)',p.context),null);
 vm.runInContext("r.revision--;r.error='different'",p.context);assert.equal(vm.runInContext('requestDiagnostics(r)',p.context),null);
});
test('task technical fold renders diagnostic hashes as text and notice key tracks diagnosis',async()=>{
 const p=await page();p.context.r={id:'r',revision:0,status:'blocked',phase:'execution',error:'conflict',results:{},usage:{},errorDetails:{reason:'main_conflict',human:{detail:'版本不同',next:'比较',owner:'整合者',needsUser:false},technical:{current:'abc<unsafe>'},binding:{requestId:'r',revision:0,error:'conflict'}}};
 vm.runInContext("currentGroupState={group:{id:'aa',status:'blocked',activeRequestId:'r'},requests:[r]};renderRequests([r])",p.context);
 const text=n=>(n.textContent||'')+n.children.map(text).join(' ');assert.match(text(p.get('requests')),/abc<unsafe>/);
 const key=vm.runInContext('guidanceKey()',p.context);vm.runInContext("r.errorDetails.reason='unknown'",p.context);assert.notEqual(vm.runInContext('guidanceKey()',p.context),key);
});

test('answer sidebar retains completed public previews, clears changed scopes and never writes chat',async()=>{
 const p=await page(),before=p.get('messages').children.length;
 p.context.s={group:{id:'aa',activeRequestId:'r',status:'active'},requests:[{id:'r',revision:3,status:'active',deliveryId:'d'}],answerPreview:{requestId:'r',revision:3,deliveryId:'d',member:'harness',text:'<b>正在生成</b>'}};
 vm.runInContext('renderAnswerPreview(s)',p.context);
 assert.equal(p.get('previewText-harness').textContent,'<b>正在生成</b>');assert.equal(p.get('previewState-harness').textContent,'正在生成');
 assert.equal(p.get('messages').children.length,before);assert.equal(p.state.inputs.length,0);
 vm.runInContext("s.answerPreview=null;renderAnswerPreview(s)",p.context);
 assert.match(p.get('previewState-harness').textContent,/等待更新/);assert.ok(p.get('previewText-harness').textContent);
 vm.runInContext("messages=[{sender:'harness',requestId:'r',origin:{messageId:'d'},content:'{}'}];renderAnswerPreview(s)",p.context);
 assert.match(p.get('previewState-harness').textContent,/已完成/);assert.equal(p.get('previewText-harness').textContent,'<b>正在生成</b>');
 vm.runInContext("s.requests[0].revision++;renderAnswerPreview(s)",p.context);assert.equal(p.get('previewText-harness').textContent,'');
});

test('answer sidebar does not steal scroll while reading, keeps peer cards and resets between groups',async()=>{
 const p=await page();p.context.s={group:{id:'aa',activeRequestId:'r',status:'active'},requests:[{id:'r',revision:0,status:'active',deliveryId:'c'}],answerPreview:{requestId:'r',revision:0,deliveryId:'c',member:'codex',text:'Codex outcome'}};
 vm.runInContext('renderAnswerPreview(s)',p.context);
 const scroll=p.get('previewScroll');scroll.scrollHeight=2000;scroll.scrollTop=70;scroll.clientHeight=300;scroll.onscroll();
 vm.runInContext("s.answerPreview.text='updated';renderAnswerPreview(s)",p.context);assert.equal(scroll.scrollTop,70);assert.equal(p.get('previewLatest').hidden,false);
 vm.runInContext("s.requests[0].deliveryId='h';s.answerPreview={...s.answerPreview,deliveryId:'h',member:'harness',text:'Harness outcome'};renderAnswerPreview(s)",p.context);
 assert.equal(p.get('previewText-codex').textContent,'updated');assert.equal(p.get('previewText-harness').textContent,'Harness outcome');assert.equal(scroll.scrollTop,70);
 p.get('previewLatest').onclick();assert.equal(scroll.scrollTop,2000);assert.equal(p.get('previewLatest').hidden,true);
 await p.change('bb');assert.equal(p.get('previewText-codex').textContent,'');assert.equal(p.get('previewText-harness').textContent,'');
 assert.ok(![...p.storage.values()].some(v=>String(v).includes('Harness outcome')));
});

test('answer sidebar folds independently, clamps width and keeps keyboard resizing available',async()=>{
 const p=await page();assert.equal(p.get('answerPreview').hidden,false);
 p.get('previewClose').onclick();assert.equal(p.get('answerPreview').hidden,true);
 p.get('previewToggle').onclick();assert.equal(p.get('answerPreview').hidden,false);
 vm.runInContext('setPreviewWidth(9000)',p.context);assert.equal(vm.runInContext('previewWidth',p.context),520);
 p.get('previewResize').onkeydown({key:'Home',preventDefault(){}});assert.equal(vm.runInContext('previewWidth',p.context),300);
 p.get('previewResize').onkeydown({key:'ArrowLeft',preventDefault(){}});assert.equal(vm.runInContext('previewWidth',p.context),320);
});

test('narrow answer drawer starts closed, closes at breakpoint and preserves its preview',async()=>{
 const media={matches:true,addEventListener(event,handler){this.changed=handler}};
 const p=await page(new Map(),{matchMedia:query=>query.includes('1100px')?media:null,innerWidth:390});
 assert.equal(p.get('answerPreview').hidden,true);p.get('previewToggle').onclick();assert.equal(p.get('previewBackdrop').hidden,false);
 p.context.s={group:{id:'aa',activeRequestId:'r',status:'active'},requests:[{id:'r',revision:1,status:'active',deliveryId:'d'}],answerPreview:{requestId:'r',revision:1,deliveryId:'d',member:'codex',text:'仍在阅读'}};
 vm.runInContext('renderAnswerPreview(s)',p.context);p.get('previewBackdrop').onclick();assert.equal(p.get('answerPreview').hidden,true);
 p.get('previewToggle').onclick();assert.equal(p.get('previewText-codex').textContent,'仍在阅读');
 media.matches=false;media.changed();assert.equal(p.get('answerPreview').hidden,true);assert.equal(p.get('previewBackdrop').hidden,true);
});

test('saved lifecycle intent is visible without obsolete approval buttons and hides after revision changes',async()=>{
 const p=await page();p.context.s=issueState({id:'task',revision:2,status:'needs_recovery'});p.context.s.group.epoch=3;p.context.s.group.contexts={codex:'ct',harness:'ht'};
 p.context.records=[{id:'old-id',requestId:'task',revision:2,status:'cancelled',member:'codex',allowPhrase:'obsolete approval',resumeIntent:{status:'awaiting_checkpoint',epoch:3,contexts:{codex:'ct',harness:'ht'}}}];
 vm.runInContext('currentGroupState=s;renderPermissions(records)',p.context);
 const root=p.get('permissions'),text=n=>(n.textContent||'')+n.children.map(text).join(' ');assert.equal(root.hidden,false);assert.match(text(root),/尚未批准的操作已保留/);assert.match(text(root),/结果未知时不会重放/);assert.doesNotMatch(text(root),/复制批准指令|obsolete approval/);
 p.context.s.requests[0].revision=3;vm.runInContext('renderPermissions(records)',p.context);assert.equal(root.hidden,true);
});


test('active task puts supplement first in the actual composer without overwriting an explicit mode', async () => {
  const p = await page(), select = p.get('mode');
  select.options = ['auto','new','supplement','urgent'].map(value => ({ value }));
  select.append = (...options) => { select.options = options; };
  select.value = 'urgent';
  p.context.testState = { group: { activeRequestId: 'r' }, requests: [{ id: 'r', status: 'active' }] };
  vm.runInContext('currentGroupState=testState;syncInputModes()', p.context);
  assert.deepEqual(select.options.map(o=>o.value), ['supplement','auto','new','urgent']);
  assert.equal(select.value, 'urgent');
  p.context.testState.requests[0].status = 'completed';
  vm.runInContext('syncInputModes()', p.context);
  assert.equal(select.options[0].value, 'auto'); assert.equal(select.value, 'urgent');
});
