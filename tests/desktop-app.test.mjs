import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

test('native host bridge attaches to the canonical coordinator without downgrading or stopping it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-desktop-'));let calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('content-type','application/json');res.end(JSON.stringify({protocol:'codex-harness-group/v2',runtimeHash:'newer-canonical-runtime'}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
 fs.writeFileSync(path.join(root,'group-service.json'),JSON.stringify({url,token:'test-only-native-host-token'}));fs.writeFileSync(path.join(root,'group-service.lock'),String(process.pid));
 const child=spawn(process.execPath,[path.resolve('desktop/service.mjs')],{stdio:['pipe','pipe','pipe'],windowsHide:true});let done=false;const exit=new Promise(r=>child.once('exit',code=>{done=true;r(code);}));
 t.after(async()=>{if(!done){child.kill();await exit;}server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true});});
 const lines=readline.createInterface({input:child.stdout}),ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Host ready timeout')),10000);lines.on('line',line=>{const m=JSON.parse(line);clearTimeout(timer);resolve(m);});});
 child.stdin.write(JSON.stringify({action:'start',dataDir:root})+'\n');const first=await ready;assert.equal(first.type,'ready');assert.equal(first.url,url+'/#test-only-native-host-token');
 child.stdin.write('{"action":"stop"}\n');child.stdin.end();assert.equal(await exit,0);lines.close();assert.equal(server.listening,true);assert.deepEqual(calls,['/api/health']);
});
