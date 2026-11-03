import {projectTaskContext} from './task-context.mjs';
import {fileHash} from './project-files.mjs';
export function savingsPolicy(value={}) {
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['incremental','thresholdCompaction','outputFiltering','verificationReuse','taskContext','outputLimitChars'].includes(k)))throw Error('Invalid context savings policy.');
 for(const key of ['incremental','thresholdCompaction','outputFiltering','verificationReuse'])if(value[key]!==undefined&&typeof value[key]!=='boolean')throw Error('Savings switches must be booleans.');
 if(value.taskContext!==undefined&&!['compact','full'].includes(value.taskContext))throw Error('Invalid task projection mode.');
 if(value.outputLimitChars!==undefined&&(!Number.isSafeInteger(value.outputLimitChars)||value.outputLimitChars<256||value.outputLimitChars>20000))throw Error('Invalid output preview limit.');
 return {incremental:value.incremental??true,thresholdCompaction:value.thresholdCompaction??true,outputFiltering:value.outputFiltering??false,verificationReuse:value.verificationReuse??true,taskContext:value.taskContext??'compact',outputLimitChars:value.outputLimitChars??4000};
}
export function evidenceLink(groupId,requestId,messageId) {
 return '/api/groups/'+encodeURIComponent(groupId)+'/evidence?requestId='+encodeURIComponent(requestId)+'&messageId='+encodeURIComponent(messageId);
}
export function filterOutput(message,policy) {
 if(!policy.outputFiltering||!message.id||!message.groupId||!message.requestId)return message;
 let body;try{body=JSON.parse(message.content);}catch{return message;}
 if(!body||typeof body!=='object'||Array.isArray(body))return message;
 let changed=false;
 const clip=text=>{if(text.length<=policy.outputLimitChars)return text;changed=true;return {preview:text.slice(0,policy.outputLimitChars),originalCharacters:text.length,messageId:message.id,original:evidenceLink(message.groupId,message.requestId,message.id)};};
 const project=value=>{
  if(typeof value==='string')return clip(value);
  if(Array.isArray(value))return value.map(project);
  if(value&&typeof value==='object'){const out={...value};for(const key of ['stdout','stderr'])if(typeof out[key]==='string')out[key]=clip(out[key]);return out;}
  return value;
 };
 for(const key of ['toolOutput','toolOutputs'])if(Object.hasOwn(body,key))body[key]=project(body[key]);

 return changed?{...message,content:JSON.stringify(body)}:message;
}
export function reusableVerification(tasks,store,group,request) {
 const out=[];
 for(const task of tasks){
  const snapshot=task.verificationSnapshot;if(task.status!=='done'||!snapshot||snapshot.revision!==task.revision||!snapshot.hashes||!Object.keys(snapshot.hashes).length||Object.keys(snapshot.hashes).length>200)continue;
  const original=store.messageById(snapshot.messageId);
  if(original?.groupId!==group.id||original?.requestId!==request.id)continue;
  try{if(!Object.entries(snapshot.hashes).every(([name,wanted])=>fileHash(group.repo,name)===wanted))continue;}catch{continue;}
  out.push({taskId:task.taskId,messageId:original.id,original:evidenceLink(group.id,request.id,original.id),hashes:snapshot.hashes,
   status:'prior_receipt_with_current_matching_artifacts',limitation:'Environment and tool versions are not revalidated; this does not bypass coordinator checks or prove new work.'});
 }
 return out;
}
export function serializeContext(payload,store,group,request) {
 const policy=savingsPolicy(group.savings),out=structuredClone(payload),before=JSON.stringify(out).length;
 let projection=null;
 if(Array.isArray(out.taskList)){
  projection=projectTaskContext(out.taskList,{mode:policy.taskContext,groupId:group.id,requestId:request.id,resolveEvidence:id=>store.messageById(id)});
  out.taskList=projection.tasks.map(task=>({...task,...(task.evidenceMode==='message_references'?{originalEvidence:task.evidenceRefs.map(id=>({messageId:id,url:evidenceLink(group.id,request.id,id)}))}:{})}));
  if(policy.verificationReuse)out.verificationReuse=reusableVerification(request.taskList??[],store,group,request);
 }
 out.contextSavings={policy,taskProjection:projection?.observation??null,tokenSavings:null,providerUsageCompared:false,extraModelCalls:0};
 if(Object.hasOwn(out,'currentTask')){const task=out.currentTask;delete out.currentTask;out.currentTask=task;}
 out.contextSavings.characters={before,after:0,delta:0};
 let text;
 for(let i=0;i<8;i++){text=JSON.stringify(out).replace(/\bsk-[A-Za-z0-9_-]+/g,'[本机凭据不回显]');if(out.contextSavings.characters.after===text.length)break;out.contextSavings.characters.after=text.length;out.contextSavings.characters.delta=text.length-before;}
 return {text,observation:out.contextSavings};
}
export function savingsStatus(value) {
 const policy=savingsPolicy(value);
 return {policy,strategies:Object.fromEntries(['incremental','thresholdCompaction','outputFiltering','verificationReuse'].map(k=>[k,{implemented:true,enabled:policy[k],effect:'token_savings_unverified'}])),
   taskProjection:{implemented:true,mode:policy.taskContext},tokenSavings:null,extraModelCalls:0,
   limits:'Tool previews can omit details; read originals before decisions. Original messages remain queryable. References require identity checks. Provider token and billing effects have not been compared.'};
}

export function latestSavingsObservation(store,groupId){
 const row=store.db.prepare("SELECT value FROM deliveries WHERE group_id=? AND json_extract(value,'$.contextSavings') IS NOT NULL ORDER BY rowid DESC LIMIT 1").get(groupId);
 if(!row)return null;const d=JSON.parse(row.value);return {deliveryId:d.id,requestId:d.requestId,observation:d.contextSavings};
}
