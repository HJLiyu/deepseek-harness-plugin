import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeChildEnv } from '../src/rpc.mjs';

test('empty HOME is repaired from USERPROFILE for app-server children', () => {
  const env = normalizeChildEnv({ HOME: '', USERPROFILE: 'C:\\Users\\tester', OTHER: 'x' });
  assert.equal(env.HOME, 'C:\\Users\\tester');
  assert.equal(env.USERPROFILE, 'C:\\Users\\tester');
  assert.equal(env.OTHER, 'x');
});

test('undefined inherited values are removed and explicit HOME wins', () => {
  const env = normalizeChildEnv({ HOME: 'D:\\home', USERPROFILE: 'C:\\Users\\tester', DSH_SESSION_ID: undefined });
  assert.equal(env.HOME, 'D:\\home');
  assert.equal('DSH_SESSION_ID' in env, false);
});
