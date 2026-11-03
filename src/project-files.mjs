import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { integrationFailure } from './integration-diagnostics.mjs';

export const contentHash = b => createHash('sha256').update(b).digest('hex');
export const projectGit = (repo, args) => execFileSync('git', ['--no-optional-locks', '-C', repo, ...args], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
export const gitNames = b => b.toString('utf8').split('\0').filter(Boolean);
export const trackedPaths = repo => gitNames(projectGit(repo, ['ls-files', '-z', '--cached']));

// Git membership is an index, never evidence of physical existence/deletion.
export function fileHash(root, name) {
  const target = path.resolve(root, name), relative = path.relative(path.resolve(root), target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || /(^|[\\/])\.git(?:[\\/]|$)/i.test(name)) throw integrationFailure('path_unsafe', { file: name });
  let cursor = target;
  while (cursor !== path.resolve(root)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw integrationFailure('path_unsafe', { file: name, kind: 'symlink' });
    cursor = path.dirname(cursor);
  }
  return fs.existsSync(target) ? contentHash(fs.readFileSync(target)) : null;
}
export function projectSnapshot(repo, remembered = []) {
  const visible = gitNames(projectGit(repo, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
  return Object.fromEntries([...new Set([...visible, ...remembered])].map(n => [n, fileHash(repo, n)]));
}
export function textHash(root, name) {
  if (!/\.(?:[cm]?js|html|css|json|md|txt|ts|tsx|jsx|yml|yaml)$/i.test(name) || fileHash(root, name) === null) return null;
  const bytes = fs.readFileSync(path.resolve(root, name));
  if (bytes.includes(0)) return null;
  try { return contentHash(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replaceAll('\r\n', '\n')); }
  catch { return null; }
}
