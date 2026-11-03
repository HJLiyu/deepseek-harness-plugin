import fs from 'node:fs';
import { createHash } from 'node:crypto';
export const GROUP_PROTOCOL = 'codex-harness-group/v2';
export const GROUP_VERSION = '0.3.2';
const legacyFiles = ['group-worker.mjs','src/group-store.mjs','src/group-engine.mjs','src/group-runtime.mjs','src/group-permissions.mjs','src/group-http.mjs','src/group-service.mjs','src/codex.mjs','src/git.mjs','web/group.html'];
const bytes = file => fs.readFileSync(new URL('../'+file, import.meta.url));
const digest = entries => {const h=createHash('sha256');for(const [name,value] of entries){h.update(name);h.update(value)}return h.digest('hex')};
// Keep the legacy hash compatible with already-loaded 0.3.2 clients.
export function groupBuildHash(){return digest(legacyFiles.map(file=>[file,bytes(file)]))}
export function groupRuntimeHash(){
 const files=['group-worker.mjs','companion/approval-text.mjs',...fs.readdirSync(new URL('.',import.meta.url)).filter(n=>n.endsWith('.mjs')).map(n=>'src/'+n)].sort();
 return digest(files.map(file=>[file,bytes(file)]));
}
export function captureGroupBuild(){
 const loaded = new Map(legacyFiles.filter(file=>file!=='web/group.html').map(file=>[file,bytes(file)]));
 return {runtimeHash:groupRuntimeHash(),legacyHash:html=>digest(legacyFiles.map(file=>[file,file==='web/group.html'?html:loaded.get(file)]))};
}
