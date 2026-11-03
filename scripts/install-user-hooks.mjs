// Optional fallback when the Host does not discover plugin-bundled hooks.
// This registers definitions only. Review/trust remains in the native /hooks UI.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const [installedRoot, pluginData] = process.argv.slice(2);
const updatePrevious = process.argv.includes('--update-previous');
if (!installedRoot || !pluginData) throw new Error('Usage: node scripts/install-user-hooks.mjs <installedRoot> <pluginData>');
const entry = path.resolve(installedRoot, 'hooks/native-input.mjs');
if (!fs.existsSync(entry)) throw new Error('Installed native-input hook is missing.');
const nodePath = process.execPath.replaceAll('\\', '/');
// The personal runtime has a whitespace-free path. Quoting the first token
// without PowerShell's call operator was the actual Host startup failure.
if (/[\s"'`$]/.test(nodePath)) throw new Error('Choose a Node executable at a whitespace-free path for this Windows fallback.');
const data = path.resolve(pluginData).replaceAll('\\', '/');
if (/["'`$]/.test(data + entry)) throw new Error('Unsupported shell metacharacter in local hook paths.');
const command = `${nodePath} --input-type=module -e "process.env.HARNESS_PLUGIN_DATA='${data}';await import('${pathToFileURL(entry).href}')"`;
const file = path.join(os.homedir(), '.codex', 'hooks.json');
const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
const config = original ? JSON.parse(original) : {};
config.hooks ??= {};
for (const [event, timeout] of [['SessionStart', 20], ['UserPromptSubmit', 15]]) {
  const groups = config.hooks[event] ??= [];
  const existing = groups.flatMap(g => g.hooks ?? []).filter(h => h.command?.includes('hooks/native-input.mjs'));
  if (existing.some(h => h.command !== command)) {
    const owned = h => h.command.includes(`process.env.HARNESS_PLUGIN_DATA='${data}'`) && /\/codex-deepseek-harness\/\d+\.\d+\.\d+\/hooks\/native-input\.mjs/.test(h.command);
    if (!updatePrevious || existing.some(h => !owned(h))) throw new Error('A different native group hook already exists; inspect it rather than overwriting.');
    for (const hook of existing) { hook.command = command; hook.timeout = timeout; }
  }
  if (!existing.length) groups.push({ hooks: [{ type: 'command', command, timeout }] });
}
if ((fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null) !== original) throw new Error('User hooks changed during installation; preserved newer file.');
if (updatePrevious && original) {
  const backup = path.join(path.resolve(pluginData), 'group-user-hooks.previous.json');
  if (!fs.existsSync(backup)) fs.writeFileSync(backup, original, { flag: 'wx' });
}
const temporary = `${file}.${process.pid}.group-update.tmp`;
try { fs.writeFileSync(temporary, JSON.stringify(config, null, 2) + '\n', { flag: 'wx' }); fs.renameSync(temporary, file); }
finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
console.log(JSON.stringify({ file, events: ['SessionStart', 'UserPromptSubmit'], trust: 'Human /hooks review required; not changed by this installer.' }));
