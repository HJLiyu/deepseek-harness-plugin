import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir } from '../src/state.mjs';
import { GroupStore } from '../src/group-store.mjs';
import { ensureGroupService } from '../src/group-client.mjs';
import { localFetch } from '../src/group-http.mjs';
import { rememberDesktopBridge } from '../src/desktop.mjs';

let text = ''; for await (const chunk of process.stdin) { text += chunk; if (text.length > 1024 * 1024) throw new Error('Hook payload too large.'); }
const input = JSON.parse(text);
let bound = false;
try {
  // Any trusted native hook invocation can carry the new app instance's pair.
  // Refresh even for an unbound maintenance chat; never start its group daemon.
  rememberDesktopBridge();
  // Unbound chats incur no daemon startup and no model call.
  const file = path.join(dataDir, 'groups.sqlite');
  if (fs.existsSync(file)) {
    bound = true; // If binding lookup itself fails, do not silently fall through to independent execution.
    const store = new GroupStore(file);
    try { bound = Boolean(store.originFor('codex', input.session_id)); } finally { store.close(); }
  }
  if (input.hook_event_name === 'SessionStart') {
    if (bound) await ensureGroupService();
  } else if (input.hook_event_name === 'UserPromptSubmit' && bound) {
    const result = await localFetch(await ensureGroupService(), '/api/native', {
      adapter: 'codex', sessionId: input.session_id, turnId: input.turn_id,
      messageId: input.message_id ?? input.prompt_id ?? `${input.turn_id}:${createHash('sha256').update(input.prompt).digest('hex')}`, content: input.prompt,
    });
    if (result.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: result.reason ?? (result.duplicateDispatch ? '该代理投递已接收或处理，已阻止重复执行，不会转成新的真人需求。' : `已交给群 ${result.groupId} 调度。请在共享群聊查看双方回复；原生会话不重复执行。`) }));
    else if (result.approvalCandidate) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '这是本群真人对单次原生权限请求的确认记录。只简短确认已记录，不调用工具、不更改文件，不将它转成新的项目需求。是否批准由协调器核验新增原生记录决定。' } }));
  }
} catch (error) {
  // For a bound thread, a routing outage must never fall through to a second independent execution.
  if (bound) process.stdout.write(JSON.stringify({ decision: 'block', reason: `群输入接管失败，已阻止重复执行：${String(error.message).slice(0, 1000)}` }));
  else { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
