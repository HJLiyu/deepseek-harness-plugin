import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// This private stdio channel belongs to the native host. Never log its ready URL.
const input=readline.createInterface({input:process.stdin});let timer,busy=false,started=false,stopping=false;
const send=value=>{if(!stopping)process.stdout.write(JSON.stringify(value)+'\n');};
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function start(config){
  if(Number(process.versions.node.split('.')[0])<24){send({type:'error',message:'需要 Node.js 24 或更新版本，请更新 Node 后重新打开软件。'});return;}
  if(started||!path.isAbsolute(config.dataDir||''))throw Error('Invalid desktop startup configuration.');
  started=true;process.env.HARNESS_PLUGIN_DATA=config.dataDir;
  const {localFetch}=await import('../src/group-http.mjs');
  const {ensureGroupService}=await import('../src/group-client.mjs');
  const descriptorFile=path.join(config.dataDir,'group-service.json'),lock=path.join(config.dataDir,'group-service.lock');
  const connect=async()=>{
    if(busy||stopping)return;busy=true;
    try{
      let d;try{d=JSON.parse(fs.readFileSync(descriptorFile,'utf8'));const h=await localFetch(d,'/api/health',undefined,{timeoutMs:2000});if(h.protocol!=='codex-harness-group/v2')throw Error('Unsupported coordinator protocol.');}
      catch(e){
        let pid;try{pid=Number(fs.readFileSync(lock,'utf8'));}catch{}
        // An existing live coordinator is canonical, including after an update.
        // Never drain or downgrade it merely because the native shell is older.
        if(pid&&alive(pid))throw Error('本机服务仍在运行但暂时无法连接，正在保留检查点并重新检查。');
        d=await ensureGroupService();
      }
      send({type:'ready',url:d.url+'/#'+d.token});
    }catch{send({type:'disconnected',message:'暂时无法连接本机服务。任务检查点已保留，软件会继续检查连接；也可选择“重新连接”。'});}
    finally{busy=false;}
  };
  await connect();timer=setInterval(connect,5000);timer.unref();
}
function stop(){stopping=true;clearInterval(timer);input.close();process.exitCode=0;process.stdin.destroy();}
input.on('line',line=>{try{const value=JSON.parse(line);if(value.action==='start')void start(value).catch(()=>send({type:'error',message:'桌面启动配置无效，请检查安装配置。'}));else if(value.action==='stop')stop();}catch{send({type:'error',message:'桌面控制消息无效。'});}});
input.once('close',()=>{stopping=true;clearInterval(timer);});
process.once('SIGTERM',stop);
