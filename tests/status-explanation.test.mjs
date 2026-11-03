import test from 'node:test';
import assert from 'node:assert/strict';
import {explainState,readiness} from '../src/status-explanation.mjs';
test('state explanations preserve unknown results and original status',()=>{
 for(const cancelSource of ['connection_disconnected','execution_interrupted','transport_timeout',undefined]){
  const r=explainState({status:'cancelled',cancelSource});assert.equal(r.status,'cancelled');assert.match(r.next,/未知结果不重放/);assert.doesNotMatch(r.reason,/拒绝/);
 }
 assert.match(explainState({status:'cancelled'}).reason,/原因尚未确认/);
 assert.match(explainState({status:'expired'}).reason,/不会复用/);
 assert.match(explainState({status:'needs_recovery'}).reason,/仍未确认/);
 assert.match(explainState({status:'pending'}).next,/需要你操作/);
 assert.match(explainState({status:'rejected'}).reason,/已被拒绝/);
});
test('readiness fails closed for missing, malformed and separately stale page/adapter evidence',()=>{
 const a='a'.repeat(64),b='b'.repeat(64),e={runtimeHash:a,buildHash:a,adapterHash:a};
 assert.equal(readiness(e,e,e).state,'ready');
 assert.equal(readiness(e,e,{}).state,'unknown');
 for(const key of ['runtimeHash','buildHash','adapterHash'])assert.equal(readiness(e,e,{...e,[key]:b}).state,'mismatch');
 assert.equal(readiness({},e,e).state,'unknown');
 assert.equal(readiness({runtimeHash:'x'},e,e).layers.installed,'unknown');
});

test('service injects explanation and browser renders the server text',async()=>{
 const fs=await import('node:fs');
 const service=fs.readFileSync(new URL('../src/group-service.mjs',import.meta.url),'utf8');
 const page=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
 assert.match(service,/explanation: explainState\(p\)/);
 assert.match(page,/p\.explanation\.reason/);
 assert.match(page,/p\.explanation\.next/);
 assert.match(service,/workflowState/);
});

test('permission note separates the reason and next step with a full stop',async()=>{
 const fs=await import('node:fs');
 const page=fs.readFileSync(new URL('../web/group.html',import.meta.url),'utf8');
 const expression=page.match(/note\.textContent=(\(p\.explanation \?[^;]+);/)[1];
 const p={explanation:{reason:'Connection ended',next:'Check the original checkpoint'},confirmBy:'codex'};
 const text=Function('p','return '+expression)(p);
 assert.ok(text.includes(p.explanation.reason+'\u3002'+p.explanation.next));
 assert.ok(!text.includes(p.explanation.reason+'?'+p.explanation.next));
});
