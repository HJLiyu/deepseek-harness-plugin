import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? path.join(source, '..', 'plugins', 'codex-deepseek-harness'));
const files = [
  'plugin.json', 'mcp.json', 'README.md', 'verification.md', 'server.mjs', 'worker.mjs', 'cli.mjs',
  'desktop/service.mjs',
  'docs/connections.md', 'docs/desktop.md',
  'skills/collaborate/SKILL.md',
  'src/rpc.mjs', 'src/state.mjs', 'src/events.mjs', 'src/git.mjs', 'src/codex.mjs',
  'src/turn-deadline.mjs',
  'src/model-connections.mjs', 'src/external-agent.mjs', 'src/acp-policy.mjs',
  'src/native-empty-turn.mjs', 'src/effort-policy.mjs',
  'src/native-parallel.mjs',
  'src/harness.mjs', 'src/permissions.mjs', 'src/orchestrator.mjs', 'src/desktop.mjs', 'src/messages.mjs', 'src/catalog.mjs',
  'group-worker.mjs', 'src/group-store.mjs', 'src/group-engine.mjs', 'src/group-runtime.mjs', 'src/group-permissions.mjs', 'src/group-http.mjs', 'src/group-service.mjs', 'src/group-client.mjs', 'src/group-build.mjs',
  'src/install-guard.mjs', 'src/approval-text.mjs', 'src/goal-holds.mjs',
  'src/group-integration.mjs', 'src/project-files.mjs', 'src/artifact-policy.mjs', 'src/group-workflow.mjs', 'src/group-progress.mjs', 'src/integration-diagnostics.mjs',
  'src/scope-grants.mjs', 'src/tool-registry.mjs', 'src/tool-client.mjs', 'src/parallel-dispatch.mjs', 'src/task-context.mjs', 'src/context-savings.mjs', 'src/collaboration-policy.mjs', 'src/review-quality.mjs', 'src/group-budget.mjs', 'src/group-admission.mjs', 'src/task-list.mjs', 'src/task-lanes.mjs', 'src/independent-review.mjs', 'src/group-observability.mjs', 'src/status-explanation.mjs',
  'web/group.html', 'web/connections.html', 'hooks/hooks.json', 'hooks/native-input.mjs', 'src/companion-update.mjs',
  'companion/approval-text.mjs', 'companion/bridge-progress.mjs', 'companion/package.json', 'companion/index.mjs', 'companion/effort.mjs', 'companion/client.js', 'companion/cordis.patch.yml', 'companion/shell-probe.mjs', 'companion/human-proof.mjs', 'companion/pwsh-encoding.mjs', 'companion/build.mjs',
  'companion/pipe-compat.mjs', 'companion/owned-pipe.cjs', 'companion/owned-pipe-win32.c', 'companion/owned-pipe-win32-x64.dll',
];
const desktopOutput=process.argv.includes('--desktop-output')&&target.startsWith(path.join(source,'data','desktop')+path.sep)&&path.basename(target)==='runtime';
if (target === source || target.startsWith(source + path.sep)&&!desktopOutput) throw new Error('Package target must be outside source repository.');
fs.mkdirSync(target, { recursive: true });
let bytes = 0;
for (const relative of files) {
  const from = path.join(source, relative);
  const to = path.join(target, relative);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  bytes += fs.statSync(to).size;
}
fs.copyFileSync(path.join(source, 'src/group-http.mjs'), path.join(target, 'companion/bridge-http.mjs'));
bytes += fs.statSync(path.join(target, 'companion/bridge-http.mjs')).size;
process.stdout.write(JSON.stringify({ target, files: files.length + 1, bytes, entries:[...files,'companion/bridge-http.mjs'] }) + '\n');
