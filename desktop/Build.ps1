param([string]$OutputRoot,[string]$SdkCache)
$ErrorActionPreference='Stop'
if(-not $OutputRoot){$OutputRoot=Join-Path (Split-Path $PSScriptRoot -Parent) 'data\desktop\current'}
if(-not $SdkCache){$SdkCache=Join-Path $env:USERPROFILE '.codex\cache\webview2-sdk\1.0.4314.35'}
$output=[IO.Path]::GetFullPath($OutputRoot)
New-Item -ItemType Directory -Path $output -Force | Out-Null
New-Item -ItemType Directory -Path $SdkCache -Force | Out-Null
$package=Join-Path $SdkCache 'microsoft.web.webview2.1.0.4314.35.nupkg'
if(-not (Test-Path -LiteralPath $package)){
  [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
  $client=New-Object Net.WebClient
  try{$client.DownloadFile('https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4314.35/microsoft.web.webview2.1.0.4314.35.nupkg',$package)}finally{$client.Dispose()}
}
$sha=[Security.Cryptography.SHA256]::Create();$stream=[IO.File]::OpenRead($package)
try{$digest=[BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-','').ToLowerInvariant()}finally{$stream.Dispose();$sha.Dispose()}
if($digest -ne '90778deb1b77e36292828b4b5833c9255c27533f40e0ddd55891ae718944edc4'){throw 'WebView2 SDK integrity check failed.'}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($package)
try{
  foreach($entry in @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt')){
    $item=$zip.GetEntry($entry);if(-not $item){throw "Missing SDK entry $entry"}
    $name=if($entry -eq 'LICENSE.txt'){'WebView2-LICENSE.txt'}else{[IO.Path]::GetFileName($entry)}
    [IO.Compression.ZipFileExtensions]::ExtractToFile($item,(Join-Path $output $name),$true)
  }
}finally{$zip.Dispose()}
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not (Test-Path -LiteralPath $compiler)){throw 'Windows x64 .NET Framework 4.8 compiler is required.'}
$native=Join-Path $output 'CodexHarness.exe'
Add-Type -AssemblyName System.Drawing
$bitmap=New-Object Drawing.Bitmap 64,64;$graphics=[Drawing.Graphics]::FromImage($bitmap);$graphics.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
$background=New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(31,78,66));$pen=New-Object Drawing.Pen ([Drawing.Color]::White),4;$accent=New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(135,225,184))
$graphics.FillRectangle($background,0,0,64,64);$graphics.DrawEllipse($pen,11,10,39,33);$graphics.DrawLine($pen,18,39,14,49);$graphics.FillEllipse($accent,32,34,24,21)
$png=New-Object IO.MemoryStream;$bitmap.Save($png,[Drawing.Imaging.ImageFormat]::Png);$pngBytes=$png.ToArray();$png.Dispose();$graphics.Dispose();$bitmap.Dispose();$background.Dispose();$pen.Dispose();$accent.Dispose()
$icon=Join-Path $output 'app.ico';$writer=New-Object IO.BinaryWriter ([IO.File]::Create($icon))
try{$writer.Write([uint16]0);$writer.Write([uint16]1);$writer.Write([uint16]1);$writer.Write([byte]64);$writer.Write([byte]64);$writer.Write([byte]0);$writer.Write([byte]0);$writer.Write([uint16]1);$writer.Write([uint16]32);$writer.Write([uint32]$pngBytes.Length);$writer.Write([uint32]22);$writer.Write($pngBytes)}finally{$writer.Dispose()}
$arguments=@('/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output',"/out:$native",("/win32icon:$icon"),('/win32manifest:'+(Join-Path $PSScriptRoot 'app.manifest')),'/reference:System.dll','/reference:System.Core.dll','/reference:System.Drawing.dll','/reference:System.Windows.Forms.dll','/reference:System.Web.Extensions.dll','/reference:System.Security.dll','/reference:Microsoft.CSharp.dll',('/reference:'+(Join-Path $output 'Microsoft.Web.WebView2.Core.dll')),('/reference:'+(Join-Path $output 'Microsoft.Web.WebView2.WinForms.dll')),(Join-Path $PSScriptRoot 'Host.cs'))
& $compiler @arguments
if($LASTEXITCODE -ne 0){throw 'Native desktop compilation failed.'}
@'
<?xml version="1.0" encoding="utf-8"?><configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup></configuration>
'@ | Set-Content -LiteralPath ($native+'.config') -Encoding utf8
[pscustomobject]@{executable=$native;bytes=(Get-Item -LiteralPath $native).Length;sdkVersion='1.0.4314.35';sdkSha256=$digest} | ConvertTo-Json -Compress
