import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { findCodexBinary } from '../src/codex.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const commands=[['plugin','marketplace','add',root,'--json'],['plugin','add','codex-deepseek-harness@codex-harness-community','--json']];
if(process.argv.includes('--check')){console.log(JSON.stringify({node:process.version,root,manifest:fs.existsSync(path.join(root,'.agents/plugins/marketplace.json')),commands}));}
else {
  const binary=findCodexBinary();
  for(const args of commands)execFileSync(binary,[...(process.argv.includes('--no-daemon')?['--no-daemon']:[]),...args],{stdio:'inherit',windowsHide:true,timeout:120000});
  console.log('插件安装完成。原生钩子的审核与信任由 Codex 宿主管理；安装器不会代为信任。可运行 node cli.mjs group-open 打开本机界面。');
}
