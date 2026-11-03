import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCommand, sameCommand, looksLikeCommand } from '../src/approval-text.mjs';
import { GroupStore } from '../src/group-store.mjs';
import { GroupPermissions } from '../src/group-permissions.mjs';
import { GroupRuntime } from '../src/group-runtime.mjs';
import { nativeHumanProof } from '../companion/human-proof.mjs';
import { routeNative } from '../src/group-service.mjs';

const phrase = '批准 2026-10-20-837dba4d 67c1e969-0000-4000-8000-000000000001';
test('rich-text whole-line rejection denies only; formatted grants, quotes and surrounding prose never authorize',()=>{
 const reject=phrase.replace('批准','拒绝');
 for(const suffix of ['', '  \n','\r\n'])assert.equal(sameCommand('**'+reject+'**'+suffix,reject),true);
 assert.equal(parseCommand('**'+phrase+'**  \n'),null);assert.equal(looksLikeCommand('**'+phrase+'**  \n'),true);
 for(const text of ['> **'+reject+'**','说明：**'+reject+'**','**'+reject+'** 然后继续','**'+reject+'**\n其他文字','**'+reject,'`'+reject+'`'])assert.equal(parseCommand(text),null);
});
test('strict approval grammar accepts only the documented transport suffix', () => {
  for (const suffix of ['', ' ', '\t', '\n', '\r\n', ' \t\r\n']) {
    assert.ok(parseCommand(phrase + suffix));
    assert.equal(sameCommand(phrase + suffix, phrase), true);
  }
  for (const text of [phrase+'\n\n', phrase+'\r', phrase+'\r\r\n', phrase+'\n ', phrase+'\u2028',
    phrase+' explanation', ' '+phrase, phrase.replace('批准 ', '批准\t'), phrase.replace('批准 ', '批准  '),
    phrase.replace(' 67', '\n67'), phrase.replace('000000000001', '00000000000z')]) {
    assert.equal(parseCommand(text), null, JSON.stringify(text));
    assert.equal(sameCommand(text, text), false);
  }
  assert.equal(sameCommand(phrase, phrase.replace('批准', '拒绝')), false);
});

// Exercise candidate -> production runtime proof -> durable one-shot settlement.
// Native records are fixtures; no real host request or approval is issued.
for (const confirmBy of ['codex', 'harness']) for (const decision of ['allow', 'reject']) for (const candidateSuffix of (decision==='reject'?['\n','\r\n','bold']:['\n','\r\n'])) {
  test(`${confirmBy} native ${decision} ${JSON.stringify(candidateSuffix)}: fresh proof and one consumption`, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-path-'));
    const store = new GroupStore(path.join(dir, 'groups.sqlite'));
    t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const group = store.create({ repo: dir, models: { codex: {}, harness: {} } });
    group.contexts = { codex: 'ct', harness: 'ht' }; group.worktrees = { codex: dir, harness: dir };
    const { request } = store.input(group.id, { content: 'fixture operation' });
    const delivery = { id: randomUUID(), groupId: group.id, requestId: request.id, member: confirmBy === 'codex' ? 'harness' : 'codex',
      phase: 'work', status: 'pending', nativeTurnId: 'operation' };
    group.activeRequestId = request.id; group.status = 'active'; group.harnessAdapterId = 'harness-desktop';
    request.status = 'active'; request.deliveryId = delivery.id;
    store.save(group); store.saveRequest(request); store.saveDelivery(delivery);
    let turns = [{ turnId: 'old', itemId: 'old-item', status: 'completed', text: phrase }];
    const runtime = new GroupRuntime(store, { readUserTurns: async () => turns });
    // The Harness runtime branch calls its authenticated native proof endpoint.
    // Override the adapter descriptor with a local fixture HTTP server below.
    const http = await import('node:http');
    let events = [], receivedContent;
    const token = 'fixture-token';
    const server = http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      let raw=''; for await (const part of req) raw+=part;
      const body=JSON.parse(raw);
      const value = req.url === '/permission-snapshot' ? { seq: 10 } :
        (receivedContent=body.content, { adapterId:'harness-desktop', proof:nativeHumanProof(events,body) });
      res.setHeader('content-type','application/json'); res.end(JSON.stringify(value));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    runtime.adapter = () => ({ url:`http://127.0.0.1:${server.address().port}`, token, features:['human-proof-v1'] });
    const permissions = new GroupPermissions(store, runtime), abort = new AbortController();
    t.after(()=>abort.abort());
    const details = delivery.member === 'harness'
      ? { method:'harness/tool', params:{callId:'call-fixture',toolName:'pwsh',arguments:{command:'fixture marker'}} }
      : { method:'item/commandExecution/requestApproval',params:{threadId:'ct',turnId:'operation',command:'fixture marker'} };
    const pending = permissions.request(group,delivery,details,abort.signal);
    while (!store.permissions(group.id).length) await new Promise(setImmediate);
    const record=store.permissions(group.id).at(-1), text=(decision==='allow'?record.allowPhrase:record.rejectPhrase);
    const candidateText=candidateSuffix==='bold'?'**'+text+'**  \n':text+candidateSuffix;
    const hint={adapter:confirmBy,sessionId:group.contexts[confirmBy],messageId:'fresh',turnId:'fresh-turn',content:candidateText};
    assert.equal(permissions.candidate(group,{...hint,sessionId:'wrong'}).approvalCandidate,undefined);
    assert.equal(permissions.candidate(group,{...hint,content:text.replace(group.id,'2020-01-01-00000000')}).approvalCandidate,undefined);
    assert.equal(permissions.candidate(group,{...hint,content:text+' explanation'}).approvalCandidate,undefined);
    const beforeRevision=store.request(request.id).revision;
    const accepted=candidateSuffix==='bold'?routeNative(store,{interrupt(){assert.fail('a formatted rejection must not steer the task')}},{...hint,harnessAdapterId:'harness-desktop'},permissions):permissions.candidate(group,hint);
    assert.equal(accepted.approvalCandidate,true);assert.equal(store.request(request.id).revision,beforeRevision);
    assert.equal(store.permission(record.id).candidate.content,candidateText);
    // Old native record, non-completed turn and model/controller entries cannot grant.
    turns=[{turnId:'old',itemId:'old-item',status:'completed',text:text+'\r\n'},
      {turnId:'fresh-turn',itemId:'fresh-item',status:'inProgress',text:text+'\r\n'}];
    events=[{type:'user/message',seq:9,data:{id:'fresh',role:'user',source:{kind:'user',rpcId:'ui'},content:[{type:'text',text}] }},
      {type:'user/message',seq:11,data:{id:'fresh',role:'user',source:{kind:'user',rpcId:'group-controller'},content:[{type:'text',text}] }}];
    await permissions.active.get(record.id).check();
    assert.equal(store.permission(record.id).status,'pending');
    turns=[{turnId:'fresh-turn',itemId:'fresh-item',status:'completed',text:text+'\r\n'}];
    events.push({type:'user/message',seq:12,data:{id:'fresh',role:'user',source:{kind:'user',rpcId:'native-ui'},content:[{type:'text',text:text+'\r\n'}]}});
    await permissions.active.get(record.id).check();
    assert.equal(await pending,decision==='allow');
    assert.equal(store.permission(record.id).status,decision==='allow'?'allowed_once':'rejected');
    assert.equal(store.permission(record.id).proof.adapter,confirmBy);
    if(confirmBy==='harness') assert.equal(receivedContent,candidateText,'runtime passes the original text to the native endpoint');
    assert.equal(permissions.candidate(group,hint).approvalCandidate,undefined);
    assert.equal(permissions.active.has(record.id),false);
  });
}
