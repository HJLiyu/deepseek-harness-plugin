import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { localFetch } from '../src/group-http.mjs';
import { assertInstallerIdle } from '../src/install-guard.mjs';

const [profile,runtimeArg,dataArg]=process.argv.slice(2);
if(!['desktop','web'].includes(profile)||!runtimeArg||!dataArg||!path.isAbsolute(runtimeArg)||!path.isAbsolute(dataArg))throw Error('Usage: node scripts/install-companion.mjs desktop|web <absoluteRuntimeRoot> <absoluteDataRoot>');
const runtimeRoot=fs.realpathSync(runtimeArg),dataRoot=path.resolve(dataArg);
if(!fs.existsSync(path.join(runtimeRoot,'group-worker.mjs')))throw Error('Runtime root does not contain group-worker.mjs.');
const profileRoot=path.join(os.homedir(),'.dsh','profiles',profile),file=path.join(profileRoot,'package.json'),patch=path.join(profileRoot,'cordis.patch.yml');
const original=fs.readFileSync(file,'utf8'),spec=JSON.parse(original),previousPatch=fs.readFileSync(patch,'utf8');
const descriptorFile=path.join(dataRoot,'group-service.json');let connected=false;
if(fs.existsSync(descriptorFile)){
  const descriptor=JSON.parse(fs.readFileSync(descriptorFile,'utf8'));
  const health=await localFetch(descriptor,'/api/health'),bindings=await localFetch(descriptor,'/api/bindings');
  assertInstallerIdle(health,bindings.bindings,process.env.CODEX_THREAD_ID);
  connected=health.adapters?.some(a=>a.adapterId===`harness-${profile}`&&a.connected);
}
process.env.HARNESS_PLUGIN_DATA=dataRoot;
const {reloadCompanionProfile,updateCompanionConfig}=await import('../src/companion-update.mjs');
const source=fileURLToPath(new URL('../companion/',import.meta.url));
const config={adapterId:`harness-${profile}`,descriptorFile,serviceWorker:path.join(runtimeRoot,'group-worker.mjs')};
const target=path.join(profileRoot,'node_modules','dsh-codex-group');
if(fs.existsSync(target)&&fs.lstatSync(target).isSymbolicLink())throw Error('Linked companion install must be updated at its source.');
const backup=path.join(profileRoot,'codex-group.previous-config.json');
if(!fs.existsSync(backup))fs.writeFileSync(backup,JSON.stringify({packageJson:original,patch:previousPatch}),{flag:'wx'});
if(fs.readFileSync(file,'utf8')!==original||fs.readFileSync(patch,'utf8')!==previousPatch)throw Error('Profile changed during installation; please retry.');
spec.dependencies??={};spec.dependencies['dsh-codex-group']='file:'+source.replaceAll('\\','/');
const bundles=spec.dsh?.profile?.bundles;if(!Array.isArray(bundles))throw Error('Unsupported Harness profile.');
if(!bundles.includes('dsh-codex-group'))bundles.push('dsh-codex-group');
if(connected){await reloadCompanionProfile(profile,{profileRoot,sourceDirectory:source,configuration:config});}
else{
  const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8'));
  fs.mkdirSync(target,{recursive:true});
  for(const f of [...manifest.files.filter(f=>f!=='index.mjs'),'package.json','index.mjs'])fs.copyFileSync(path.join(source,f),path.join(target,f));
  updateCompanionConfig(patch,config,{create:true});
}
fs.writeFileSync(file,JSON.stringify(spec,null,2)+'\n');
console.log(JSON.stringify({profile,installed:true,hotReload:connected,initialHostRestart:!connected,backup}));
