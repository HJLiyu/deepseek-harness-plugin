import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setReloadRevision, reloadCompanionProfile, updateCompanionConfig } from '../src/companion-update.mjs';
import { companionBuildHash } from '../companion/build.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-update-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'node_modules/dsh-codex-group'); fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', files: ['index.mjs'] }));
  fs.writeFileSync(path.join(root, 'index.mjs'), 'export const safe = true;');
  const file = path.join(dir, 'cordis.patch.yml');
  const source = '# preserved\r\n- id: codex-group\r\n  config:\r\n    adapterId: harness-desktop\r\n- id: pet\r\n  config:\r\n    value: unchanged\r\n';
  fs.writeFileSync(file, source); return { dir, root, file, source };
}

test('native reload edits only the owned revision, retaining unrelated YAML and line endings', t => {
  const { file, source } = fixture(t), revision = 'a'.repeat(64);
  setReloadRevision(file, revision); setReloadRevision(file, revision);
  const changed = fs.readFileSync(file, 'utf8');
  assert.equal(changed.replace(`    reloadRevision: "${revision}"\r\n`, ''), source);
  assert.throws(() => setReloadRevision(file, '../bad'), /Invalid/);
});

test('hot update gates new admissions, waits for idle, verifies native build and always releases the gate', async t => {
  const { dir, root, file } = fixture(t); const hash = companionBuildHash(root), calls = [];
  const result = await reloadCompanionProfile('desktop', { profileRoot: dir, getService: async () => ({}), delay: async () => {},
    call: async (descriptor, route, body) => {
      calls.push(body?.action ?? 'health');
      if (body?.action === 'begin') return { leaseId: 'owned', ready: false };
      if (body?.action === 'check') return { ready: true };
      if (route === '/api/health') return { adapters: [{ adapterId: 'harness-desktop', connected: true, buildHash: hash, features: ['module-build-receipt-v1'] }] };
      return {};
    } });
  assert.equal(result.applied, true); assert.equal(result.restartRequired, false);
  assert.deepEqual(calls, ['begin', 'check', 'health', 'end']); assert.match(fs.readFileSync(file, 'utf8'), /reloadRevision/);
});

test('pending execution or human approval defers an update without touching native config or restarting', async t => {
  const { dir, file, source } = fixture(t); let released = false;
  const result = await reloadCompanionProfile('desktop', { profileRoot: dir, getService: async () => ({}), timeoutMs: 0,
    call: async (descriptor, route, body) => { if (body.action === 'end') released = true; return { leaseId: 'owned', ready: false }; } });
  assert.equal(result.deferred, true); assert.equal(released, true); assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('broken installed package cannot reach native reload or change profile settings', async t => {
  const { dir, root, file, source } = fixture(t); fs.writeFileSync(path.join(root, 'index.mjs'), "import './missing.mjs';");
  await assert.rejects(reloadCompanionProfile('desktop', { profileRoot: dir, getService: async () => assert.fail('No update admission for broken imports') }), /missing.mjs/);
  assert.equal(fs.readFileSync(file, 'utf8'), source);
});

test('already loaded identical module closure does not acquire a gate or rewrite native config',async t=>{
 const {dir,root,file}=fixture(t),hash=companionBuildHash(root);setReloadRevision(file,hash);const before=fs.readFileSync(file,'utf8'),calls=[];
 const result=await reloadCompanionProfile('desktop',{profileRoot:dir,getService:async()=>({}),call:async(_d,route)=>{calls.push(route);return{adapters:[{adapterId:'harness-desktop',connected:true,buildHash:hash,features:['module-build-receipt-v1']}]};}});
 assert.equal(result.applied,true);assert.equal(result.unchanged,true);assert.deepEqual(calls,['/api/health']);assert.equal(fs.readFileSync(file,'utf8'),before);
});

test('updating wrapped owned config preserves unrelated plugins even inside historical installer markers', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, '# BEGIN codex-group local configuration\n- id: codex-group\n  config:\n    descriptorFile: "old\\\n      wrapped"\n- id: pet\n  config:\n    petId: keep-me\n# END codex-group local configuration\n');
  updateCompanionConfig(file, { descriptorFile: 'new', serviceWorker: 'worker' });
  const updated = fs.readFileSync(file, 'utf8');
  assert.match(updated, /descriptorFile: "new"/); assert.doesNotMatch(updated, /wrapped/);
  assert.ok(updated.endsWith('- id: pet\n  config:\n    petId: keep-me\n# END codex-group local configuration\n'));
});

test('package files are copied only after the native update lease reaches an idle checkpoint', async t => {
  const { dir, root } = fixture(t), source = path.join(dir, 'candidate'); fs.mkdirSync(source);
  fs.copyFileSync(path.join(root, 'package.json'), path.join(source, 'package.json'));
  fs.writeFileSync(path.join(source, 'index.mjs'), "export const safe = 'new-build';");
  const expected = companionBuildHash(source);
  const result = await reloadCompanionProfile('desktop', { profileRoot: dir, sourceDirectory: source, getService: async () => ({}), delay: async () => {},
    call: async (descriptor, route, body) => {
      if (body?.action === 'begin') return { leaseId: 'owned', ready: false };
      if (body?.action === 'check') { assert.doesNotMatch(fs.readFileSync(path.join(root, 'index.mjs'), 'utf8'), /new-build/); return { ready: true }; }
      if (route === '/api/health') { assert.match(fs.readFileSync(path.join(root, 'index.mjs'), 'utf8'), /new-build/); return { adapters: [{ adapterId: 'harness-desktop', connected: true, buildHash: expected, features: ['module-build-receipt-v1'] }] }; }
      return {};
    } });
  assert.equal(result.restartRequired, false); assert.equal(result.applied, true);
});
