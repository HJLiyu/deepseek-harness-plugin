// Calibration is an observation, never a promise about a provider's next bill.
export const CALIBRATION_VERSION='same-class-nearest-rank-p75-v1';
export function usageClass(group,member,phase) {
  const model=group.models?.[member];
  return JSON.stringify([member,phase,model?.model??null,model?.effort??null]);
}
export function calibrate(history,classKey) {
  const unique=new Map();
  for(const s of history)if(s?.classKey===classKey&&typeof s.deliveryId==='string'&&Number.isFinite(s.receivedAt)){
    const old=unique.get(s.deliveryId);
    if(!old)unique.set(s.deliveryId,s);
    // Conflicting receipts are not two samples, nor a trustworthy sample.
    else if(JSON.stringify(old)!==JSON.stringify(s))unique.set(s.deliveryId,{...old,classification:'unknown',tokens:null});
  }
  const window=[...unique.values()].sort((a,b)=>b.receivedAt-a.receivedAt||a.deliveryId.localeCompare(b.deliveryId)).slice(0,20);
  const valid=window.filter(s=>s.classification==='complete'&&['delivery','allModelCalls'].includes(s.scope)&&Number.isSafeInteger(s.tokens)&&s.tokens>=0);
  const sorted=valid.map(s=>s.tokens).sort((a,b)=>a-b),ready=valid.length>=10;
  return {state:ready?'calibrated':'uncalibrated',algorithm:'nearest-rank',version:CALIBRATION_VERSION,percentile:75,classKey,
    windowSize:window.length,sampleCount:valid.length,minimumSamples:10,maximumWindow:20,
    threshold:ready?sorted[Math.ceil(sorted.length*0.75)-1]:null,unit:'tokensPerReceivedDelivery',
    evidence:valid.map(s=>({deliveryId:s.deliveryId,requestId:s.requestId,receivedAt:s.receivedAt,tokens:s.tokens}))};
}
function calibrationHistory(store,group) {
  const history=store.db.prepare('SELECT value FROM deliveries WHERE group_id=?').all(group.id).map(r=>JSON.parse(r.value))
    .filter(d=>{if(d.status!=='received'||d.usageObservation?.deliveryId!==d.id||d.usageObservation?.requestId!==d.requestId||d.usageObservation?.classKey!==d.usageClass)return false;const msg=store.messageById(d.responseMessageId);return msg?.requestId===d.requestId&&msg?.groupId===group.id&&msg?.sender===d.member;})
    .map(d=>d.usageObservation).filter(Boolean);
  return history;
}
export function calibrationFor(store,group,member,phase) {
  return calibrate(calibrationHistory(store,group),usageClass(group,member,phase));
}
// One consistent read per HTTP projection, not a long-lived admission cache.
// A later response always sees newly settled receipts and updated model keys.
export function calibrationSnapshot(store,group) {
  const history=calibrationHistory(store,group),cache=new Map();
  return (member,phase)=>{const key=usageClass(group,member,phase);if(!cache.has(key))cache.set(key,calibrate(history,key));return cache.get(key);};
}
export function budgetPolicy(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Invalid budget policy.');
  for(const key of Object.keys(value))if(!['softTokens','hardTokens','calibratedReminder'].includes(key))throw Error('Unknown budget policy field.');
  for(const key of ['softTokens','hardTokens'])if(value[key]!==undefined&&value[key]!==null&&(!Number.isSafeInteger(value[key])||value[key]<1))throw Error('Budget thresholds must be positive integers or null.');
  if(value.calibratedReminder!==undefined&&typeof value.calibratedReminder!=='boolean')throw Error('Invalid calibrated reminder.');
  return {softTokens:value.softTokens??null,hardTokens:value.hardTokens??null,calibratedReminder:value.calibratedReminder??false};
}
export function budgetDecision(usage={},policy={},calibration=null) {
  const p=budgetPolicy(policy),known=Number.isSafeInteger(usage.knownTokens)?usage.knownTokens:null;
  const samples=Object.values(usage.observation?.samples??{});
  const complete=usage.calls===samples.length&&samples.every(s=>s.classification==='complete')&&usage.unknownCalls===0;
  const soft=p.softTokens!==null&&known!==null&&known>=p.softTokens;
  // Hosts cannot atomically cap a native turn's token use. A strict requested
  // maximum must stop new admission even if P75 is below the remaining amount.
  const reason=p.hardTokens===null?null:known!==null&&known>=p.hardTokens?'hard_threshold_reached':!complete?'hard_usage_unknown':'host_hard_cap_unavailable';
  return {admit:reason===null,reason,softReminder:soft,knownTokensLowerBound:known,usageComplete:complete,
    hardLimit:p.hardTokens,hardEnforcement:p.hardTokens===null?'disabled':'refuse_uncapped_native_admission',
    estimatedNextTokens:calibration?.state==='calibrated'?calibration.threshold:null,
    estimateIsHardLimit:false,cost:null,costState:'unknown'};
}
