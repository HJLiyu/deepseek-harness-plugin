import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { openGroupPage } from '../src/group-client.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {GroupStore} from '../src/group-store.mjs';
import {startGroupService} from '../src/group-service.mjs';
import {localFetch} from '../src/group-http.mjs';

test('entry waits for verified service startup before opening and never returns the access token', async () => {
  const calls = []; const secret = 'local-access-secret';
  const result = await openGroupPage('group', { platform: 'win32', getPage: async id => { calls.push(['ready', id]); return { url: `http://127.0.0.1:1234/g/group#${secret}` }; },
    launch(command, args, options) { calls.push(['launch', command, args, options]); const child = new EventEmitter(); child.unref = () => calls.push(['unref']); queueMicrotask(() => child.emit('spawn')); return child; } });
  assert.equal(calls[0][0], 'ready'); assert.equal(calls[1][0], 'launch');
  assert.equal(calls[1][1], 'explorer.exe'); assert.equal(calls[1][3].windowsHide, true);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.launchRequested, true);
});

test('entry does not open a browser when service startup fails or URL is not loopback', async () => {
  let launched = false; const launch = () => { launched = true; };
  await assert.rejects(openGroupPage(null, { getPage: async () => { throw Error('startup failed'); }, launch }), /startup failed/);
  await assert.rejects(openGroupPage(null, { getPage: async () => ({ url: 'https://example.com' }), launch }), /local group/);
  assert.equal(launched, false);
});

test('a fresh same-build maintenance drain is preserved by ordinary client reads', t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-drain-restart-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const script=`
    process.env.HARNESS_PLUGIN_DATA=process.argv[1];
    const {ensureGroupService}=await import('./src/group-client.mjs');
    const {localFetch}=await import('./src/group-http.mjs');
    let descriptor;
    try {
      descriptor=await ensureGroupService();const first=await localFetch(descriptor,'/api/health');
      await localFetch(descriptor,'/api/admin/prepare-update',{});
      descriptor=await ensureGroupService();const next=await localFetch(descriptor,'/api/health');
      if(!next.draining||first.pid!==next.pid||first.buildHash!==next.buildHash)throw Error('active maintenance drain was taken over by a read client');
    } finally {
      if(descriptor){await localFetch(descriptor,'/api/admin/prepare-update',{});await localFetch(descriptor,'/api/admin/shutdown',{});}
    }
    const fs=await import('node:fs');const path=await import('node:path');
    const deadline=Date.now()+10000;
    while(fs.existsSync(path.join(process.argv[1],'group-service.lock'))&&Date.now()<deadline)await new Promise(r=>setTimeout(r,50));
    if(fs.existsSync(path.join(process.argv[1],'group-service.lock')))throw Error('test worker lock not released');
    console.log('owned-drain-preserved');
  `;
  const output=execFileSync(process.execPath,['--input-type=module','-e',script,dir],{cwd:new URL('..',import.meta.url),encoding:'utf8',windowsHide:true,timeout:25000});
  assert.match(output,/owned-drain-preserved/);
});

test('an expired maintenance lease clears on the original service without a client restart',async()=>{
 const store=new GroupStore(':memory:');let clock=1000;
 const service=await startGroupService({store,runtime:{},schedule:false,now:()=>clock});
 try{
   await localFetch(service.descriptor,'/api/admin/prepare-update',{});
   const held=await localFetch(service.descriptor,'/api/health');assert.equal(held.draining,true);
   clock=held.drainExpiresAt+1;
   const expired=await localFetch(service.descriptor,'/api/health');assert.equal(expired.draining,false);assert.equal(expired.pid,held.pid);
 }finally{await service.close();}
});

test('a different local build also leaves a valid maintenance lease to its owner',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'group-owned-update-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script=`
  process.env.HARNESS_PLUGIN_DATA=process.argv[1];
  const fs=await import('node:fs'),path=await import('node:path'),http=await import('node:http');const calls=[];
  const server=http.createServer((req,res)=>{calls.push(req.url);res.setHeader('content-type','application/json');
   if(req.url==='/api/health')res.end(JSON.stringify({protocol:'codex-harness-group/v2',version:'0.3.2',buildHash:'different',runtimeHash:'0'.repeat(64),draining:true,drainExpiresAt:Date.now()+45000,running:0}));
   else{res.statusCode=500;res.end(JSON.stringify({error:'Reader must not mutate maintenance'}));}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+server.address().port;
  fs.writeFileSync(path.join(process.argv[1],'group-service.json'),JSON.stringify({url,token:'fixture-only-token'}));
  try{const{ensureGroupService}=await import('./src/group-client.mjs');const result=await ensureGroupService();
   if(result.url!==url||calls.some(p=>p!=='/api/health'))throw Error('maintenance lease stolen');console.log('different-client-drain-preserved');}
  finally{await new Promise(r=>server.close(r));}
 `;
 assert.match(execFileSync(process.execPath,['--input-type=module','-e',script,dir],{cwd:new URL('..',import.meta.url),encoding:'utf8',windowsHide:true,timeout:15000}),/different-client-drain-preserved/);
});
