export async function configureIdleEffort({agent,sessionController,sessionId,model,effort,busy=false}) {
 if(!effort)return {requested:null,confirmed:null};
 if(busy||agent.status!=='idle'||agent.inbox?.nextTurn?.length||agent.inbox?.nextStep?.length)throw Error('Native agent must be idle before effort configuration.');
 // Keep provider/model exactly as supplied by the existing group binding.
 await sessionController.selectModel({sessionId,provider:model.provider,model:model.model,reasoningEffort:effort});
 // selectModel's success alone does not establish the model's actual effort.
 return {requested:effort,confirmed:null};
}
export function harnessEffortReceipt(events,{deliveryId,sessionId,turn,model,requested}) {
 const headers=events.filter(e=>e.type==='request/header'&&e.data?.turn===turn);
 const configs=headers.map(e=>e.data?.header?.config);
 const values=configs.map(c=>c?.model===model.model&&c?.provider===model.provider?c.reasoningEffort:null);
 const confirmed=values.length&&values.every(v=>typeof v==='string'&&v===values[0])?values[0]:null;
 return {deliveryId,sessionId,requested:requested??null,confirmed,turn,source:'native:request/header',headerSeqs:headers.map(e=>e.seq)};
}
