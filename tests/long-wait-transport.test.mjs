import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLocalFetch, cancellationSource } from '../src/group-http.mjs';
const descriptor = { url: 'http://127.0.0.1:1234', token: 'secret' };
function fixture() {
  let callback, deadline, calls = 0, cleared = 0, options;
  const req = new EventEmitter(); req.end = () => {}; req.destroy = () => { req.destroyed = true; };
  const fetch = createLocalFetch({ request: (url, opts, cb) => { calls++; options = opts; callback = cb; return req; }, setTimer: (cb, ms) => { deadline = { cb, ms }; return 1; }, clearTimer: () => { cleared++; } });
  function respond(text = '{"allowed":true}', statusCode = 200) {
    const res = new EventEmitter(); res.statusCode = statusCode; res.complete = false; res.destroy = () => {};
    callback(res); res.emit('data', Buffer.from(text)); res.complete = true; res.emit('end'); return res;
  }
  return { fetch, req, respond, open: () => { const res = new EventEmitter(); res.complete = false; res.statusCode = 200; res.destroy = () => { res.destroyed = true; }; callback(res); return res; }, get deadline() { return deadline; }, get calls() { return calls; }, get cleared() { return cleared; }, get options() { return options; } };
}
test('long header wait has only the explicit absolute deadline and authenticates once', async () => {
  const f = fixture(); const p = f.fetch(descriptor, '/turn', {}, { timeoutMs: 1800000 });
  assert.equal(f.deadline.ms, 1800000); assert.equal(f.calls, 1); assert.equal(f.options.headers.authorization, 'Bearer secret');
  f.respond(); assert.deepEqual(await p, { allowed: true }); assert.equal(f.cleared, 1);
});
test('deadline fails closed without retry and destroys transport', async () => {
  const f = fixture(); const p = f.fetch(descriptor, '/approval', {}, { timeoutMs: 10 });
  f.deadline.cb(); await assert.rejects(p, { cancelSource: 'transport_timeout' }); assert.equal(f.calls, 1); assert.equal(f.req.destroyed, true);
});
test('caller cancellation before and during request never retries', async () => {
  for (const before of [true, false]) {
    const f = fixture(), c = new AbortController(); if (before) c.abort();
    const p = f.fetch(descriptor, '/turn', {}, { signal: c.signal }); if (!before) c.abort();
    await assert.rejects(p, { cancelSource: 'execution_interrupted' }); assert.equal(f.calls, before ? 0 : 1);
  }
});
test('disconnect is distinct from deadline and arbitrary native errors are not leaked', async () => {
  const f = fixture(); const p = f.fetch(descriptor, '/turn'); f.req.emit('error', new Error('secret URL'));
  await assert.rejects(p, e => e.cancelSource === 'connection_disconnected' && !e.message.includes('secret URL'));
});
test('cross origin, missing authentication and invalid deadlines send nothing', async () => {
  const f = fixture();
  await assert.rejects(f.fetch(descriptor, 'http://example.com/'));
  await assert.rejects(f.fetch({ ...descriptor, token: '' }, '/'));
  await assert.rejects(f.fetch(descriptor, '/', {}, { timeoutMs: 0 })); assert.equal(f.calls, 0);
});
test('redirects and malformed JSON cannot become successful approvals', async () => {
  for (const [body, code] of [['{}', 302], ['broken', 200]]) {
    const f = fixture(); const p = f.fetch(descriptor, '/approval'); f.respond(body, code); await assert.rejects(p); assert.equal(f.calls, 1);
  }
});
test('cancellation classification uses only known sources', () => {
  assert.equal(cancellationSource(new DOMException('deadline', 'TimeoutError')), 'transport_timeout');
  assert.equal(cancellationSource({ cancelSource: 'connection_disconnected' }), 'connection_disconnected');
  assert.equal(cancellationSource('human_input'), 'execution_interrupted');
});

test('same absolute deadline covers a stalled response body', async () => {
  const f = fixture(); const p = f.fetch(descriptor, '/turn', {}, { timeoutMs: 1800000 });
  const res = f.open(); res.emit('data', Buffer.from('{'));
  f.deadline.cb(); await assert.rejects(p, { cancelSource: 'transport_timeout' });
  assert.equal(res.destroyed, true); assert.equal(f.calls, 1);
});
test('truncated response is a disconnect, not a successful approval', async () => {
  const f = fixture(); const p = f.fetch(descriptor, '/approval'); const res = f.open();
  res.emit('data', Buffer.from('{"allowed":')); res.emit('close');
  await assert.rejects(p, { cancelSource: 'connection_disconnected' }); assert.equal(f.calls, 1);
});
