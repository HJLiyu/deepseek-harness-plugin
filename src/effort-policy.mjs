// This order is a selection rule, never a declaration of host capabilities.
const order=['none','minimal','low','medium','high','xhigh','max','ultra'];
export function effortPolicy(input={}) {
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['mode','overrides'].includes(k)))throw Error('Invalid effort policy.');
 const mode=input.mode??'auto',overrides=input.overrides??{};
 if(!['auto','configured'].includes(mode)||!overrides||Array.isArray(overrides)||Object.keys(overrides).some(k=>!['codex','harness'].includes(k))||Object.values(overrides).some(v=>v!==null&&!(typeof v==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(v))))throw Error('Invalid effort override.');
 return {mode,overrides:{...overrides}};
}
export function discoverEffort(catalog,model,source,at=Date.now(),provider=null) {
 const rows=Array.isArray(catalog)?catalog:catalog?.data??catalog?.models??catalog?.groups?.filter(g=>g.id===provider).flatMap(g=>g.models??[]);
 const row=Array.isArray(rows)?rows.find(r=>(r.model??r.id??r.slug)===model):null;
 const levels=row?.supportedReasoningEfforts??row?.supported_reasoning_levels??row?.reasoningEfforts??row?.reasoning?.efforts;
 const supported=Array.isArray(levels)?[...new Set(levels.map(x=>typeof x==='string'?x:x?.reasoningEffort??x?.effort??x?.id).filter(x=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,40}$/.test(x)))]:[];
 return {supported,at,source,model,provider,state:supported.length?'discovered':'unknown'};
}
export function selectEffort({member,phase,task={},failures=0,configured,policy={},discovered}) {
 const p=effortPolicy(policy),human=p.overrides[member]??null;
 const inputs={writes:task.resources?.writes?.length??0,dependencies:task.deps?.length??0,failures,readOnly:task.readOnly===true};
 const difficult=inputs.writes>=4||inputs.dependencies>=3||failures>0;
 const expected=human??(p.mode==='configured'?configured??null:difficult||phase==='integrate'?'high':phase==='planning'||phase==='review'?'medium':inputs.readOnly||inputs.writes<=1?'low':'medium');
 const supported=discovered?.supported??[];
 const ranked=supported.filter(x=>order.includes(x));
 const selected=expected===null?null:!supported.length?human??configured??null:supported.includes(expected)?expected:[...ranked].sort((a,b)=>Math.abs(order.indexOf(a)-order.indexOf(expected))-Math.abs(order.indexOf(b)-order.indexOf(expected))||order.indexOf(a)-order.indexOf(b))[0]??supported[0]??null;
 const fallback=!supported.length?{from:expected,to:selected,reason:'capability_unknown'}:selected===expected?null:{from:expected,to:selected,reason:'unsupported_effort'};
 return {expected,selected,requested:null,confirmed:null,source:human?'human':p.mode==='configured'?'configured':'rule',ruleId:'phase-difficulty-v1',inputs,discovered:discovered??{supported:[],at:null,source:null,state:'unknown'},fallback,status:'unknown',confirmation:null};
}
export function confirmEffort(record,value,proof) {
 // An input echo or shared configuration is not a native execution receipt.
 if(!proof?.native||!proof.deliveryId||!record.discovered.supported.includes(value))return record;
 return {...record,confirmed:value,status:value===record.requested?'confirmed':'mismatch',confirmation:{...proof}};
}
