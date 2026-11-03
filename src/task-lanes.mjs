// Increment A: authoritative lane-backed compatibility properties. Parallel
// admission remains disabled until the later capacity and dispatch increments.
const bindings = new WeakMap();
const provenance = ['workBaselines','workCandidates','integrationScope','integrationCheck','integrationReadyReceipt','readinessBaseline','readinessBaselines'];
const fields = ['deliveryId','actions','results',...provenance];
function migrateProvenance(request,lane) {
  if(lane.provenanceVersion===1)return;
  for(const field of provenance)if(!Object.hasOwn(lane,field)&&Object.hasOwn(request,field)&&request[field]!==undefined)lane[field]=structuredClone(request[field]);
  lane.provenanceVersion=1;
}
function bind(request, lane) {
  bindings.set(request,lane);
  for (const field of fields) Object.defineProperty(request,field,{
    enumerable:true,configurable:true,
    get:()=>lane[field] ?? (field==='actions'?[]:field==='results'?{}:undefined),
    set:value=>{lane[field]=value;}
  });
  return request;
}
export function selectLane(request,key) {
  const lane=request.lanes?.[key];
  if(!lane||lane.requestId!==request.id)throw Error('Unknown lane identity.');
  request.activeLaneKey=key;return bind(request,lane);
}
export function laneRequest(request) {
  if (!request || bindings.has(request)) return request;
  request.lanes ??= {};
  let lane=request.activeLaneKey && request.lanes[request.activeLaneKey];
  if (!lane) {
    const pending=Object.values(request.lanes).filter(l=>l.deliveryId);
    if(pending.length>1)throw Error('Multiple lane checkpoints require an explicit lane identity.');
    lane=pending[0] ?? migrateLegacyLane(request);
  }
  if(lane.requestId!==request.id)throw Error('Lane request identity mismatch.');
  migrateProvenance(request,lane);
  request.activeLaneKey=lane.key;lane.migration='lane-backed';
  if(lane.deliveryId&&lane.taskId)request.currentTaskId=lane.taskId;
  return bind(request,lane);
}
export function prepareLaneSave(request) {
  const lane=bindings.get(request);
  if(!lane)return laneRequest(request);
  // Legacy delete statements are writes to the lane, never permission to read
  // an older singleton checkpoint back into it.
  for(const field of fields)if(!Object.hasOwn(request,field))delete lane[field];
  lane.status=request.status;
  return bind(request,lane);
}
export function activateTaskLane(request,taskId) {
  prepareLaneSave(request);const previous=bindings.get(request);
  if(previous.deliveryId)throw Error('Original lane checkpoint must settle before task switch.');
  const key=`${request.id}:${request.revision}:${taskId}`;
  const lane=request.lanes[key]??={key,requestId:request.id,revision:request.revision,taskId,actions:[],results:{},terminalEvents:[],provenanceVersion:1};
  request.activeLaneKey=key;bind(request,lane);return lane;
}
export function migrateLegacyLane(request) {
  request.lanes ??= {};
  const key = `${request.id}:${request.revision}:${request.currentTaskId ?? 'legacy'}`;
  if (!request.lanes[key]) request.lanes[key] = {
    key, requestId:request.id, revision:request.revision,
    taskId:request.currentTaskId ?? null, deliveryId:request.deliveryId ?? null,
    actions:structuredClone(request.actions ?? []), results:structuredClone(request.results ?? {}),
    status:request.status, migration:'snapshot-only', terminalEvents:[]
  };
  migrateProvenance(request,request.lanes[key]);
  return request.lanes[key];
}

export function settleLane(lane, receipt) {
  if (receipt.requestId !== lane.requestId || receipt.revision !== lane.revision ||
      receipt.deliveryId !== lane.deliveryId || typeof receipt.eventId !== 'string' || !receipt.eventId) return false;
  if (lane.terminalEvents.includes(receipt.eventId)) return false;
  if (!['received','not_admitted'].includes(receipt.state) || receipt.verified !== true) return false;
  lane.terminalEvents.push(receipt.eventId);
  lane.receipts ??= [];lane.receipts.push(structuredClone(receipt));
  lane.deliveryId = null;
  return true;
}

// Persist snapshots without claiming they are authoritative execution lanes.
// Existing readers remain on the legacy slot until their migration is complete.
export function checkpointLegacyLane(store, requestId) {
  return store.transaction(() => {
    const request = store.request(requestId);
    if (!request) throw Error('Unknown request.');
    laneRequest(request);
    const lane = bindings.get(request);
    store.saveRequest(request);
    return structuredClone(lane);
  });
}
