import fs from 'node:fs';
import path from 'node:path';
import { dataDir, readJson } from './src/state.mjs';
import { startGroupService } from './src/group-service.mjs';

fs.mkdirSync(dataDir, { recursive: true });
const lock = path.join(dataDir, 'group-service.lock');
let handle;
try { handle = fs.openSync(lock, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const pid = Number(fs.readFileSync(lock, 'utf8'));
  let alive = false; try { if (pid) { process.kill(pid, 0); alive = true; } } catch (check) { alive = check.code === 'EPERM'; }
  if (alive || (!pid && Date.now() - fs.statSync(lock).mtimeMs < 10000)) process.exit(0);
  fs.unlinkSync(lock); handle = fs.openSync(lock, 'wx');
}
fs.writeSync(handle, String(process.pid));
const descriptorFile = path.join(dataDir, 'group-service.json');
const previous = readJson(descriptorFile, null);
try {
  let service;
  let closeTask;
  const close = () => closeTask ??= (async () => {
    await service.close(); fs.closeSync(handle);
    if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock);
    process.exit(0);
  })();
  service = await startGroupService({ descriptorFile, port: previous ? new URL(previous.url).port : 0, token: previous?.token, onShutdown: close });
  process.once('SIGINT', close); process.once('SIGTERM', close);
} catch (error) {
  fs.closeSync(handle); if (Number(fs.readFileSync(lock, 'utf8')) === process.pid) fs.unlinkSync(lock);
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
