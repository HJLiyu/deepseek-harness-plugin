import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ModelConnections, safeEndpoint } from '../src/model-connections.mjs';
import { ExternalAgent, executeAgentTool, canonicalTarget, sandboxCommand } from '../src/external-agent.mjs';
import { GroupRuntime } from '../src/group-runtime.mjs';
import { GroupStore } from '../src/group-store.mjs';
import { GroupPermissions } from '../src/group-permissions.mjs';
import { apply as applyAcpPolicy } from '../src/acp-policy.mjs';
import { RpcProcess } from '../src/rpc.mjs';

function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-connection-')),cleanup=[];t.after(async()=>{for(const fn of cleanup.reverse())await fn();fs.rmSync(dir,{recursive:true,force:true});});const c=new ModelConnections(dir);return {dir,c,cleanup};}
async function apiFixture(t,handler){const f=fixture(t);const server=http.createServer(async(req,res)=>{const chunks=[];for await(const b of req)chunks.push(b);const body=chunks.length?JSON.parse(Buffer.concat(chunks)):null;handler(req,res,body);});await new Promise(r=>server.listen(0,'127.0.0.1',r));f.cleanup.push(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));const p=await f.c.save({preset:'ollama',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,model:'test-model'});const agent=new ExternalAgent(f.c);f.cleanup.push(()=>agent.db.close());return {...f,p,agent};}
const reply=(res,message)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',...message}}],usage:{total_tokens:5}}));};
test('connection presets reject unsafe HTTP, credentials and shell injection; local key never appears in public config',async t=>{
 const {dir}=fixture(t),c=new ModelConnections(dir,{protect:async b=>Buffer.from('encrypted:'+b.toString()),unprotect:async b=>Buffer.from(b.toString().slice(10))});
 for(const url of ['http://example.com/v1','https://user:key@example.com','https://example.com?key=foo','https://example.com/#x'])assert.throws(()=>safeEndpoint(url));
 const p=await c.save({preset:'custom',baseUrl:'https://example.com/v1',auth:'local',apiKey:'test-secret-value'});assert.equal(p.hasStoredKey,true);assert.ok(!JSON.stringify(c.list()).includes('test-secret-value'));assert.equal(await c.key(c.get(p.id)),'test-secret-value');
 await assert.rejects(c.save({preset:'codex-cli',binary:'cmd.exe',args:['/c','echo nope']}));
 assert.notEqual((await c.save({preset:'ollama'})).id,(await c.save({preset:'ollama'})).id);
});
test('API multi-step tools, persistent context, durable recovery and replay refusal',async t=>{
 const requests=[];let calls=0;
 const f=await apiFixture(t,(req,res,body)=>{if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'test-model'}]}));return;}requests.push(body);calls++;if(calls===1)reply(res,{tool_calls:[{id:'write1',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'answer.txt',content:'verified'})}}],content:null});else reply(res,{content:calls===2?'first complete':'second complete'});});
 assert.equal((await f.agent.catalog(f.p.id)).models[0].id,'test-model');
 const s=await f.agent.create(f.p.id,f.dir,'test-model'),d={id:'d1',prompt:'first goal',phase:'work'};
 const options={guard(){},approve:async()=>{throw Error('Workspace file must not require escalation');}};
 const result=await f.agent.turn(s.sessionId,d,options);assert.equal(result.text,'first complete');assert.equal(result.usage.totalTokens,10);assert.equal(fs.readFileSync(path.join(f.dir,'answer.txt'),'utf8'),'verified');
 assert.equal(f.agent.recover(s.sessionId,d).text,'first complete');assert.equal((await f.agent.turn(s.sessionId,d,options)).text,'first complete');assert.equal(calls,2);
 await assert.rejects(f.agent.turn(s.sessionId,{...d,prompt:'different'},options),/binding/);
 await f.agent.turn(s.sessionId,{id:'d2',prompt:'second goal',phase:'work'},options);assert.ok(requests.at(-1).messages.some(m=>m.content==='first complete'));assert.equal(f.agent.row('sessions',s.sessionId).id,s.sessionId);
});
test('OpenAI dialogue test uses completion budget, requires text and reports actual usage',async t=>{
 let last;const f=await apiFixture(t,(req,res,body)=>{last=body;reply(res,{content:'CONNECTION-OK'});});
 const p=await f.c.save({preset:'openai',baseUrl:f.c.get(f.p.id).baseUrl,auth:'none',model:'test-model'});
 const r=await f.c.testDialogue(p.id);assert.equal(r.ok,true);assert.equal(r.usage.total_tokens,5);assert.equal(last.max_completion_tokens,64);assert.equal(last.max_tokens,undefined);
 await f.c.testDialogue(f.p.id);assert.equal(last.max_tokens,32);
});
test('project tools refuse review writes, junction escape, stale control and commands without approval',async t=>{
 const {dir}=fixture(t);const root=path.join(dir,'workspace');fs.mkdirSync(root);const other=path.join(dir,'outside.txt');fs.writeFileSync(other,'outside');let prompts=0,commands=0;
 const opts={root,phase:'work',guard(){},approve:async()=>{prompts++;return false;},command:async()=>{commands++;return {exitCode:0};}};
 assert.deepEqual(await executeAgentTool({name:'read_file',arguments:{path:other}},opts),{denied:true});assert.equal(prompts,1);
 await assert.rejects(executeAgentTool({name:'write_file',arguments:{path:'no.txt',content:'no'}},{...opts,phase:'review'}),/forbidden/);
 await assert.rejects(executeAgentTool({name:'write_file',arguments:{path:'stale.txt',content:'no'}},{...opts,guard(){throw Error('stale');}}),/stale/);
 assert.deepEqual(await executeAgentTool({name:'run_command',arguments:{command:['node','--version']}},opts),{denied:true});assert.equal(commands,0);
 await executeAgentTool({name:'run_command',arguments:{command:['node','--version']}},{...opts,approve:async()=>true});assert.equal(commands,1);
 assert.equal(fs.existsSync(path.join(root,'no.txt')),false);
 const link=path.join(root,'linked');fs.symlinkSync(dir,link,process.platform==='win32'?'junction':'dir');assert.equal(canonicalTarget(root,'linked/outside.txt').inside,false);
});
test('API rejected request is a durable terminal failure, network ambiguity is never replayed',async t=>{
 let count=0;const f=await apiFixture(t,(req,res)=>{count++;res.writeHead(401);res.end('do not expose server body or secret');});
 const s=await f.agent.create(f.p.id,f.dir,'test-model'),d={id:'deny',prompt:'goal',phase:'work'};
 const r=await f.agent.turn(s.sessionId,d,{guard(){},approve:async()=>false});assert.equal(r.externalFailure.kind,'api_rejected');assert.match(r.text,/401/);assert.ok(!r.text.includes('secret'));
 await f.agent.turn(s.sessionId,d,{guard(){},approve:async()=>false});assert.equal(count,1);
 f.agent.put('turns','unknown',{sessionId:s.sessionId,hash:'unknown',state:'requesting'});await assert.rejects(f.agent.turn(s.sessionId,{...d,id:'unknown'},{guard(){}}),/binding/);
});
test('lost API response after a file write retains the effect and blocks every replay',async t=>{
 let count=0;const f=await apiFixture(t,(req,res)=>{count++;if(count===1)reply(res,{content:null,tool_calls:[{id:'once',type:'function',function:{name:'write_file',arguments:JSON.stringify({path:'once.txt',content:'once'})}}]});else res.destroy();});
 const s=await f.agent.create(f.p.id,f.dir,'test-model'),d={id:'network-lost',phase:'work',prompt:'goal'};
 await assert.rejects(f.agent.turn(s.sessionId,d,{guard(){},approve:async()=>false}),/不会自动重发/);
 assert.equal(fs.readFileSync(path.join(f.dir,'once.txt'),'utf8'),'once');assert.equal(f.agent.recover(s.sessionId,d),null);
 await assert.rejects(f.agent.turn(s.sessionId,d,{guard(){}}),/unknown/);assert.equal(count,2);
});
test('Harness ACP restores via resume and loads a phase-bound native policy before prompting',async t=>{
 const {dir,c,cleanup}=fixture(t),script=path.join(dir,'acp-fixture.mjs');
 fs.writeFileSync(script,`import fs from 'node:fs';import readline from 'node:readline';if(process.env.HARNESS_ACP_POLICY_RECEIPT)fs.writeFileSync(process.env.HARNESS_ACP_POLICY_RECEIPT,JSON.stringify({pid:process.pid,preset:process.env.HARNESS_PEER_PHASE==='work'?'workspace-write':'read-only'}));const send=m=>process.stdout.write(JSON.stringify({...m,jsonrpc:'2.0'})+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='initialize')result={agentCapabilities:{sessionCapabilities:{resume:{}}}};if(m.method==='session/new')result={sessionId:'acp-dedicated',configOptions:[]};if(m.method==='session/resume')result={configOptions:[]};if(m.method==='session/prompt'){send({method:'session/update',params:{sessionId:'acp-dedicated',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'ACP-OK'}}}});result={stopReason:'end_turn'};}send({id:m.id,result});});`);
 const p=await c.save({preset:'harness-acp',binary:process.execPath,args:[script],model:'fixture-model'}),a=new ExternalAgent(c);cleanup.push(()=>a.db.close());
 const s=await a.create(p.id,dir,'fixture-model');const r=await a.turn(s.sessionId,{id:'acp-turn',phase:'review',prompt:'review'},{guard(){},approve:async()=>{throw Error('Review escalation forbidden');}});assert.equal(r.text,'ACP-OK');assert.equal(r.externalReceipt.kind,'harness-acp');
 const before={phase:process.env.HARNESS_PEER_PHASE,receipt:process.env.HARNESS_ACP_POLICY_RECEIPT},listeners=new Map(),sets=[];
 process.env.HARNESS_PEER_PHASE='review';process.env.HARNESS_ACP_POLICY_RECEIPT=path.join(dir,'unit-policy.json');
 try{applyAcpPolicy({permissionPresets:{set:(s,p)=>sets.push([s,p])},on:(event,cb)=>listeners.set(event,cb)});listeners.get('agent/inbox/claimed')({agent:{session:'owned-session'}});assert.deepEqual(sets,[['owned-session','read-only']]);}finally{for(const [k,v] of Object.entries({HARNESS_PEER_PHASE:before.phase,HARNESS_ACP_POLICY_RECEIPT:before.receipt}))if(v===undefined)delete process.env[k];else process.env[k]=v;}
});
test('native command executor sends explicit sandbox and caps output, rejects no implicit shell',async()=>{
 let params,closed=false;const result=await sandboxCommand({command:['node','--version']},{root:process.cwd(),rpcFactory:()=>({request:async(m,p)=>{if(m==='command/exec'){params=p;return {exitCode:0,stdout:'ok',stderr:''};}return {};},notify(){},async close(){closed=true;}})});
 assert.equal(result.exitCode,0);assert.equal(params.sandboxPolicy.type,'workspaceWrite');assert.equal(params.sandboxPolicy.networkAccess,false);assert.equal(params.outputBytesCap,process.platform==='win32'?undefined:65536);assert.equal(closed,true);
});
test('unknown command effects stop the tool loop instead of asking the model to repeat',async t=>{
 const f=fixture(t);await assert.rejects(executeAgentTool({name:'run_command',arguments:{command:['example-command']}},{root:f.dir,phase:'work',guard(){},approve:async()=>true,command:async()=>{throw Error('connection lost after dispatch');}}),e=>e.code==='EXTERNAL_EFFECT_UNKNOWN');
});
test('RPC close gives a CLI launcher time to dispose its child Host',async t=>{
 const {dir}=fixture(t),file=path.join(dir,'launcher.mjs'),marker=path.join(dir,'closed');
 fs.writeFileSync(file,`import {spawn} from 'node:child_process';import readline from 'node:readline';import fs from 'node:fs';const host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});const rl=readline.createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);process.stdout.write(JSON.stringify({id:m.id,result:{pid:host.pid}})+'\\n')});rl.on('close',()=>{host.once('exit',()=>fs.writeFileSync(${JSON.stringify(marker)},'disposed'));host.kill();});`);
 const rpc=new RpcProcess(process.execPath,[file]);const {pid}=await rpc.request('initialize');t.after(()=>{try{process.kill(pid);}catch{}});await rpc.close();assert.equal(fs.readFileSync(marker,'utf8'),'disposed');assert.throws(()=>process.kill(pid,0));
});
test('external Codex CLI uses real subprocess RPC and reuses its dedicated context',async t=>{
 const {dir,c,cleanup}=fixture(t);const script=path.join(dir,'fixture.mjs');
 fs.writeFileSync(script,`import readline from 'node:readline';const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result={};if(m.method==='thread/start')result={thread:{id:'peer-thread'}};if(m.method==='thread/resume')result={thread:{id:'peer-thread'}};if(m.method==='model/list')result={data:[{id:'fixture-model'}],nextCursor:null};if(m.method==='turn/start'){result={turn:{id:'peer-turn'}};send({id:m.id,result});setTimeout(()=>{send({method:'item/completed',params:{item:{type:'agentMessage',text:'CLI-OK'}}});send({method:'turn/completed',params:{turn:{id:'peer-turn',status:'completed'}}});},20);return;}send({id:m.id,result});});`);
 const p=await c.save({preset:'codex-cli',binary:process.execPath,args:[script],model:'fixture-model'}),agent=new ExternalAgent(c);cleanup.push(()=>agent.db.close());
 assert.equal((await agent.catalog(p.id,dir)).models[0].id,'fixture-model');const session=await agent.create(p.id,dir,'fixture-model');assert.equal(agent.row('sessions',session.sessionId).nativeId,undefined);
 const r=await agent.turn(session.sessionId,{id:'cli-delivery',prompt:'goal',phase:'work'},{guard(){},approve:async()=>false});assert.equal(r.text,'CLI-OK');assert.equal(r.externalReceipt.kind,'codex-cli');assert.equal(agent.row('sessions',session.sessionId).nativeId,'peer-thread');
 const next=await agent.turn(session.sessionId,{id:'cli-delivery-2',prompt:'next goal',phase:'review'},{guard(){},approve:async()=>false});assert.equal(next.threadId,'peer-thread');
});
test('owner approval ignores old turns, wrong chats and model labels; native fresh decision releases exactly once',async t=>{
 const {dir,cleanup}=fixture(t),store=new GroupStore(path.join(dir,'groups.sqlite'));cleanup.push(()=>store.close());
 const group=store.create({repo:dir,title:'external approvals',models:{codex:{},harness:{}}});group.contexts={codex:'dedicated-c',harness:'external-session'};group.peerConnectionId='external';group.approvalOwnerThreadId='owner-human';
 const {request}=store.input(group.id,{content:'work'});const d={id:'approval-delivery',groupId:group.id,requestId:request.id,member:'harness',phase:'work',revision:request.revision,epoch:group.epoch,status:'pending'};group.activeRequestId=request.id;group.status='active';request.deliveryId=d.id;request.status='active';
 store.transaction(()=>{store.save(group);store.saveRequest(request);store.saveDelivery(d);});
 let turns=[{turnId:'old',text:'old',status:'completed'}];const runtime=new GroupRuntime(store,{readUserTurns:async({threadId})=>threadId==='owner-human'?turns:[]});const perms=new GroupPermissions(store,runtime),controller=new AbortController();t.after(()=>controller.abort());
 const pending=perms.request(group,d,{method:'harness/tool',params:{callId:'call1',toolName:'run_command',arguments:{command:['node','--version']}}},controller.signal);
 await new Promise(setImmediate);const p=store.permissions(group.id)[0];assert.equal(p.confirmBy,'owner');assert.equal(p.confirmSession,'owner-human');
 turns=[{turnId:'old',text:p.allowPhrase,status:'completed'}];assert.equal(await runtime.permissionProof(group,p),null);
 turns.push({turnId:'new',text:p.rejectPhrase,status:'completed'});await perms.active.get(p.id).check();assert.equal(await pending,false);assert.equal(store.permission(p.id).status,'rejected');assert.equal(store.pendingPermissions(group.id).length,0);
});
