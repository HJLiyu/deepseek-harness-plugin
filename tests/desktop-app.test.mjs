import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import vm from 'node:vm';

test('native appearance follows explicit selection, automatic system changes and avoids duplicate events',()=>{
 const sent=[],system={matches:false,addEventListener(name,handler){this.changed=handler;}};
 const document={readyState:'complete',documentElement:{dataset:{theme:'dark'}}};let changed;
 const window={matchMedia:()=>system,chrome:{webview:{postMessage:m=>sent.push(m)}}};window.top=window;
 const context={document,window,location:{hostname:'127.0.0.1'},MutationObserver:class{constructor(fn){changed=fn;}observe(){}}};
 vm.runInNewContext(fs.readFileSync('desktop/appearance.js','utf8'),context);
 assert.deepEqual(JSON.parse(JSON.stringify(sent)),[{type:'appearance',mode:'dark',theme:'dark'}]);
 changed();assert.equal(sent.length,1);
 document.documentElement.dataset.theme='light';changed();assert.equal(sent.at(-1).theme,'light');
 document.documentElement.dataset.theme='auto';changed();system.matches=true;system.changed();assert.equal(sent.at(-1).mode,'auto');assert.equal(sent.at(-1).theme,'dark');
 document.documentElement.dataset.theme='light';changed();system.matches=false;system.changed();assert.equal(sent.at(-1).theme,'light');assert.equal(sent.at(-1).mode,'light');
});

test('native appearance waits for document initialization and ignores frames and non-local pages',()=>{
 const code=fs.readFileSync('desktop/appearance.js','utf8');
 for(const [hostname,frame]of [['example.com',false],['127.0.0.1',true]]){let initialized=false;const window={top:frame?{}:null,matchMedia(){initialized=true;}};if(!frame)window.top=window;vm.runInNewContext(code,{location:{hostname},window});assert.equal(initialized,false);}
 let ready;const messages=[],system={matches:true,addEventListener(){}},document={readyState:'loading',documentElement:{dataset:{}},addEventListener(name,handler){assert.equal(name,'DOMContentLoaded');ready=handler;}};
 const window={matchMedia:()=>system,chrome:{webview:{postMessage:m=>messages.push(m)}}};window.top=window;
 vm.runInNewContext(code,{document,window,location:{hostname:'127.0.0.1'},MutationObserver:class{observe(){}}});assert.equal(messages.length,0);ready();assert.equal(messages[0].theme,'dark');assert.equal(messages[0].mode,'auto');
});

test('native host bridge attaches to the canonical coordinator without downgrading or stopping it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-desktop-'));let calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:'codex-harness-group/v2',runtimeHash:'newer-canonical-runtime'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 fs.writeFileSync(path.join(root,'group-service.json'),JSON.stringify({url,token:'test-only-native-host-token'}));fs.writeFileSync(path.join(root,'group-service.lock'),String(process.pid));
 const child=spawn(process.execPath,[path.resolve('desktop/service.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});let done=false;const exit=new Promise(r=>child.once('exit',code=>{done=true;r(code);}));
 t.after(async()=>{if(!done){child.kill();await exit;}server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true});});
 const lines=readline.createInterface({input:child.stdout}),ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Host ready timeout')),10000);lines.on('line',line=>{const m=JSON.parse(line);clearTimeout(timer);resolve(m);});});
 child.stdin.write(JSON.stringify({action:'start',dataDir:root})+'\n');const first=await ready;assert.equal(first.type,'ready');assert.equal(first.url,url+'/#test-only-native-host-token');assert.equal(first.dataDir,root);
 child.stdin.write('{"action":"stop"}\n');child.stdin.end();assert.equal(await exit,0);lines.close();assert.equal(server.listening,true);assert.deepEqual(calls,['/api/health']);
});
