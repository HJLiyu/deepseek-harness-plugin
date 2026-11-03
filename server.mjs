import readline from 'node:readline';
import { startGoal, goalStatus, setControl, organizeSidebar, decidePermission, adoptCodexThread } from './src/orchestrator.mjs';
import { readEvents } from './src/events.mjs';
import { readTranscript } from './src/messages.mjs';
import { listCollaborations } from './src/catalog.mjs';
import { groupCall, groupPage } from './src/group-client.mjs';
import { rememberDesktopBridge } from './src/desktop.mjs';

rememberDesktopBridge();

const tools = [
  { name: 'create_group', description: 'Create a persistent project group with two dedicated contexts and independent worktrees. Requires the Harness companion. Includes one short read-only Codex initialization turn so the native context is durable.', inputSchema: { type: 'object', required: ['codexModel', 'harnessModel'], properties: { createProject: { type: 'boolean', description: 'Initialize a new Git project from projectsRoot and projectName; refuses existing directories.' }, projectsRoot: { type: 'string', description: 'Absolute parent directory for a new project.' }, projectName: { type: 'string' }, workspacePath: { type: 'string', description: 'Existing Git project path; required unless createProject is true.' }, title: { type: 'string' }, codexModel: { type: 'string' }, codexEffort: { type: 'string' }, harnessModel: { type: 'string' }, peerConnectionId: { type: 'string', description: 'Saved API or CLI connection ID; omit for native Harness.' }, approvalOwnerThreadId: { type: 'string', description: 'Separate native human Codex approval chat; defaults to the invoking chat.' }, harnessProvider: { type: 'string' }, harnessEffort: { type: 'string' }, maxDiscussionRounds: { type: 'integer', minimum: 1, maximum: 24, default: 3 } } } },
  { name: 'group_page', description: 'Open the shared project group page. Use its returned URL with open_in_codex. The page contains group and visible peer collaboration channels. URL contains a local access capability; do not publish it.', inputSchema: { type: 'object', properties: { groupId: { type: 'string' } } } },
  { name: 'list_groups', description: 'List persistent project groups without loading message history.', inputSchema: { type: 'object', properties: {} } },
  { name: 'group_status', description: 'Read persistent contexts, queue, division and usage. Unknown usage stays unknown.', inputSchema: { type: 'object', required: ['groupId'], properties: { groupId: { type: 'string' } } } },
  { name: 'group_input', description: 'Submit a human project requirement to the group queue. Never use for agent replies or as an approval. Use stable inputId across retries. Supplements steer current work; urgent requests preempt.', inputSchema: { type: 'object', required: ['groupId', 'content', 'inputId'], properties: { groupId: { type: 'string' }, content: { type: 'string' }, inputId: { type: 'string' }, channel: { type: 'string', enum: ['group', 'collaboration'] }, mode: { type: 'string', enum: ['new', 'supplement', 'urgent'] }, requestId: { type: 'string' }, maxDiscussionRounds: { type: 'integer', minimum: 1, maximum: 24 }, alertTokens: { type: 'integer', minimum: 1 }, hardTokenLimit: { type: 'integer', minimum: 1, description: 'Unsupported strict caps pause admission rather than silently overrun.' } } } },
  { name: 'group_messages', description: 'Read bounded original group messages by sequence cursor, optionally filtering channel. This is also the retrieval path for compressed delivery context.', inputSchema: { type: 'object', required: ['groupId'], properties: { groupId: { type: 'string' }, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200 }, channel: { type: 'string', enum: ['group', 'collaboration'] } } } },
  { name: 'group_control', description: 'Pause/resume/close a group, read/settle an existing native checkpoint without a model call, or retry a known blocked checkpoint. Never blindly repeat uncertain execution.', inputSchema: { type: 'object', required: ['groupId', 'action'], properties: { groupId: { type: 'string' }, action: { type: 'string', enum: ['pause', 'resume', 'close', 'retry', 'settle'] } } } },
  { name: 'list_collaborations', description: 'List saved collaboration goals with bounded pagination, progress, stop reason and pending work; excludes message bodies.', inputSchema: { type: 'object', properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 }, status: { type: 'string' } } } },
  { name: 'collaboration_transcript', description: 'Read a bounded canonical transcript with stable message IDs, replyTo, sender/source, native thread identity and stop reason. Reads existing rotated events without duplicating storage.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } } },
  { name: 'start_collaboration', description: 'Start direct Codex ↔ DeepSeek Harness collaboration on an authorized Git project. Creates the native Codex thread and moves it into the Codex × Harness sidebar section. Harness changes are confined to an independent Git worktree.', inputSchema: { type: 'object', required: ['objective', 'workspacePath'], properties: { objective: { type: 'string' }, workspacePath: { type: 'string' }, acceptanceCriteria: { type: 'string' }, maxRounds: { type: 'integer', minimum: 1, maximum: 100, default: 24 }, deepseekModel: { type: 'string', default: 'deepseek-v4-flash' }, existingThreadId: { type: 'string' } } } },
  { name: 'collaboration_status', description: 'Read goal progress, pending permission requests, native chat ID, worker liveness, sidebar section, and worktree status.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' } } } },
  { name: 'pause_collaboration', description: 'Pause automatic Codex–Harness turns for a goal. The worker stays alive and resumes without a lock race.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' } } } },
  { name: 'resume_collaboration', description: 'Resume a paused Codex–Harness goal, including goals paused after a turn error.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' } } } },
  { name: 'stop_collaboration', description: 'Stop a goal without removing chat history or worktree.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' } } } },
  { name: 'decide_harness_permission', description: 'Record a real human decision for the pending Harness permission request. Only call after the human explicitly approves or rejects this specific request.', inputSchema: { type: 'object', required: ['goalId', 'decision'], properties: { goalId: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'reject'] }, requestId: { type: 'string', description: 'Optional echo of collaboration_status.pendingApproval.requestId; mismatches are rejected.' } } } },
  { name: 'organize_sidebar', description: 'Create or reuse the native Codex × Harness sidebar section and move this goal’s Codex thread into it. Idempotent repair for start_collaboration.sidebar_failed.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' } } } },
  { name: 'adopt_codex_thread', description: 'Adopt a native Codex thread at a paused goal checkpoint with no pending approval or undelivered Harness message. Verifies native messages and sidebar, then atomically updates the thread binding.', inputSchema: { type: 'object', required: ['goalId', 'threadId'], properties: { goalId: { type: 'string' }, threadId: { type: 'string', minLength: 1 } } } },
  { name: 'collaboration_events', description: 'Read a bounded page of detailed Codex and Harness messages and tool events for a goal.', inputSchema: { type: 'object', required: ['goalId'], properties: { goalId: { type: 'string' }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } } } },
];

for (const tool of tools) {
  tool.annotations = {
    readOnlyHint: ['collaboration_status', 'collaboration_events', 'collaboration_transcript', 'list_collaborations', 'group_status', 'group_messages', 'list_groups'].includes(tool.name),
    destructiveHint: false,
    idempotentHint: !['start_collaboration', 'create_group'].includes(tool.name),
    openWorldHint: ['start_collaboration', 'create_group', 'group_input'].includes(tool.name),
  };
  if (tool.name === 'decide_harness_permission') {
    tool.inputSchema.required.push('requestId');
    tool.inputSchema.properties.requestId.description = 'Exact pendingApproval.requestId; a fresh human approval or rejection phrase in the native chat is required.';
  }
}

async function call(name, args) {
  if (name === 'group_page') return groupPage(args.groupId);
  if (name === 'create_group') return groupCall('/api/groups', {...args,approvalOwnerThreadId:args.approvalOwnerThreadId||process.env.CODEX_THREAD_ID});
  if (name === 'list_groups') return groupCall('/api/groups');
  if (name === 'group_status') return groupCall(`/api/groups/${encodeURIComponent(args.groupId)}`);
  if (name === 'group_messages') {
    const query = new URLSearchParams(); for (const key of ['after', 'limit', 'channel']) if (args[key] !== undefined) query.set(key, args[key]);
    return groupCall(`/api/groups/${encodeURIComponent(args.groupId)}/messages?${query}`);
  }
  if (name === 'group_control') return groupCall(`/api/groups/${encodeURIComponent(args.groupId)}/control`, { action: args.action });
  if (name === 'group_input') {
    if (!args.inputId) throw new Error('Stable inputId is required.');
    return groupCall(`/api/groups/${encodeURIComponent(args.groupId)}/input`, { ...args,
      origin: { adapter: 'codex-tool', sessionId: process.env.CODEX_THREAD_ID ?? args.groupId, messageId: args.inputId } });
  }
  const id = args.goalId;
  if (name === 'list_collaborations') return listCollaborations(args);
  if (name === 'collaboration_transcript') return readTranscript(id, args.offset, args.limit);
  if (name === 'start_collaboration') return startGoal(args);
  if (name === 'collaboration_status') return goalStatus(id);
  if (name === 'pause_collaboration') return setControl(id, { paused: true });
  if (name === 'resume_collaboration') return setControl(id, { paused: false });
  if (name === 'stop_collaboration') return setControl(id, { stop: true });
  if (name === 'decide_harness_permission') {
    return decidePermission(id, args.decision, args.requestId);
  }
  if (name === 'organize_sidebar') return organizeSidebar(id);
  if (name === 'adopt_codex_thread') return adoptCodexThread(id, args.threadId);
  if (name === 'collaboration_events') return readEvents(id, args.offset, args.limit);
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  if (message.id === undefined) return;
  const reply = { jsonrpc: '2.0', id: message.id };
  try {
    if (message.method === 'initialize') reply.result = { protocolVersion: message.params?.protocolVersion ?? '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'codex-deepseek-harness', version: '0.3.2' } };
    else if (message.method === 'ping') reply.result = {};
    else if (message.method === 'tools/list') reply.result = { tools };
    else if (message.method === 'tools/call') {
      const result = await call(message.params?.name, message.params?.arguments ?? {});
      reply.result = { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } else reply.error = { code: -32601, message: `Method not found: ${message.method}` };
  } catch (error) {
    reply.result = { content: [{ type: 'text', text: error.message }], isError: true };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
}

// Tool calls can block for minutes (start_collaboration runs a Codex turn).
// Handle them concurrently so status/pause/stop remain available while a start
// or approval notice is in flight.
const tasks = new Set();
const input = readline.createInterface({ input: process.stdin });
for await (const line of input) {
  let message;
  try { message = JSON.parse(line); } catch { continue; }
  if (message.id === undefined) continue;
  const task = handle(message).catch(error => {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true } }) + '\n');
  });
  tasks.add(task);
  task.finally(() => tasks.delete(task));
}
await Promise.allSettled(tasks);
