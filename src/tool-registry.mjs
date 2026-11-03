import {scopeHash,toolRoot} from './scope-grants.mjs';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {resourceClaims} from './group-admission.mjs';

const ordered=x=>Array.isArray(x)?x.map(ordered):x&&typeof x==='object'?Object.fromEntries(Object.keys(x).sort().map(k=>[k,ordered(x[k])])):x;
const hash=x=>createHash('sha256').update(JSON.stringify(ordered(x))).digest('hex');
const object=x=>x&&typeof x==='object'&&!Array.isArray(x);
const sensitive=/credential|password|token|secret|authorization|api.?key/i;
const redact=text=>String(text).replace(/sk-[a-zA-Z0-9_-]+/g,'[redacted]').replace(/Bearer\s+[^\s"\\]+/gi,'Bearer [redacted]');
function keys(value,allowed){if(!object(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('Invalid tool contract fields.');}
function schema(input){
  if(!object(input)||Object.keys(input).length>30)throw Error('Invalid tool parameter schema.');
  for(const [name,s] of Object.entries(input)){
    keys(s,['type','required','maxLength','enum']);
    if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(name)||sensitive.test(name)||!['string','number','boolean'].includes(s.type)||typeof s.required!=='boolean'||s.maxLength!==undefined&&(!Number.isSafeInteger(s.maxLength)||s.maxLength<1||s.maxLength>16000)||s.enum!==undefined&&(!Array.isArray(s.enum)||!s.enum.length||s.enum.length>100||s.enum.some(v=>typeof v!==s.type)))throw Error('Invalid tool parameter schema.');
  }
  return structuredClone(input);
}
function parameters(input,s){
  keys(input,Object.keys(s));const out={};
  for(const [key,rule] of Object.entries(s)){
    if(!Object.hasOwn(input,key)){if(rule.required)throw Error('Missing tool parameter.');continue;}
    const v=input[key];
    if(typeof v!==rule.type||rule.type==='number'&&!Number.isFinite(v)||rule.type==='string'&&(v.length>(rule.maxLength??16000)||/[\x00]/.test(v))||rule.enum&&!rule.enum.includes(v))throw Error('Invalid tool parameter.');
    out[key]=v;
  }return out;
}
// Registration is a host-only interface. No serialized model/API input can
// install a handler, executable, endpoint, credential supplier or scope.
export class ToolRegistry {
  #tools=new Map();
  register(definition,execute){
    keys(definition,['id','kind','params','resources','category','needsGrant','timeoutMs','costBoundUnits']);
    const d=definition;
    if(!/^[a-z][a-z0-9._-]{0,79}$/.test(d.id)||this.#tools.has(d.id)||!['cli','api'].includes(d.kind)||!['read','write','irreversible'].includes(d.category)||typeof d.needsGrant!=='boolean'||typeof d.resources!=='function'||typeof execute!=='function'||!Number.isSafeInteger(d.timeoutMs)||d.timeoutMs<1||d.timeoutMs>120000)throw Error('Invalid tool registration.');
    if(d.costBoundUnits!==undefined&&d.costBoundUnits!==null&&(!Number.isSafeInteger(d.costBoundUnits)||d.costBoundUnits<0))throw Error('Invalid host cost bound.');
    if(d.category!=='read'&&!d.needsGrant)throw Error('Effectful tools require a grant.');
    this.#tools.set(d.id,Object.freeze({...d,params:schema(d.params),execute}));return this;
  }
  get(id){return this.#tools.get(id);}
  catalog(){return [...this.#tools.values()].map(({id,kind,params,category,needsGrant,timeoutMs,costBoundUnits})=>({id,kind,params:structuredClone(params),category,needsGrant,timeoutMs,costBoundUnits:costBoundUnits??null,budgetUnit:'host_declared_upper_bound_units',resources:'host_resolved_from_validated_parameters'}));}
}
const within=(p,scope)=>p.path===scope.path||p.path.startsWith(scope.path+'/')||Boolean(p.inode&&p.inode===scope.inode);
function safeResult(value,secrets){
  const textValue=x=>Object.values(secrets).reduce((s,v)=>typeof v==='string'&&v?s.split(v).join('[redacted]'):s,redact(x));
  const clean=x=>typeof x==='string'?textValue(x):Array.isArray(x)?x.map(clean):object(x)?Object.fromEntries(Object.entries(x).map(([k,v])=>[textValue(k),sensitive.test(k)?'[redacted]':clean(v)])):x;
  const text=JSON.stringify(clean(value??null));if(text.length>65536)return {omitted:true,reason:'result_size_limit'};return JSON.parse(text);
}
export class ToolExecutor {
  constructor(store,registry,{credentials=()=>({}),grants}={}){this.store=store;this.registry=registry;this.credentials=credentials;this.grants=grants;}
  calls(groupId){return this.store.db.prepare('SELECT value FROM tool_calls WHERE group_id=? ORDER BY rowid DESC LIMIT 100').all(groupId).map(r=>JSON.parse(r.value));}
  async invoke(groupId,input,signal){
    const store=this.store;let row,tool,params,fresh=true;
    if(input?.grantId){try{if(!this.grants)throw Error('Scope manager unavailable');await this.grants.refresh(groupId);}catch{fresh=false;}}
    // Audit reservation and duplicate protection share the same SQLite write
    // transaction. A crash after reservation always requires reconciliation.
    const cached=store.transaction(()=>{
      keys(input,['callId','deliveryId','toolId','params','grantId']);
      if(!/^[a-zA-Z0-9_-]{1,100}$/.test(input.callId??'')||typeof input.deliveryId!=='string'||typeof input.toolId!=='string')throw Error('Invalid tool call identity.');
      const d=store.delivery(input.deliveryId),g=store.group(groupId),r=d&&store.request(d.requestId);
      if(!d||d.groupId!==groupId||!r||r.groupId!==groupId)throw Error('Tool delivery identity mismatch.');
      const id=hash([groupId,d.id,input.callId]),paramsHash=hash(input.params??null),legacyBinding=hash([d.id,d.requestId,d.revision,d.epoch,input.toolId,paramsHash]),binding=hash([d.id,d.requestId,d.revision,d.epoch,input.toolId,paramsHash,input.grantId??null]);
      const old=store.db.prepare('SELECT value FROM tool_calls WHERE id=?').get(id);
      if(old){const prior=JSON.parse(old.value);if(prior.binding!==binding&&!(prior.binding===legacyBinding&&!input.grantId&&!prior.grantId))throw Error('Tool call identity cannot be rebound.');return {...prior,resultStatus:prior.resultStatus==='running'?'unknown':prior.resultStatus,replayed:false,duplicate:true};}
      row={id,callIdHash:hash(input.callId),toolId:redact(input.toolId).slice(0,80),groupId,deliveryId:d.id,requestId:d.requestId,revision:d.revision,epoch:d.epoch,grantId:input.grantId??null,paramsHash,binding,resources:null,decision:'denied',reason:null,resultStatus:'error',createdAt:Date.now(),finishedAt:null};
      const deny=reason=>{row.reason=reason;row.finishedAt=Date.now();};
      tool=this.registry.get(input.toolId);
      row.category=tool?.category??null;row.kind=tool?.kind??null;row.timeoutMs=tool?.timeoutMs??null;
      if(!tool)deny('tool_not_registered');
      else if(!signal||signal.aborted||d.replyOnly||g.status!=='active'||g.activeRequestId!==r.id||r.parallelStop||!d.started||d.status!=='pending'||d.epoch!==g.epoch||r.revision!==d.revision||!['active','queued'].includes(r.status)||store.pendingPermissions(groupId).length||store.hasPendingScopes?.(groupId))deny('delivery_not_active');
      else if(store.db.prepare('SELECT value FROM tool_calls WHERE group_id=?').all(groupId).some(x=>{const c=JSON.parse(x.value);return c.deliveryId===d.id&&['running','unknown'].includes(c.resultStatus);}))deny('prior_tool_unsettled');
      else{
        try{
          params=parameters(input.params,tool.params);
          const declaration=tool.resources(structuredClone(params));keys(declaration,['reads','writes']);
          const root=toolRoot(g,d),actual=resourceClaims(root,declaration),scope=resourceClaims(root,d.toolScope??{reads:[],writes:[]});row.resources=actual;row.root=root;row.operationHash=scopeHash({binding,callIdHash:row.callIdHash,toolId:tool.id,category:tool.category,resources:actual,root});
          if(d.toolRoot&&d.toolRoot!==root)deny('delivery_root_changed');
          else if(actual.exclusive||scope.exclusive||actual.reads.some(p=>![...scope.reads,...scope.writes].some(s=>within(p,s)))||actual.writes.some(p=>!scope.writes.some(s=>within(p,s))))deny('resource_out_of_scope');
          else if(tool.category==='read'&&actual.writes.length)deny('tool_category_mismatch');
          else if(!input.grantId&&(tool.category!=='read'||tool.needsGrant||actual.writes.length))deny('grant_required');
          else if((actual.writes.length||tool.category!=='read')&&['planning','review'].includes(d.phase))deny('read_only_phase');
          else if(actual.writes.length&&root===toolRoot(g,{phase:'integrate'})&&(d.phase!=='integrate'||store.db.prepare('SELECT request_id FROM integrations WHERE repo=?').get(g.repo)?.request_id!==r.id))deny('integration_lock_required');
          else if(input.grantId){
            if(!fresh)deny('native_scope_proof_unavailable');
            else{const reservation=this.grants.reserve(input.grantId,row,d,tool,root);if(!reservation.allowed)deny(reservation.reason);else{row.reservationId=reservation.reservationId;row.decision='allowed';row.reason='native_scope_authorized';row.resultStatus='unknown';row.executionState='in_flight';}}
          }
          else if(tool.category!=='read'||tool.needsGrant||actual.writes.length)deny('grant_required');
          else{row.decision='allowed';row.reason='authorized_read_scope';row.resultStatus='unknown';row.executionState='in_flight';}
        }catch{deny('invalid_parameters_or_resources');}
      }
      store.db.prepare('INSERT INTO tool_calls(id,group_id,value) VALUES(?,?,?)').run(id,groupId,JSON.stringify(row));return null;
    });
    if(cached)return cached;if(row.decision==='denied')return row;
    let timer,abort,secrets={};const controller=new AbortController();
    const stop=new Promise(resolve=>{abort=()=>{controller.abort();resolve({status:'unknown',reason:'cancelled'});};signal.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{controller.abort();resolve({status:'unknown',reason:'timeout'});},tool.timeoutMs);});
    let outcome;
    try{
      if(signal.aborted)abort();
      const execution=Promise.resolve().then(async()=>{
        if(controller.signal.aborted)return {status:'unknown',reason:'cancelled'};
        secrets=await this.credentials({toolId:tool.id,deliveryId:row.deliveryId,groupId});
        if(!object(secrets)||Object.values(secrets).some(v=>typeof v!=='string'))throw Error('Invalid host credentials.');
        if(controller.signal.aborted)return {status:'unknown',reason:'cancelled'};
        if(row.reservationId){await this.grants.refresh(groupId);if(!this.grants.check(row.reservationId))return {status:'unknown',reason:'scope_changed_before_execution'};}
        if(controller.signal.aborted)return {status:'unknown',reason:'cancelled'};
        const g=store.group(groupId),d=store.delivery(row.deliveryId),r=store.request(row.requestId);
        if(g.status!=='active'||g.activeRequestId!==r.id||r.parallelStop||g.epoch!==row.epoch||r.revision!==row.revision||!['active','queued'].includes(r.status)||d.status!=='pending'||store.pendingPermissions(groupId).length||store.hasPendingScopes?.(groupId))return {status:'unknown',reason:'control_changed_before_execution'};
        if(toolRoot(g,d)!==row.root||hash(resourceClaims(row.root,tool.resources(structuredClone(params))))!==hash(row.resources))return {status:'unknown',reason:'resource_changed_before_execution'};
        // Persist entry before invoking the host. Absence of this marker after a terminal cancellation can prove non-entry; presence is never proof of execution or non-execution.
        store.transaction(()=>{if(row.reservationId&&!this.grants.check(row.reservationId))throw Error('Scope changed at entry.');row.executedAt=Date.now();store.db.prepare('UPDATE tool_calls SET value=? WHERE id=?').run(JSON.stringify(row),row.id);});
        const value=await tool.execute(structuredClone(params),{signal:controller.signal,credentials:secrets,resources:structuredClone(row.resources),repo:row.root});
        return {status:value?.status==='error'?'error':'done',reason:value?.status==='error'?'tool_reported_error':'completed',result:safeResult(value,secrets)};
      }).catch(()=>({status:'unknown',reason:'host_execution_uncertain'}));
      outcome=await Promise.race([stop,execution]);
    }finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
    row.resultStatus=outcome.status;row.executionState=outcome.status==='unknown'?'unsettled':'settled';row.reason=outcome.reason;row.finishedAt=Date.now();if(Object.hasOwn(outcome,'result'))row.result=outcome.result;
    store.transaction(()=>{store.db.prepare('UPDATE tool_calls SET value=? WHERE id=?').run(JSON.stringify(row),row.id);if(row.reservationId)this.grants.settle(row.reservationId,row.resultStatus);});return row;
  }
}

export function localToolRegistry(){
  const registry=new ToolRegistry(),params={text:{type:'string',required:true,maxLength:16000}},resources=()=>({reads:[],writes:[]});
  registry.register({id:'local.sha256',kind:'api',params,resources,category:'read',needsGrant:false,timeoutMs:5000,costBoundUnits:0},async({text})=>({sha256:createHash('sha256').update(text).digest('hex')}));
  registry.register({id:'local.cli-sha256',kind:'cli',params,resources,category:'read',needsGrant:false,timeoutMs:5000,costBoundUnits:0},({text},{signal})=>new Promise(resolve=>{
    // Fixed executable and script; input travels on stdin, never a shell or
    // process command line. Child environment contains no host credentials.
    const child=execFile(process.execPath,['-e',"let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>process.stdout.write(require('node:crypto').createHash('sha256').update(s).digest('hex')));"],{signal,windowsHide:true,env:{},maxBuffer:4096},(error,stdout)=>resolve(error?{status:'error',code:'cli_failed'}:{sha256:stdout}));
    child.stdin.on('error',()=>{});child.stdin.end(text);
  }));return registry;
}
