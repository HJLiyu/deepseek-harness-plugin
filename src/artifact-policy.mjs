import {fileHash} from './project-files.mjs';
import {integrationFailure} from './integration-diagnostics.mjs';

export const retainedFiles = group => Object.fromEntries(Object.entries(group.artifactPolicy?.files??{}).map(([name,row])=>[name,row.hash]));

// A review decision has group lifetime, not action/request lifetime. Keep its
// exact source receipt and hash so future tasks cannot infer permission to
// overwrite retained local data from changes in a member worktree.
export function captureRetentionReview(group, files, before, receipt) {
  if(!Array.isArray(files)||files.length>1000||new Set(files).size!==files.length||files.some(n=>typeof n!=='string'))throw Error('Invalid preservedFiles review.');
  const policy=structuredClone(group.artifactPolicy??{version:1,files:{}});
  for(const name of files){
    const previous=Object.hasOwn(policy.files,name)?policy.files[name]:null;
    const expected=before?.main?.[name]??previous?.hash;
    if(!expected||fileHash(group.repo,name)!==expected)throw integrationFailure('main_conflict',{file:name,kind:'retention_review_changed'});
    if(previous&&previous.hash!==expected)throw integrationFailure('main_conflict',{file:name,kind:'retention_policy_conflict'});
    Object.defineProperty(policy.files,name,{value:{hash:expected,...receipt},enumerable:true,writable:true,configurable:true});
  }
  return policy;
}

export function importRetentionHistory(store, group) {
  if(group.artifactPolicy?.historyImported)return false;
  const policy=structuredClone(group.artifactPolicy??{version:1,files:{}});
  for(const request of store.requests(group.id)){
    if(request.status!=='completed')continue;
    for(const [key,result] of Object.entries(request.results??{})){
      if(!key.startsWith('review:')||result.status!=='done')continue;
      const raw=store.messageById(result.messageId),d=raw?.origin&&store.delivery(raw.origin.messageId);
      if(!raw?.protocol||raw.requestId!==request.id||raw.groupId!==group.id||d?.status!=='received'||d.phase!=='review'||d.member!==raw.sender||d.responseMessageId!==raw.id||d.requestId!==request.id||d.groupId!==group.id||d.revision!==request.revision)continue;
      let value;try{value=JSON.parse(raw.content)}catch{continue;}
      if(value.status!=='done'||!Array.isArray(value.preservedFiles)||value.preservedFiles.length>1000)continue;
      for(const name of value.preservedFiles){
        if(typeof name!=='string')continue;
        // Only historical coordinator snapshots establish retained versions.
        // A model's path list/prose alone can never establish a hash.
        const hash=request.integrationScope?.preserved?.[name]??request.integrationCheck?.before?.[name]??policy.files[name]?.hash;
        if(typeof hash!=='string'||!/^[a-f0-9]{64}$/.test(hash)||Object.hasOwn(request.integrationCheck?.expected??{},name))continue;
        if(!Object.hasOwn(policy.files,name))Object.defineProperty(policy.files,name,{value:{hash,requestId:request.id,messageId:raw.id},enumerable:true,writable:true,configurable:true});
      }
    }
  }
  policy.historyImported=true;group.artifactPolicy=policy;return true;
}

export function assertRetention(group, scope, consent) {
  const retained={...retainedFiles(group),...scope?.preserved};
  for(const [name,hash] of Object.entries(retained)){
    if(consent?.targets?.[name])continue; // Existing exact human overwrite consent still applies.
    if(fileHash(group.repo,name)!==hash)throw integrationFailure('main_conflict',{file:name,kind:'retained_artifact_changed'});
    const sources=scope?.members??(scope?.targets?{[scope.member]:scope.targets}:scope?.mainTargets?{main:scope.mainTargets}:{});
    if(Object.values(sources).some(files=>Object.hasOwn(files??{},name)))throw integrationFailure('main_conflict',{file:name,kind:'retained_artifact_selected'});
  }
  return retained;
}

export function settleRetentionConsent(group,request) {
  for(const [name,target] of Object.entries(request.integrationConsent?.targets??{})){
    if(Object.hasOwn(group.artifactPolicy?.files??{},name)&&request.integrationCheck?.verified?.[name]===target.wanted)
      group.artifactPolicy.files[name]={hash:target.wanted,requestId:request.id,sourceMessageId:request.integrationConsent.sourceMessageId};
  }
}
