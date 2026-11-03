import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopTurn, rememberDesktopBridge, desktopBridgeEnvironment, desktopBridgeAvailable, desktopBridgeGeneration, openDesktopBridge } from '../src/desktop.mjs';
import { codexTurn, desktopDispatchIssue, desktopPermissionIssue, readRecordedCodexPermissions, readRecordedToolWait } from '../src/codex.mjs';

test('historical read-only permissions cannot veto current desktop UI selection', () => {
 const cwd=process.cwd();
 assert.equal(desktopDispatchIssue({cwd,sandbox_policy:{type:'read-only'},approval_policy:'never'},{cwd}),null);
 assert.match(desktopDispatchIssue({cwd:cwd+'-foreign'},{cwd}),/工作目录/);
 assert.match(desktopDispatchIssue(null,{cwd}),/无法确认/);
});
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('pending native permission tools are scoped to their turn and clear on tool result',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'native-tool-wait-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,'rollout.jsonl');
 const rows=[{type:'event_msg',payload:{type:'task_started',turn_id:'current'}},{type:'response_item',timestamp:'now',payload:{type:'custom_tool_call',call_id:'c',input:'tools.exec_command({sandbox_permissions:"require_escalated"})'}}];
 const save=()=>fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n'));save();
 assert.equal(readRecordedToolWait(file,'current')?.kind,'native_permission_tool');assert.equal(readRecordedToolWait(file,'other'),null);
 rows.push({type:'response_item',payload:{type:'custom_tool_call_output',call_id:'c',output:'done'}});save();assert.equal(readRecordedToolWait(file,'current'),null);
});

test('a Harness-launched worker discovers a refreshed Codex bridge without inheriting its environment',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-context-')),file=path.join(dir,'desktop-bridge.json'),server=path.join(dir,'bridge.mjs');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));fs.writeFileSync(server,'');
 const env={CODEX_APP_TOOLS_PIPE_PATH:'local-pipe-first',CODEX_THREAD_ID:randomUUID(),HARNESS_APP_TOOLS_SERVER:server,UNRELATED_SECRET:'must not persist'};
 assert.equal(rememberDesktopBridge({env,file}),true);assert.equal(desktopBridgeAvailable({env:{},file}),true);
 assert.equal(JSON.stringify(fs.readFileSync(file,'utf8')).includes('UNRELATED_SECRET'),false);
 assert.equal(rememberDesktopBridge({env:{},file}),false);
 const refreshed={...env,CODEX_APP_TOOLS_PIPE_PATH:'local-pipe-new',CODEX_THREAD_ID:randomUUID()};rememberDesktopBridge({env:refreshed,file});
 assert.equal(desktopBridgeEnvironment({env,file}).CODEX_APP_TOOLS_PIPE_PATH,'local-pipe-new');
 let options,meta;
 const bridge=openDesktopBridge({env:{},file,rpcFactory:(_server,o)=>{options=o;return {close:async()=>{},request:async(method,params)=>{
  if(method==='tools/call'){meta=params._meta;return {content:[{type:'text',text:JSON.stringify({ok:true})}]};}return {};
 }}}});
 try{assert.deepEqual(await bridge.call('read_thread',{threadId:'target'}),{ok:true});assert.equal(options.env.CODEX_APP_TOOLS_PIPE_PATH,'local-pipe-new');assert.equal(meta.threadId,refreshed.CODEX_THREAD_ID);assert.equal(options.env.UNRELATED_SECRET,undefined);}finally{await bridge.close()}
 fs.writeFileSync(file,'{broken');assert.equal(desktopBridgeEnvironment({env:refreshed,file}).CODEX_THREAD_ID,refreshed.CODEX_THREAD_ID);
});

test('unavailable desktop bridge marks only pre-admission writer contention as retryable',async()=>{
 let starts=0;
 await assert.rejects(codexTurn({threadId:'thread',cwd:process.cwd(),prompt:'work',desktopAvailable:()=>false,rpcFactory:()=>({notify(){},async close(){},async request(method){
  if(method==='thread/resume')throw Error('thread thread already has an active writer');if(method==='turn/start')starts++;return {};
 }})}),error=>error.code==='GROUP_NOT_ADMITTED'&&error.admissionFailure==='codex_busy');
 assert.equal(starts,0);
});

test('desktop initial read failure is known non-admission, while send and post-send failures stay uncertain',async()=>{
 for(const failure of ['preflight','send','poll']){
  let sends=0;const stages=[];
  await assert.rejects(desktopTurn({threadId:'thread',prompt:'once',onDispatchState:s=>stages.push(s.stage),
   bridgeFactory:()=>({async close(){},async call(name){
    if(name==='send_message_to_thread'){sends++;if(failure==='send')throw Error('connect ENOENT');return {}}
    if(failure==='preflight'||sends)throw Error('connect ENOENT');
    return {thread:{status:{type:'idle'}},turns:[]};
   }})}),e=>failure==='preflight'?e.code==='GROUP_NOT_ADMITTED'&&e.admissionFailure==='codex_connection':e.code!=='GROUP_NOT_ADMITTED');
  assert.equal(sends,failure==='preflight'?0:1);
  assert.deepEqual(stages,failure==='preflight'?['preflight']:['preflight','send_attempted']);
 }
});

test('desktop bridge creation fails before dispatch and a failed send journal prevents dispatch',async()=>{
 await assert.rejects(desktopTurn({threadId:'thread',prompt:'once',bridgeFactory:()=>{throw Error('Desktop app tools bridge is unavailable.')}}),e=>e.code==='GROUP_NOT_ADMITTED'&&e.admissionFailure==='codex_connection');
 let sends=0;
 await assert.rejects(desktopTurn({threadId:'thread',prompt:'once',onDispatchState:s=>{if(s.stage==='send_attempted')throw Error('journal unavailable')},bridgeFactory:()=>({async close(){},async call(name){if(name==='send_message_to_thread')sends++;return {thread:{status:{type:'idle'}},turns:[]}}})}),/journal unavailable/);
 assert.equal(sends,0);
});

test('bridge generation changes only with app connection, not whichever chat publishes it',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-generation-')),file=path.join(dir,'bridge.json');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const env={CODEX_APP_TOOLS_PIPE_PATH:'private-app-instance',CODEX_THREAD_ID:randomUUID()};rememberDesktopBridge({env,file});
 const first=desktopBridgeGeneration({file,env:{}});assert.match(first,/^[a-f0-9]{64}$/);
 rememberDesktopBridge({file,env:{...env,CODEX_THREAD_ID:randomUUID()}});assert.equal(desktopBridgeGeneration({file,env:{}}),first);
 rememberDesktopBridge({file,env:{...env,CODEX_APP_TOOLS_PIPE_PATH:'new-app'}});assert.notEqual(desktopBridgeGeneration({file,env:{}}),first);
});

test('desktop IPC publication respects a plugin data directory selected after module import',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-late-data-')),old=process.env.HARNESS_PLUGIN_DATA;
 t.after(()=>{if(old===undefined)delete process.env.HARNESS_PLUGIN_DATA;else process.env.HARNESS_PLUGIN_DATA=old;fs.rmSync(dir,{recursive:true,force:true})});
 process.env.HARNESS_PLUGIN_DATA=dir;
 assert.equal(rememberDesktopBridge({env:{CODEX_APP_TOOLS_PIPE_PATH:'local-pipe',CODEX_THREAD_ID:randomUUID()}}),true);
 assert.equal(fs.existsSync(path.join(dir,'desktop-bridge.json')),true);
});

test('an unbound native SessionStart refreshes the app instance without starting a group service',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bridge-hook-refresh-')),file=path.join(dir,'desktop-bridge.json');
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 rememberDesktopBridge({file,env:{CODEX_APP_TOOLS_PIPE_PATH:'old-app-instance',CODEX_THREAD_ID:randomUUID()}});
 const fresh={CODEX_APP_TOOLS_PIPE_PATH:'new-app-instance',CODEX_THREAD_ID:randomUUID()};
 const output=execFileSync(process.execPath,[path.resolve('hooks/native-input.mjs')],{
  input:JSON.stringify({hook_event_name:'SessionStart',session_id:fresh.CODEX_THREAD_ID}),encoding:'utf8',windowsHide:true,
  env:{...process.env,...fresh,HARNESS_PLUGIN_DATA:dir},timeout:5000,
 });
 assert.equal(output,'');assert.equal(desktopBridgeEnvironment({file,env:{}}).CODEX_APP_TOOLS_PIPE_PATH,fresh.CODEX_APP_TOOLS_PIPE_PATH);
 assert.equal(fs.existsSync(path.join(dir,'group-service.json')),false);assert.equal(fs.existsSync(path.join(dir,'groups.sqlite')),false);
});

test('recorded desktop permission check rejects stale planning, wrong scope and narrowed profiles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-permission-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const desired = { cwd: dir, sandbox: 'workspace-write', approvalPolicy: 'on-request', writableRoots: [dir] };
  const context = { cwd: dir, approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', writable_roots: [] } };
  assert.equal(desktopPermissionIssue(context, desired), null);
  assert.match(desktopPermissionIssue({ ...context, sandbox_policy: { type: 'read-only' }, approval_policy: 'never' }, desired), /read-only/);
  assert.match(desktopPermissionIssue({ ...context, approval_policy: 'never' }, desired), /never/);
  assert.match(desktopPermissionIssue(context, { ...desired, writableRoots: [dir + '-sibling'] }), /范围/);
  const profile = { type: 'managed', file_system: { entries: [{ path: { type: 'path', path: dir }, access: 'read' }] } };
  assert.match(desktopPermissionIssue({ ...context, permission_profile: profile }, desired), /托管/);
  profile.file_system.entries[0].access = 'write';
  assert.equal(desktopPermissionIssue({ ...context, permission_profile: profile }, desired), null);
  assert.equal(desktopPermissionIssue({ ...context, sandbox_policy: { type: 'danger-full-access' }, approval_policy: 'never', permission_profile: { type: 'disabled' } }, desired), null);
  assert.match(desktopPermissionIssue({ ...context, cwd: dir + '-other', sandbox_policy: { type: 'danger-full-access' }, permission_profile: { type: 'disabled' } }, desired), /工作目录/);
  assert.match(desktopPermissionIssue(null, desired), /无法确认/);
  const file = path.join(dir, 'rollout.jsonl');
  fs.writeFileSync(file, JSON.stringify({ type: 'turn_context', payload: { sandbox_policy: { type: 'read-only' } } }) + '\n' +
    JSON.stringify({ type: 'turn_context', payload: context }) + '\n{"partial":');
  assert.deepEqual(readRecordedCodexPermissions(file), context);
  fs.writeFileSync(file, JSON.stringify({ type: 'response_item', text: 'x'.repeat(2 * 1024 * 1024) }) + '\n');
  assert.equal(readRecordedCodexPermissions(file), null, 'bounded read must not fabricate missing permission evidence');
});

test('desktop permission preflight runs before dispatch and preserves a known non-admission', async () => {
  let sends = 0;
  await assert.rejects(desktopTurn({ threadId: 'thread', prompt: 'work',
    beforeDispatch: async () => { throw Object.assign(Error('只读会话'), { code: 'GROUP_NOT_ADMITTED', admissionFailure: 'codex_setup' }); },
    bridgeFactory: () => ({ close: async () => {}, call: async name => {
      if (name === 'send_message_to_thread') sends++;
      return { thread: { status: { type: 'idle' } }, turns: [] };
    } }), delay: async () => {}, timeoutMs: 1,
  }), e => e.code === 'GROUP_NOT_ADMITTED' && e.admissionFailure === 'codex_setup');
  assert.equal(sends, 0);
});

test('desktop recovery does not recheck or resend an existing completed delivery', async () => {
  const result = await desktopTurn({ threadId: 'thread', prompt: 'done', beforeDispatch: async () => assert.fail('already admitted'),
    bridgeFactory: () => ({ close: async () => {}, call: async name => {
      assert.equal(name, 'read_thread');
      return { turns: [{ id: 'existing', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'done' }] }, { type: 'agentMessage', text: 'done' },
      ] }] };
    } }),
  });
  assert.equal(result.turnId, 'existing');
});

test('writer fallback carries scoped permissions into its preflight instead of dispatching blindly', async () => {
  let closed = false, checked = false;
  await assert.rejects(codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'work', sandbox: 'workspace-write', approvalPolicy: 'on-request',
    desktopAvailable: () => true,
    desktop: async args => { assert.equal(typeof args.beforeDispatch, 'function'); await args.beforeDispatch(); assert.fail('must block missing native permission evidence'); },
    rpcFactory: () => ({ notify() {}, async close() { closed = true; }, async request(method) {
      if (method === 'thread/resume') throw Error('thread thread already has an active writer');
      if (method === 'thread/read') { assert.equal(closed, false); checked = true; return { thread: { id: 'thread', path: null } }; }
      return {};
    } }),
  }), e => e.code === 'GROUP_NOT_ADMITTED' && e.admissionFailure === 'codex_setup');
  assert.equal(checked, true); assert.equal(closed, true);
});

test('read-only and writing fallback verify the current desktop thread without rollout history',async()=>{
 for(const sandbox of ['read-only','workspace-write']){
  const result=await codexTurn({threadId:'thread',cwd:process.cwd(),prompt:'current task',sandbox,
   desktopAvailable:()=>true,desktop:async args=>{await args.beforeDispatch({thread:{id:'thread',cwd:process.cwd()}});return {text:'admitted by native host'};},
   rpcFactory:()=>({notify(){},async close(){},async request(method){if(method==='thread/resume')throw Error('thread thread already has an active writer');return {};}})});
  assert.equal(result.text,'admitted by native host');
 }
});

test('long desktop deliveries retain retry identity when native output is truncated', async () => {
  const prompt = 'long payload '.repeat(2000);
  const id = createHash('sha256').update('thread\0' + prompt).digest('hex');
  const prefix = `[Harness delivery ${id}]\n`;
  const result = await desktopTurn({ threadId: 'thread', prompt, bridgeFactory: () => ({ async close() {}, async call(name) {
    assert.equal(name, 'read_thread', 'must not resend an existing long input');
    return { turns: [{ id: 'long-turn', status: 'completed', items: [
      { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: '<codex_delegation>\n<input>' + prefix + prompt.slice(0, 1000), truncated: true } },
      { type: 'agentMessage', text: 'long delivery acknowledged', phase: 'final_answer' },
    ] }] };
  } }) });
  assert.equal(result.turnId, 'long-turn');
});

test('desktop delivery uses the existing writer and correlates the exact reply', async () => {
  const calls = [];
  let sent = false;
  const result = await desktopTurn({ threadId: 'thread', prompt: '[DeepSeek Harness] pending', bridgeFactory: () => ({
    async close() {}, async call(name) {
      calls.push(name);
      if (name === 'send_message_to_thread') { sent = true; return {}; }
      return { thread: { status: { type: 'idle' } }, turns: sent ? [{ id: 'new', status: 'completed', items: [
        { type: 'userMessage', content: [{ type: 'text', text: '[DeepSeek Harness] pending' }] },
        { type: 'agentMessage', text: 'VERIFIED', phase: 'final_answer' },
      ] }] : [{ id: 'old', status: 'completed', items: [{ type: 'agentMessage', text: 'STALE' }] }] };
    },
  }) });
  assert.equal(result.text, 'VERIFIED');
  assert.equal(result.turnId, 'new');
  assert.equal(calls.filter(name => name === 'send_message_to_thread').length, 1);
});

test('desktop retry reuses an already dispatched exact input without resending', async () => {
  const result = await desktopTurn({ threadId: 'thread', prompt: 'pending', bridgeFactory: () => ({ async close() {}, async call(name) {
    assert.equal(name, 'read_thread');
    return { turns: [{ id: 'existing', status: 'completed', items: [
      { type: 'functionCallOutput', name: 'send_message_to_thread', namespace: 'codex_app', output: { text: '<codex_delegation>\n  <input>pending</input>\n</codex_delegation>', truncated: false } }, { type: 'agentMessage', text: 'reply' },
    ] }] };
  } }) });
  assert.equal(result.turnId, 'existing');
});

test('writer contention falls back to desktop and closes the competing process', async () => {
  let closed = false;
  const result = await codexTurn({ threadId: 'thread', cwd: process.cwd(), prompt: 'pending', desktopAvailable: () => true,
    desktop: async args => { assert.equal(closed, true); assert.equal(args.prompt, 'pending'); return { text: 'delivered' }; },
    rpcFactory: () => ({ notify() {}, async close() { closed = true; }, async request(method) {
      if (method === 'thread/resume') throw new Error('thread thread already has an active writer');
      return {};
    } }),
  });
  assert.equal(result.text, 'delivered');
});

test('human intervention releases the desktop poller without claiming the admitted operation was cancelled', async () => {
  const controller = new AbortController(); let sent = false, closed = false;
  await assert.rejects(desktopTurn({ threadId: 'thread', prompt: 'old work', signal: controller.signal,
    delay: async () => controller.abort(), bridgeFactory: () => ({ close: async () => { closed = true; }, call: async name => {
      if (name === 'send_message_to_thread') { sent = true; return {}; }
      return { thread: { status: { type: 'idle' } }, turns: sent ? [{ id: 'old', status: 'inProgress', items: [{ type:'userMessage', content:[{type:'text',text:'old work'}] }] }] : [] };
    } }),
  }), e => e.code !== 'GROUP_NOT_ADMITTED' && /真人插话/.test(e.message));
  assert.equal(sent, true); assert.equal(closed, true);
});


test('explicit retry may resume a terminal systemError thread but never an active one',async()=>{
 let sent=false,sends=0;
 const result=await desktopTurn({threadId:'thread',prompt:'retry pending',bridgeFactory:()=>({close:async()=>{},call:async(name)=>{
 if(name==='send_message_to_thread'){sent=true;sends++;return {}};
 return sent?{thread:{status:{type:'idle'}},turns:[{id:'new',status:'completed',items:[{type:'userMessage',content:[{type:'text',text:'retry pending'}]},{type:'agentMessage',text:'OK',phase:'final_answer'}]}]}:{thread:{status:{type:'systemError'}},turns:[{id:'previous',status:'failed',items:[]}]};
 }})});assert.equal(result.text,'OK');assert.equal(sends,1);
 await assert.rejects(desktopTurn({threadId:'thread',prompt:'other',bridgeFactory:()=>({close:async()=>{},call:async name=>{assert.equal(name,'read_thread');return {thread:{status:{type:'systemError'}},turns:[{id:'running',status:'inProgress',items:[]}]}}})}),error=>error.code==='GROUP_NOT_ADMITTED');
});

test('desktop exposes matching in-progress public answer text while final reply stays authoritative',async()=>{
 let reads=0;const seen=[];const result=await desktopTurn({threadId:'thread',prompt:'probe',onAnswer:t=>seen.push(t),delay:async()=>{},bridgeFactory:()=>({async close(){},async call(name){assert.equal(name,'read_thread');reads++;return {thread:{status:{type:'idle'}},turns:[{id:'t',status:reads<3?'inProgress':'completed',items:[{type:'userMessage',content:[{type:'text',text:'probe'}]},{type:'reasoning',text:'SECRET'},{type:'agentMessage',phase:'final_answer',text:reads<3?'生成中':'FINAL'}]}]}}})});assert.deepEqual(seen,['生成中']);assert.equal(result.text,'FINAL');
});
