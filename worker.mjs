import { runGoal } from './src/orchestrator.mjs';
import { appendEvent, readGoal, saveGoal } from './src/state.mjs';

const id = process.argv[2];
if (!id) throw new Error('Goal ID required.');
try {
  await runGoal(id);
} catch (error) {
  // runGoal handles normal turn errors; this catches import/startup failures so
  // a detached worker never disappears without a durable event.
  const goal = readGoal(id);
  if (goal) {
    goal.status = 'paused';
    goal.error = error.message;
    goal.pausedReason = 'worker_error';
    saveGoal(goal);
  }
  appendEvent(id, { type: 'worker_error', message: error.message });
  process.exitCode = 1;
}
