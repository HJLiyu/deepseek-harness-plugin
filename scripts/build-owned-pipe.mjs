import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const compiler=process.argv[2]??path.join(os.homedir(),'.codex/cache/compilers/tcc-0.9.27-win64/tcc/tcc.exe');
if(process.platform!=='win32'||process.arch!=='x64'||!fs.existsSync(compiler))throw Error('A local Windows x64 TinyCC0.9.27 compiler is required; no automatic downloads.');
const source=path.join(root,'companion/owned-pipe-win32.c'),output=path.join(root,'companion/owned-pipe-win32-x64.dll');
execFileSync(compiler,['-shared',source,'-o',output,'-ladvapi32'],{cwd:root,windowsHide:true,stdio:'pipe'});
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const result={sourceSha256:hash(source),dllSha256:hash(output),bytes:fs.statSync(output).size,compilerSha256:hash(compiler),compiler:'TinyCC0.9.27 win64',flags:['-shared','-ladvapi32']};
const evidence=path.join(root,'data/verification');fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'owned-pipe-build.json'),JSON.stringify(result,null,2)+'\n');
// TinyCC emits an optional import definition beside this exclusively-owned output.
const definition=path.join(root,'companion/owned-pipe-win32-x64.def');if(fs.existsSync(definition))fs.unlinkSync(definition);
process.stdout.write(JSON.stringify(result)+'\n');
