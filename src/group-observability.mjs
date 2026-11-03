// Counts are received native deliveries, not hidden provider model calls.
export function usageSample(result) {
 const u=result.usage;
 const n=Number.isSafeInteger(u?.totalTokens)&&u.totalTokens>=0?u.totalTokens:
  [u?.inputTokens,u?.outputTokens].every(v=>Number.isSafeInteger(v)&&v>=0)&&Number.isSafeInteger(u.inputTokens+u.outputTokens)?u.inputTokens+u.outputTokens:null;
 return {tokens:n,classification:n===null?'unknown':result.usageScope==='lastModelCall'?'partial':'complete',scope:result.usageScope||'delivery'};
}
export function recordUsage(usage,deliveryId,result) {
 usage.observation ||= {version:1,samples:{}};
 if(Object.hasOwn(usage.observation.samples,deliveryId))return false;
 const sample=usageSample(result);usage.observation.samples[deliveryId]=sample;
 usage.calls++;if(sample.classification!=='complete')usage.unknownCalls++;
 if(sample.tokens!==null)usage.knownTokens+=sample.tokens;
 return true;
}
export function budgetObservation(usage={},calibration=null) {
 const samples=Object.values(usage.observation?.samples||{});
 const count=k=>samples.filter(s=>s.classification===k).length;
 const legacy=Math.max(0,(usage.calls||0)-samples.length);
 return {state:calibration?.state??'uncalibrated',threshold:calibration?.threshold??null,calibration,unit:'receivedDelivery',knownTokensLowerBound:usage.knownTokens??null,
  completeDeliveries:count('complete'),partialDeliveries:count('partial'),unknownDeliveries:count('unknown'),legacyUnclassifiedDeliveries:legacy,
  incompleteDeliveries:usage.unknownCalls??null,totalDeliveries:usage.calls??null,
  incompleteDeliveryRatio:Number.isSafeInteger(usage.calls)&&usage.calls>0&&Number.isSafeInteger(usage.unknownCalls)&&usage.unknownCalls>=0&&usage.unknownCalls<=usage.calls?usage.unknownCalls/usage.calls:null};
}
export function parallelConfiguration(value=2,observation=null) {
 if(!Number.isSafeInteger(value)||value<1||value>16)throw Error('maxExecutors must be an integer from 1 to 16.');
 return {maxExecutors:value,effectiveMaxExecutors:Math.min(value,2),schedulingImplemented:observation?.schedulingImplemented===true,occupancy:observation?.schedulingImplemented===true?observation.occupancy:null,occupancyUnit:observation?.unit??null,reservedOccupancy:observation?.occupancy??null,unsettledDeliveries:observation?.unsettledDeliveries??null,validatedWith:observation?.validatedWith??null,validation:observation?.validation??null};
}
export function strengthObservation(effort,member) {
 return {expected:effort??null,requested:null,confirmed:null,source:'groupConfiguration',member,status:'not_requested',confirmation:null};
}
