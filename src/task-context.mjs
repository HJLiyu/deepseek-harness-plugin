// Reused local task projection; original coordinator records remain authoritative.
const fields=['taskId','key','index','title','task','owner','deps','status','acceptance','revision','readOnly','resources'];
const messageId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function projectTaskContext(tasks,{mode='compact',resolveEvidence,groupId,requestId}={}) {
  if(!Array.isArray(tasks)||!['compact','full'].includes(mode))throw Error('Invalid task context policy.');
  const projected=mode==='full'?structuredClone(tasks):tasks.map(task=>{
    if(!task||typeof task!=='object'||Array.isArray(task))throw Error('Invalid task context record.');
    if(task.status!=='done')return structuredClone(task);
    const out={};for(const key of fields)if(Object.hasOwn(task,key))out[key]=structuredClone(task[key]);
    const receipts=Object.values(task.receipts??{}),ids=[];
    const resolved=receipts.length>0&&receipts.every(receipt=>{
      if(!messageId(receipt?.messageId)||typeof resolveEvidence!=='function')return false;
      try{const original=resolveEvidence(receipt.messageId,task);if(original?.id!==receipt.messageId||groupId!==undefined&&original.groupId!==groupId||requestId!==undefined&&original.requestId!==requestId)return false;ids.push(original.id);return true;}catch{return false;}
    });
    if(resolved){out.evidenceRefs=[...new Set(ids)];out.evidenceMode='message_references';}
    else{
      if(Object.hasOwn(task,'evidenceRefs'))out.evidenceRefs=structuredClone(task.evidenceRefs);
      if(Object.hasOwn(task,'receipts'))out.receipts=structuredClone(task.receipts);
      out.evidenceMode='legacy_evidence_preserved';
    }
    return out;
  });
  const before=JSON.stringify(tasks).length,after=JSON.stringify(projected).length;
  return {tasks:projected,observation:{layer:'outbound_task_metadata',unit:'characters',before,after,delta:after-before,tokenSavings:null,providerUsageCompared:false,extraModelCalls:0}};
}
