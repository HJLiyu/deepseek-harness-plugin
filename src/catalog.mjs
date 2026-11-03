import fs from 'node:fs';
import path from 'node:path';
import { dataDir, readGoal, assertGoalId } from './state.mjs';
import { stopReason } from './messages.mjs';

export function listCollaborations({ offset = 0, limit = 20, status } = {}) {
  const root = path.join(dataDir, 'goals');
  const goals = [], warnings = [];
  if (fs.existsSync(root)) for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try { assertGoalId(entry.name); } catch { continue; }
    try {
      const goal = readGoal(entry.name);
      if (!goal || goal.id !== entry.name) throw new Error('Missing or inconsistent goal record.');
      if (status && goal.status !== status) continue;
      goals.push({ id: goal.id, objective: goal.objective, status: goal.status, stopReason: stopReason(goal),
        threadId: goal.codexThreadId, rounds: goal.rounds, maxRounds: goal.maxRounds,
        deepseekModel: goal.deepseekModel, updatedAt: goal.updatedAt ?? goal.createdAt ?? null,
        pendingApproval: Boolean(goal.pendingApproval), pendingHarness: Boolean(goal.pendingHarness) });
    } catch { warnings.push({ goalId: entry.name, error: 'Unreadable goal record; preserved for inspection.' }); }
  }
  goals.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.id.localeCompare(b.id));
  const start = Math.max(0, Math.floor(Number(offset) || 0));
  const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 20)));
  return { goals: goals.slice(start, start + size), total: goals.length,
    nextOffset: start + size < goals.length ? start + size : null, warnings: warnings.slice(0, 100), warningCount: warnings.length };
}
