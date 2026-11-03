import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HARNESS_PLUGIN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-harness-'));
test.after(() => fs.rmSync(process.env.HARNESS_PLUGIN_DATA, { recursive: true, force: true }));
const { resolveModelValue, createToolCallTracker, initializeHarness } = await import('../src/harness.mjs');

test('cold ACP initialization gets a separate startup budget and connection telemetry', async () => {
  const events = [];
  const result = await initializeHarness({ async request(method, params, timeoutMs) {
    assert.equal(method, 'initialize');
    assert.ok(timeoutMs > 42595, 'observed cold startup exceeds 30 seconds');
    assert.ok(timeoutMs <= 300000);
    assert.equal(params.protocolVersion, 1);
    return { protocolVersion: 1 };
  } }, event => events.push(event));
  assert.equal(result.protocolVersion, 1);
  assert.deepEqual(events.map(event => event.type), ['connection_starting', 'connection_ready']);
  assert.equal(events[0].stage, 'initialize');
  await assert.rejects(initializeHarness({ async request() { throw new Error('timeout'); } }), /Harness ACP initialize: timeout/);
});

const configOptions = [{
  id: 'model',
  currentValue: '["deepseek-official","deepseek-v4-flash"]',
  options: [{
    group: 'DeepSeek',
    options: [
      { value: '["deepseek-official","deepseek-flash"]', name: 'DeepSeek-V41-Flash' },
      { value: '["deepseek-official","deepseek-v4-flash"]', name: 'DeepSeek-V4-Flash' },
      { value: '["deepseek-official","deepseek-v4-pro"]', name: 'DeepSeek-V4-Pro' },
    ],
  }],
}];

test('friendly model names resolve to the ACP serialized option value', () => {
  assert.equal(resolveModelValue(configOptions, 'deepseek-v4-pro'), '["deepseek-official","deepseek-v4-pro"]');
  assert.equal(resolveModelValue(configOptions, 'DeepSeek-V4-Flash'), '["deepseek-official","deepseek-v4-flash"]');
  assert.equal(resolveModelValue(configOptions, '["deepseek-official","deepseek-flash"]'), '["deepseek-official","deepseek-flash"]');
});

test('unknown models fail loudly with the available names', () => {
  assert.throws(() => resolveModelValue(configOptions, 'deepseek-v5'), /Unknown DeepSeek model.*DeepSeek-V4-Pro/s);
  assert.equal(resolveModelValue([], 'deepseek-v4-pro'), null);
});

test('permission requests recover bounded tool details from prior ACP updates', () => {
  const tracker = createToolCallTracker(value => String(value).replaceAll('secret-key', '[redacted]'));
  tracker.record({ toolCallId: 'call-1', title: 'write', rawInput: { path: 'E:\\probe.txt', content: 'secret-key' }, status: 'in_progress' });
  tracker.record({ toolCallId: 'call-1', status: 'failed' });
  assert.deepEqual(tracker.enrich({ toolCallId: 'call-1' }), {
    toolCallId: 'call-1', title: 'write', rawInput: { path: 'E:\\probe.txt', content: '[redacted]' }, status: 'failed',
  });
});
