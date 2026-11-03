import {toolServiceCall} from './src/tool-client.mjs';
import { startGoal, goalStatus, setControl, runGoal, organizeSidebar, decidePermission, adoptCodexThread } from './src/orchestrator.mjs';
import { readGoal } from './src/state.mjs';
import { readTranscript } from './src/messages.mjs';
import { listCollaborations } from './src/catalog.mjs';
import { groupCall, groupPage, openGroupPage } from './src/group-client.mjs';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
const id = args[0];
let result;
try {
  if(command==='group-scopes')result=await toolServiceCall(id,'scopes');
  else if(['group-scope-request','group-scope-refresh','group-scope-revoke','group-scope-release-evidence','group-scope-release'].includes(command)){
    const {readFileSync}=await import('node:fs');const input=JSON.parse(readFileSync(id,'utf8'));
    result=await toolServiceCall(input.groupId,command.slice(6),input.body);
  }
  else if(command==='group-tools')result=await toolServiceCall(id,'tools');
  else if(command==='group-tool-calls')result=await toolServiceCall(id,'tool-calls');
  else if(command==='group-tool-call'){
    const {readFileSync}=await import('node:fs');
    const input=JSON.parse(readFileSync(id,'utf8'));
    result=await toolServiceCall(input.groupId,'tool-call',input.call);
  }
  else if (command === 'group-page') result = await groupPage(id);
  else if (command === 'group-open') result = await openGroupPage(id);
  else if (command === 'companion-reload') result = await (await import('./src/companion-update.mjs')).reloadCompanionProfile(id ?? 'desktop');
  else if (command === 'companion-update') result = await (await import('./src/companion-update.mjs')).reloadCompanionProfile(id ?? 'desktop', { sourceDirectory: fileURLToPath(new URL('./companion/', import.meta.url)) });
  else if (command === 'group-owner-approval') {
    const { GroupStore } = await import('./src/group-store.mjs');
    const { GroupRuntime } = await import('./src/group-runtime.mjs');
    const { codexUserTurns } = await import('./src/codex.mjs');
    const { ownerApprovalProof, recordOwnerApproval } = await import('./src/group-permissions.mjs');
    const [permissionId, ownerThreadId] = args.slice(1);
    if (!permissionId || !ownerThreadId) throw Error('Usage: group-owner-approval <group-id> <permission-id> <human-owner-thread-id>');
    const store = new GroupStore();
    try {
      const group = store.group(id), permission = store.permission(permissionId);
      if (group.status !== 'paused' || !permission || permission.groupId !== id || Object.values(group.contexts).includes(ownerThreadId) || group.approvalOwnerThreadId && group.approvalOwnerThreadId !== ownerThreadId) throw Error('Need a paused group and its separate, unchanged human owner chat.');
      if (!ownerApprovalProof(await codexUserTurns({ threadId: ownerThreadId, cwd: group.repo }), permission, ownerThreadId)) throw Error('No exact native human question reply was found; no owner or approval changed.');
      store.transaction(() => { const g = store.group(id); if (g.status !== 'paused' || g.epoch !== group.epoch || g.approvalOwnerThreadId && g.approvalOwnerThreadId !== ownerThreadId) throw Error('Group changed during source verification.'); g.approvalOwnerThreadId = ownerThreadId; store.save(g); });
      result = await recordOwnerApproval(store, new GroupRuntime(store), { groupId: id, permissionId });
    } finally { store.close(); }
  }
  else if (command === 'group-repair-empty-codex') {
    const { GroupStore } = await import('./src/group-store.mjs');
    const { GroupRuntime } = await import('./src/group-runtime.mjs');
    const store = new GroupStore();
    try { result = await new GroupRuntime(store).repairEmptyCodex(id); } finally { store.close(); }
  }
  else if (command === 'groups') result = await groupCall('/api/groups');
  else if (command === 'group-status') result = await groupCall(`/api/groups/${id}`);
  else if (command === 'group-create' || command === 'group-input') {
    const { readFileSync } = await import('node:fs');
    const input = JSON.parse(readFileSync(id, 'utf8'));
    result = await groupCall(command === 'group-create' ? '/api/groups' : `/api/groups/${input.groupId}/input`, input);
  } else if (command === 'start') {
    if (!id) throw new Error('Usage: node cli.mjs start path/to/goal.json');
    const { readFileSync } = await import('node:fs');
    result = await startGoal(JSON.parse(readFileSync(id, 'utf8')));
  } else if (command === 'list') result = listCollaborations({ offset: args[0], limit: args[1] });
  else if (command === 'transcript') result = readTranscript(id, args[1], args[2]);
  else if (command === 'run') result = await runGoal(id);
  else if (command === 'status') result = goalStatus(id);
  else if (command === 'pause') result = await setControl(id, { paused: true });
  else if (command === 'resume') result = await setControl(id, { paused: false });
  else if (command === 'stop') result = await setControl(id, { stop: true });
  else if (command === 'organize') result = await organizeSidebar(id);
  else if (command === 'adopt') result = await adoptCodexThread(id, args[1]);
  else if (command === 'approve') {
    const decision = args[1] === 'allow' ? 'allow' : args[1] === 'reject' ? 'reject' : null;
    if (!decision) throw new Error('Usage: node cli.mjs approve <goal-id> allow|reject <request-id>');
    const goal = readGoal(id);
    if (!goal) throw new Error(`Unknown goal: ${id}`);
    result = await decidePermission(id, decision, args[2]);
  } else throw new Error('Usage: node cli.mjs start|list|transcript|run|status|pause|resume|stop|organize|adopt|approve ...');
  process.stdout.write(JSON.stringify(result ?? { ok: true }) + '\n');
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
