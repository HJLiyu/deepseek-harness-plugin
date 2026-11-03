import path from 'node:path';
import {dataDir,readJson,assertGoalId} from './state.mjs';
import {localFetch} from './group-http.mjs';
// Tool use must never drain, update or start a coordinator during a native turn.
export async function toolServiceCall(groupId,action,body){
  assertGoalId(groupId);
  if(!['tools','tool-call','tool-calls','scopes','scope-request','scope-refresh','scope-revoke','scope-release-evidence','scope-release'].includes(action)||(!['tools','tool-calls','scopes'].includes(action))!==(body!==undefined))throw Error('Invalid tool service request.');
  const descriptor=readJson(path.join(dataDir,'group-service.json'),null);
  if(!descriptor)throw Error('Existing tool service is unavailable; no call was dispatched.');
  return localFetch(descriptor,`/api/groups/${groupId}/${action}`,body,{timeoutMs:125000});
}
