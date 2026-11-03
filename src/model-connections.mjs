import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { findCodexBinary } from './codex.mjs';

export const connectionPresets = [
  { id:'deepseek', name:'DeepSeek API', kind:'api', baseUrl:'https://api.deepseek.com/v1', model:'deepseek-chat', keyEnv:'DEEPSEEK_API_KEY' },
  { id:'openai', name:'OpenAI 兼容 API', kind:'api', baseUrl:'https://api.openai.com/v1', model:'', keyEnv:'OPENAI_API_KEY' },
  { id:'ollama', name:'Ollama（本机）', kind:'api', baseUrl:'http://127.0.0.1:11434/v1', model:'', auth:'none' },
  { id:'custom', name:'自定义兼容 API', kind:'api', baseUrl:'', model:'', keyEnv:'' },
  { id:'codex-cli', name:'Codex CLI / app-server', kind:'codex-cli', model:'' },
  { id:'harness-acp', name:'Harness CLI / ACP', kind:'harness-acp', model:'' },
];
export function safeEndpoint(value) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || !['https:','http:'].includes(u.protocol) ||
      u.protocol === 'http:' && !['127.0.0.1','localhost','[::1]'].includes(u.hostname)) throw Error('API 地址须为 HTTPS，或本机 HTTP；不能包含凭据、查询参数和片段。');
  return u.href.replace(/\/+$/, '');
}
function dpapi(value, decrypt = false) {
  if (process.platform !== 'win32') throw Error('当前系统请使用环境变量引用保存密钥。');
  const script = `Add-Type -AssemblyName System.Security; $v=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($v); $r=[Security.Cryptography.ProtectedData]::${decrypt?'Unprotect':'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  return new Promise((resolve,reject)=>{
    const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:15000,maxBuffer:32768},(e,out)=>e?reject(Error('本机凭据加密失败；可改用环境变量。')):resolve(Buffer.from(out.trim(),'base64')));
    child.stdin.end(Buffer.from(value).toString('base64'));
  });
}
export class ModelConnections {
  constructor(root,{env=process.env,protect=v=>dpapi(v),unprotect=v=>dpapi(v,true)}={}) {
    this.root=path.join(root,'model-connections'); this.env=env;this.protect=protect;this.unprotect=unprotect;
    fs.mkdirSync(this.root,{recursive:true,mode:0o700});
  }
  file(id) { if(!/^[a-f0-9-]{36}$/.test(id))throw Error('无效接入编号。');return path.join(this.root,id+'.json'); }
  get(id) { const p=JSON.parse(fs.readFileSync(this.file(id),'utf8'));return p; }
  public(p) { const {credential,...value}=p;return {...value,hasStoredKey:Boolean(credential)}; }
  list() {return fs.readdirSync(this.root).filter(n=>/^[a-f0-9-]{36}\.json$/.test(n)).map(n=>this.public(this.get(n.slice(0,-5))));}
  async save(input) {
    const preset=connectionPresets.find(p=>p.id===input.preset);if(!preset)throw Error('请选择接入预设。');
    const p={id:randomUUID(),name:String(input.name||preset.name).trim().slice(0,80),preset:preset.id,kind:preset.kind,model:String(input.model||'').trim().slice(0,200),createdAt:new Date().toISOString()};
    if(p.kind==='api') {
      p.baseUrl=safeEndpoint(input.baseUrl||preset.baseUrl);p.auth=input.auth||preset.auth||'env';
      if(!['env','local','none'].includes(p.auth))throw Error('未知凭据方式。');
      if(p.auth==='env'){p.keyEnv=input.keyEnv||preset.keyEnv;if(!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(p.keyEnv||''))throw Error('请输入密钥环境变量名称。');}
      if(p.auth==='local'){if(typeof input.apiKey!=='string'||!input.apiKey.trim()||input.apiKey.length>8192)throw Error('请输入 API 密钥。');p.credential=(await this.protect(Buffer.from(input.apiKey.trim()))).toString('base64');}
    } else {
      const detected=this.detect(p.kind);
      p.binary=input.binary||detected.binary;p.args=input.args??detected.args;
      if(!p.binary||!path.isAbsolute(p.binary)||!fs.statSync(p.binary).isFile()||/\.(bat|cmd)$/i.test(p.binary))throw Error('请选择真实可执行文件的绝对路径；Node CLI 可选择 node.exe 和脚本参数。');
      if(!Array.isArray(p.args)||p.args.length>30||p.args.some(a=>typeof a!=='string'||a.length>2048||a.includes('\0')))throw Error('CLI 参数须为字符串数组，不使用 shell 命令。');
    }
    fs.writeFileSync(this.file(p.id),JSON.stringify(p),{mode:0o600,flag:'wx'});return this.public(p);
  }
  detect(kind) {
    if(kind==='codex-cli'){try{return {binary:findCodexBinary(),args:['app-server']};}catch{return {binary:'',args:['app-server']};}}
    return {binary:process.execPath,args:[path.join(process.env.DSH_INSTALL_ROOT||path.join(os.homedir(),'AppData','Roaming','npm','node_modules','@deepseek-ai','dsh'),'lib','bin.js'),'--profile','acp']};
  }
  async key(p) {
    const key=p.auth==='local'?String(await this.unprotect(Buffer.from(p.credential,'base64'))):p.auth==='env'?this.env[p.keyEnv]:'';
    if(p.auth!=='none'&&!key)throw Error(`缺少密钥：请设置 ${p.keyEnv||'本机密钥'}，然后重开服务，或使用本机加密保存。`);
    return key;
  }
  async api(p,route,body,{signal,timeoutMs=120000}={}) {
    const key=await this.key(p),abort=AbortSignal.any([AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    let response;
    try{response=await fetch(p.baseUrl+route,{method:body?'POST':'GET',headers:{...(key?{authorization:'Bearer '+key}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:abort});}
    catch{throw Error(signal?.aborted?'请求已中断；不会自动重发。':'API 连接失败或超时；请检查地址、网络和服务状态，不会自动重发。');}
    if(!response.ok){await response.body?.cancel();throw Object.assign(Error(`API HTTP ${response.status}：${response.status===401||response.status===403?'检查密钥及模型权限':response.status===429?'额度或速率受限，请稍后重试':'检查服务地址与模型支持'}。`),{code:'API_REJECTED'});}
    const reader=response.body.getReader();let size=0;const chunks=[];
    try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('API 响应超过 2 MiB 上限。');chunks.push(value);}}finally{reader.releaseLock();if(size>2*1024*1024)await response.body.cancel();}
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('服务没有返回有效 JSON。');}
  }
}
