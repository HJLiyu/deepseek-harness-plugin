import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { companionBuildHash } from '../companion/build.mjs';

test('packaged runtime contains every module required by the MCP server', async () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-package-'));
  try {
    const script = path.resolve('scripts/package.mjs');
    const output = JSON.parse(execFileSync(process.execPath, [script, target], { encoding: 'utf8' }));
    assert.ok(output.bytes > 0);
    assert.equal(fs.existsSync(path.join(target, 'src', 'events.mjs')), true);
    assert.equal(fs.existsSync(path.join(target, 'src', 'permissions.mjs')), true);
    assert.equal(fs.existsSync(path.join(target, 'src', 'group-integration.mjs')), true);
    const engine = await import(pathToFileURL(path.join(target, 'src', 'group-engine.mjs')).href);
    assert.equal(typeof engine.GroupEngine, 'function');
    // Exercise the service entry too: engine imports alone missed new API-only dependencies.
    const service = await import(pathToFileURL(path.join(target, 'src', 'group-service.mjs')).href);
    assert.equal(typeof service.startGroupService, 'function');
    console.log(JSON.stringify({ target, files: ['src/group-engine.mjs', 'src/group-integration.mjs'], bytes: output.bytes, groupEngineImport: 'PASS' }));
    await import(pathToFileURL(path.join(target, 'src', 'orchestrator.mjs')).href);
    // Install exactly what the companion publishes, as a package manager does.
    // Importing the full source tree hid missing runtime files in its manifest.
    const companion = path.join(target, 'companion');
    const spec = JSON.parse(fs.readFileSync(path.join(companion, 'package.json'), 'utf8'));
    const installed = path.join(target, 'installed-companion'); fs.mkdirSync(installed);
    for (const file of ['package.json', ...spec.files]) fs.copyFileSync(path.join(companion, file), path.join(installed, file));
    const nativeModule = await import(pathToFileURL(path.join(installed, 'index.mjs')).href);
    const loaded = nativeModule.loadedBuildHash; assert.equal(loaded, companionBuildHash(installed));
    const shared = await import(pathToFileURL(path.join(installed, 'approval-text.mjs')).href);
    const phrase = '批准 2026-10-20-837dba4d 67c1e969-0000-4000-8000-000000000001';
    assert.equal(shared.sameCommand(phrase+'\n', phrase+'\r\n'), true);
    const sourceShared = await import(pathToFileURL(path.join(target, 'src', 'approval-text.mjs')).href);
    assert.deepEqual(sourceShared.parseCommand(phrase), shared.parseCommand(phrase));
    const build = await import(pathToFileURL(path.join(target, 'src', 'group-build.mjs')).href);
    const beforeRuntime = build.groupRuntimeHash(), beforeCompanion = companionBuildHash(installed);
    fs.appendFileSync(path.join(target,'companion','approval-text.mjs'), '\n// changed shared parser\n');
    fs.appendFileSync(path.join(installed,'approval-text.mjs'), '\n// changed shared parser\n');
    assert.notEqual(build.groupRuntimeHash(), beforeRuntime);
    assert.notEqual(companionBuildHash(installed), beforeCompanion);

    fs.appendFileSync(path.join(installed, 'client.js'), '\n// newer disk content\n');
    assert.notEqual(companionBuildHash(installed), loaded);
    assert.equal((await import(pathToFileURL(path.join(installed, 'index.mjs')).href)).loadedBuildHash, loaded, 'cached modules cannot acknowledge newly written code');
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});
