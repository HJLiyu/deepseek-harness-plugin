import {judgmentBinding} from './independent-review.mjs';
const proof=x=>Array.isArray(x)&&x.length>0&&x.length<=20&&x.every(s=>typeof s==='string'&&s.trim()&&s.length<=2000);
export function recordCrossOutcome(request,value,messageId,deliveryId,issue=null) {
 const action=request.actions?.[0],key=action?.crossReviewKey,initial=request.independentJudgments?.[key];
 if(!key||!initial||!value)return false;
 request.reviewOutcomes??={};if(request.reviewOutcomes[deliveryId])return false;
 const current=judgmentBinding(request,action)?.key===key;
 const changed=initial.verdict!==value.status,newEvidence=proof(value.judgmentChange?.evidence)&&value.judgmentChange.evidence.some(e=>!initial.evidence.includes(e));
 const peerDone=initial.work?.length&&initial.work.every(([k])=>request.results[k]?.status==='done');
 const following=current&&changed&&value.status==='done'&&peerDone&&!newEvidence;
 request.reviewOutcomes[deliveryId]={deliveryId,messageId,initialKey:key,initialMessageId:initial.messageId,member:action.member,revision:request.revision,taskId:request.currentTaskId??null,
   verdict:value.status,initialVerdict:initial.verdict,changed,newEvidence:Boolean(newEvidence),accepted:!issue,issue,
   category:following?'unsubstantiated_following':'unknown',basis:following?'changed_to_peer_done_without_new_evidence':'awaiting_evidence_based_resolution',
   evidence:structuredClone(value.judgmentChange?.evidence??[]),resolution:null};return true;
}
// Semantic defect/false-opposition labels require an explicit later resolution
// from the other member and linked original messages. They are peer annotations,
// not an objective score inferred from rejection or agreement rates.
export function recordQualityResolutions(store,request,value,messageId,deliveryId) {
 if(value?.status!=='done'||!Array.isArray(value?.qualityResolutions))return;
 const source=store.messageById(messageId),delivery=store.delivery(deliveryId);
 if(delivery?.status!=='received'||delivery.requestId!==request.id||delivery.groupId!==request.groupId||source?.groupId!==request.groupId||delivery.responseMessageId!==messageId||source?.sender!==delivery.member||source?.requestId!==request.id)return;
 request.qualityResolutionAudit??={};if(request.qualityResolutionAudit[deliveryId])return;
 const audit=[];
 for(const proposal of value.qualityResolutions.slice(0,20)){
  if(!proposal||typeof proposal!=='object'){audit.push({accepted:false,reason:'invalid_resolution'});continue;}
  const outcome=request.reviewOutcomes?.[proposal.reviewDeliveryId],initial=request.independentJudgments?.[outcome?.initialKey];
  const ids=proposal.evidenceMessageIds;
  const valid=outcome&&initial&&source.sender!==outcome.member&&initial.verdict==='changes_requested'&&
   ['true_defect','false_opposition'].includes(proposal.category)&&proof(proposal.evidence)&&proof(ids)&&
   ids.includes(initial.messageId)&&ids.includes(outcome.messageId)&&ids.every(id=>{const m=store.messageById(id);return m?.groupId===request.groupId&&m?.requestId===request.id;});
  if(!valid||outcome.resolution){audit.push({reviewDeliveryId:proposal.reviewDeliveryId??null,accepted:false,reason:'invalid_or_already_resolved'});continue;}
  outcome.resolution={category:proposal.category,member:source.sender,messageId,deliveryId,evidence:proposal.evidence,evidenceMessageIds:ids,basis:'explicitPeerResolution'};
  audit.push({reviewDeliveryId:outcome.deliveryId,accepted:true});
 }
 request.qualityResolutionAudit[deliveryId]=audit;
}
export function qualityMetrics(request) {
 const outcomes=Object.values(request.reviewOutcomes??{});
 const rows=outcomes.map(o=>({...o,category:o.resolution?.category??o.category}));
 const count=c=>rows.filter(o=>o.category===c).length;
 return {version:1,unit:'crossReviewReceipt',denominator:rows.length,initialJudgments:Object.keys(request.independentJudgments??{}).length,
   trueDefects:count('true_defect'),falseOppositions:count('false_opposition'),unsubstantiatedFollowing:count('unsubstantiated_following'),unknown:count('unknown'),
   classificationBasis:'explicit peer resolutions or auditable missing-evidence rule; not rejection rate',evidence:rows};
}
