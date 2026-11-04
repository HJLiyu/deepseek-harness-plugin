import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
if(process.platform!=='win32'||process.arch!=='x64')throw Error('Desktop build requires Windows x64; the runtime itself is not downloaded.');
const destination=process.argv.slice(2).find(a=>!a.startsWith('--'));const out=path.resolve(destination||path.join(root,'data/desktop/current'));
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',path.join(root,'desktop/Build.ps1'),'-OutputRoot',out],{windowsHide:true,stdio:'inherit'});
const runtime=path.join(out,'runtime');const packaged=JSON.parse(execFileSync(process.execPath,[path.join(root,'scripts/package.mjs'),runtime,'--desktop-output'],{windowsHide:true,encoding:'utf8'}));
// The local development checkout may contain personal diagnostics documents.
for(const [from,to] of [['docs/README.public.md','README.md'],['docs/connections.md','verification.md']])if(fs.existsSync(path.join(root,from)))fs.copyFileSync(path.join(root,from),path.join(runtime,to));
fs.copyFileSync(path.join(root,'LICENSE'),path.join(out,'LICENSE'));
fs.writeFileSync(path.join(out,'INSTALL.txt'),'Codex × Harness Desktop 0.4.0-preview.3\r\n\r\nWindows 10/11 x64; requires Node.js 24+, Microsoft WebView2 Runtime, and a working Codex login.\r\n\r\nRun CodexHarness.exe to open the application.\r\nRun CodexHarness.exe --install to install shortcuts for the current user. No administrator permissions required.\r\nExisting plugin data: pass --data-dir <absolute-data-directory> during installation. Data and credentials are kept outside the application folder.\r\nSource and feedback: https://github.com/HJLiyu/deepseek-harness-plugin\r\n');
const files=['CodexHarness.exe','CodexHarness.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt','app.ico','LICENSE','INSTALL.txt',...packaged.entries.map(f=>'runtime/'+f)];let bytes=files.reduce((sum,f)=>sum+fs.statSync(path.join(out,f)).size,0);
fs.writeFileSync(path.join(out,'desktop-files.json'),JSON.stringify({version:'0.4.0-preview.3',files},null,2));
console.log(JSON.stringify({out,files:files.length+1,bytes,nodeBundled:false,webViewRuntimeBundled:false}));

if(process.argv.includes('--package')){
 const releases=path.join(root,'data/releases');fs.mkdirSync(releases,{recursive:true});const zip=path.join(releases,'CodexHarness-0.4.0-preview.3-win-x64.zip');
 // Package an explicit release allowlist, not an arbitrary working directory.
 const script=`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $target=$args[0]; $base=$args[1]; $manifest=Get-Content -LiteralPath (Join-Path $base 'desktop-files.json') -Raw | ConvertFrom-Json; $stream=[IO.File]::Open($target,[IO.FileMode]::Create); $zip=New-Object IO.Compression.ZipArchive($stream,[IO.Compression.ZipArchiveMode]::Create); try { foreach($f in @($manifest.files)+@('desktop-files.json')){[IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip,(Join-Path $base $f),$f,[IO.Compression.CompressionLevel]::Optimal) | Out-Null} }finally{$zip.Dispose();$stream.Dispose()}`;
 const packagingScript=path.join(root,'data/desktop/package.ps1');fs.writeFileSync(packagingScript,script);
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-File',packagingScript,zip,out],{windowsHide:true,stdio:'inherit'});
 if(fs.statSync(zip).size<10000)throw Error('Desktop archive is incomplete.');console.log(JSON.stringify({zip,zipBytes:fs.statSync(zip).size}));
}
