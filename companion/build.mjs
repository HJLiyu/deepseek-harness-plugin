import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function companionBuildHash(directory) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  for (const name of [...new Set(['package.json', ...manifest.files])].sort()) {
    if (!/^[a-z0-9.-]+$/i.test(name) || name === '..') throw Error('Invalid companion package file.');
    hash.update(name + '\0').update(fs.readFileSync(path.join(directory, name))).update('\0');
  }
  return hash.digest('hex');
}
