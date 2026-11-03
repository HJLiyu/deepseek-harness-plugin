import fs from 'node:fs';
import path from 'node:path';
import { goalDir } from './state.mjs';

// Read the current and up to three rotated event files in chronological order.
// A line may be mid-append or a previous process may have died mid-write, so a
// single malformed line must not make the whole event log unreadable.
export function readEventHistory(goalId) {
  const base = path.join(goalDir(goalId), 'events.jsonl');
  const files = [3, 2, 1].map(n => `${base}.${n}`).filter(file => fs.existsSync(file));
  if (fs.existsSync(base)) files.push(base);
  const all = [];
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { all.push(JSON.parse(line)); } catch { /* skip partial or corrupt line */ }
    }
  }
  return { events: all, files };
}

export function readEvents(goalId, offset = 0, limit = 30) {
  const { events: all, files } = readEventHistory(goalId);
  const start = Math.max(0, Number(offset) || 0);
  const size = Math.min(100, Math.max(1, Number(limit) || 30));
  return { goalId, events: all.slice(start, start + size), nextOffset: start + size < all.length ? start + size : null, total: all.length, files };
}
