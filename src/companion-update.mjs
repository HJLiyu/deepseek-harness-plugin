import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { companionBuildHash } from '../companion/build.mjs';
import { ensureGroupService } from './group-client.mjs';
import { localFetch } from './group-http.mjs';

export function updateCompanionConfig(file, values, { create = false } = {}) {
  const source = fs.readFileSync(file, 'utf8'), newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const starts = lines.flatMap((line, i) => /^- id: codex-group\s*$/.test(line) ? [i] : []);
  if (!starts.length && create) { lines.push('- id: codex-group', '  config:'); starts.push(lines.length - 2); }
  if (starts.length !== 1) throw Error('Expected one existing codex-group profile entry; other configuration is preserved.');
  const start = starts[0], next = lines.findIndex((line, i) => i > start && /^- /.test(line)), end = next < 0 ? lines.length : next;
  const config = lines.findIndex((line, i) => i > start && i < end && /^  config:\s*$/.test(line));
  if (config < 0) throw Error('Existing codex-group config block is missing.');
  for (const [key, value] of Object.entries(values)) {
    if (!['adapterId', 'descriptorFile', 'serviceWorker', 'reloadRevision'].includes(key) || typeof value !== 'string') throw Error('Invalid owned companion config field.');
    const boundary = lines.findIndex((line, i) => i > start && /^- /.test(line));
    const stop = boundary < 0 ? lines.length : boundary;
    const previous = lines.findIndex((line, i) => i > config && i < stop && line.startsWith(`    ${key}:`));
    const line = `    ${key}: ${JSON.stringify(value)}`;
    if (previous < 0) lines.splice(config + 1, 0, line);
    else {
      let count = 1; while (previous + count < stop && /^ {6,}\S/.test(lines[previous + count])) count++;
      lines.splice(previous, count, line);
    }
  }
  // Publishing one owned config field asks the host's HMR to reconcile the
  // installed module graph. Existing profile entries and settings stay intact.
  fs.writeFileSync(file, lines.join(newline));
}

export function setReloadRevision(file, revision) {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw Error('Invalid companion build revision.');
  updateCompanionConfig(file, { reloadRevision: revision });
}

export async function reloadCompanionProfile(profile, { profileRoot = path.join(os.homedir(), '.dsh', 'profiles', profile), getService = ensureGroupService,
  call = localFetch, delay = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 120000, sourceDirectory, configuration } = {}) {
  if (!['desktop', 'web'].includes(profile)) throw Error('Choose desktop or web.');
  const adapterId = `harness-${profile}`, root = path.join(profileRoot, 'node_modules', 'dsh-codex-group');
  // Verify the actual installed closure before asking the native host to reload.
  const candidate = sourceDirectory ?? root, expected = companionBuildHash(candidate);
  await import(pathToFileURL(path.join(candidate, 'index.mjs')).href);
  const service = await getService();
  const configFile=path.join(profileRoot,'cordis.patch.yml');
  const configText=fs.readFileSync(configFile,'utf8');
  const configCurrent=(!configuration||Object.entries(configuration).every(([key,value])=>configText.split(/\r?\n/).includes(`    ${key}: ${JSON.stringify(value)}`)))&&configText.includes(`    reloadRevision: "${expected}"`);
  let installedMatches=false;try{installedMatches=companionBuildHash(root)===expected;}catch{}
  if(configCurrent&&installedMatches){
    const health=await call(service,'/api/health');
    if(health.adapters?.some(a=>a.adapterId===adapterId&&a.connected&&a.features?.includes('module-build-receipt-v1')&&a.buildHash===expected))
      return {applied:true,unchanged:true,profile,buildHash:expected,restartRequired:false};
  }
  const lease = await call(service, '/api/admin/adapter-update', { adapterId, action: 'begin' });
  const leaseBody = { adapterId, leaseId: lease.leaseId };
  try {
    const deadline = Date.now() + Math.min(120000, timeoutMs);
    let state = lease;
    while (!state.ready && Date.now() < deadline) { await delay(500); state = await call(service, '/api/admin/adapter-update', { ...leaseBody, action: 'check' }); }
    if (!state.ready) return { applied: false, deferred: true, reason: '正在执行或等待审批，保留检查点，未重启应用。' };
    if (sourceDirectory && path.resolve(candidate) !== path.resolve(root)) {
      fs.mkdirSync(root, { recursive: true });
      const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
      for (const file of [...new Set([...manifest.files.filter(f => f !== 'index.mjs'), 'package.json', 'index.mjs'])]) fs.copyFileSync(path.join(candidate, file), path.join(root, file));
    }
    if (configuration) updateCompanionConfig(path.join(profileRoot, 'cordis.patch.yml'), { ...configuration, reloadRevision: expected });
    else setReloadRevision(path.join(profileRoot, 'cordis.patch.yml'), expected);
    do {
      const health = await call(service, '/api/health');
      if (health.adapters?.some(a => a.adapterId === adapterId && a.connected && a.features?.includes('module-build-receipt-v1') && a.buildHash === expected)) return { applied: true, profile, buildHash: expected, restartRequired: false };
      await delay(1000);
    } while (Date.now() < deadline);
    return { applied: false, profile, restartRequired: true, reason: 'Host 尚未确认新构建；可能未启用 HMR。会话与待办保留。' };
  } finally { await call(service, '/api/admin/adapter-update', { ...leaseBody, action: 'end' }); }
}
