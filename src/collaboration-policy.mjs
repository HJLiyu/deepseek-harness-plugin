const members=['codex','harness'];
export function collaborationPolicy(value={}) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['mode','coordinator','roles','taskClass'].includes(k)))throw Error('Invalid collaboration policy.');
 const mode=value.mode??'mixed',coordinator=value.coordinator??'codex',roles=value.roles??{};
 if(!['peers','coordinator','mixed'].includes(mode)||!members.includes(coordinator)||!roles||typeof roles!=='object'||Array.isArray(roles))throw Error('Invalid collaboration mode or coordinator.');
 for(const [role,member] of Object.entries(roles))if(!['researcher','implementer','reviewer','integrator'].includes(role)||!members.includes(member))throw Error('Invalid role override.');
 if(roles.implementer&&roles.implementer===roles.reviewer)throw Error('An executor cannot review its own work.');
 const taskClass=value.taskClass??'implementation';if(!['implementation','research'].includes(taskClass))throw Error('Invalid task class.');
 return {mode,coordinator,roles:{...roles},taskClass};
}
export function pinCollaboration(group,request) {
 if(!request.collaboration){request.collaboration=collaborationPolicy(group.collaboration);request.collaborationSource={groupUpdatedAt:group.updatedAt,appliesAt:'request_planning_boundary'};}
 return request.collaboration;
}
export function planners(group,request){const p=request.collaboration??collaborationPolicy(group.collaboration);return p.mode==='coordinator'?[p.coordinator]:members;}
export function planningReady(group,request){return planners(group,request).every(m=>request.plans?.[m]);}
export function selectedPlan(group,request) {
 const p=request.collaboration??collaborationPolicy(group.collaboration);
 if(p.mode!=='coordinator')return null;
 const plan=request.plans[p.coordinator];
 return plan?{...plan,review:plan.owner!=='none',startPhase:plan.startPhase??'work',integrator:p.roles.integrator??p.coordinator}:null;
}
export function reviewerFor(owner,policy={}) {
 const reviewer=policy.roles?.reviewer;
 return reviewer&&reviewer!==owner?reviewer:members.find(m=>m!==owner);
}
export function roleSuggestions(store,group,taskClass='implementation') {
 const rows={codex:[],harness:[]},integrations={codex:[],harness:[]},reviews={codex:[],harness:[]};
 for(const request of store.requests(group.id))for(const task of request.taskList??[]){
  if(task.status!=='done'||(task.readOnly?'research':'implementation')!==taskClass)continue;
  const receipt=task.receipts?.['work:'+task.owner],msg=store.messageById(receipt?.messageId);
  if(!members.includes(task.owner)||receipt?.status!=='done'||msg?.requestId!==request.id||msg?.groupId!==group.id||msg?.sender!==task.owner||!task.evidenceRefs?.length)continue;
  const d=store.db.prepare('SELECT value FROM deliveries WHERE group_id=? AND json_extract(value,\'$.responseMessageId\')=?').get(group.id,msg.id);
  const delivery=d&&JSON.parse(d.value);if(delivery?.status!=='received'||delivery.member!==task.owner)continue;
  rows[task.owner].push({requestId:request.id,taskId:task.taskId,messageId:msg.id,deliveryId:delivery.id,acceptance:task.evidenceRefs});
  for(const member of members){
   const integrated=task.receipts?.['integrate:'+member],im=store.messageById(integrated?.messageId);
   if(integrated?.status==='done'&&im?.requestId===request.id&&im?.groupId===group.id&&im?.sender===member){
    const ir=store.db.prepare("SELECT value FROM deliveries WHERE group_id=? AND json_extract(value,'$.responseMessageId')=?").get(group.id,im.id);
    if(ir&&JSON.parse(ir.value).status==='received')integrations[member].push({requestId:request.id,taskId:task.taskId,messageId:im.id});
   }
  }
  for(const o of Object.values(request.reviewOutcomes??{}))if(o.taskId===task.taskId&&members.includes(o.member)&&o.resolution){
   const resolution=store.messageById(o.resolution.messageId);
   if(resolution?.requestId===request.id&&resolution?.groupId===group.id&&resolution.sender!==o.member)reviews[o.member].push({requestId:request.id,taskId:task.taskId,messageId:o.messageId,resolutionMessageId:resolution.id,category:o.resolution.category});
  }

 }
 const ranked=members.map(member=>({member,count:rows[member].length})).sort((a,b)=>b.count-a.count),winner=ranked[0].count>ranked[1].count?ranked[0].member:null;
 const advice=(evidence,kind)=>{
  const counts=members.map(member=>({member,positive:evidence[member].filter(e=>kind!=='reviewer'||e.category==='true_defect').length,negative:evidence[member].filter(e=>e.category==='false_opposition').length}));
  const best=counts.find(a=>a.positive>0&&counts.every(b=>a.member===b.member||a.positive>b.positive&&a.negative<=b.negative));
  return {suggestedMember:best?.member??null,state:best?'evidence_available':'insufficient_or_tied',counts,evidence:Object.fromEntries(members.map(m=>[m,evidence[m].slice(-20)]))};
 };
 const role=taskClass==='research'?'researcher':'implementer';
 return {roles:{[role]:advice(rows,role),reviewer:advice(reviews,'reviewer'),integrator:advice(integrations,'integrator')},version:1,taskClass,role:taskClass==='research'?'researcher':'implementer',suggestedMember:winner,evidence:rows,
   state:winner?'evidence_available':'insufficient_or_tied',basis:'accepted comparable tasks with original work receipts; sample counts are not a quality score',humanOverride:true};
}
