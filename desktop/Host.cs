using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace CodexHarnessDesktop {
  public sealed class Settings {
    public string NodePath {get;set;}
    public string RuntimeRoot {get;set;}
    public string DataDir {get;set;}
    public string UiDataDir {get;set;}
  }
  public sealed class SavedState {
    public string LastPath {get;set;}
    public Dictionary<string,string> Session {get;set;}
    public SavedState(){Session=new Dictionary<string,string>();LastPath="/";}
  }
  public static class Program {
    public static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=2*1024*1024};
    public static string UiRoot;
    [STAThread] public static void Main(string[] args){
      Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
      try {
        string config=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexHarness","appsettings.json");
        for(int i=0;i<args.Length-1;i++)if(args[i]=="--config")config=Path.GetFullPath(args[i+1]);
        var settings=File.Exists(config)?Json.Deserialize<Settings>(File.ReadAllText(config)):new Settings();
        settings.RuntimeRoot=settings.RuntimeRoot??Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"runtime");
        settings.DataDir=settings.DataDir??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),".codex","deepseek-harness-plugin-data");
        settings.UiDataDir=settings.UiDataDir??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexHarness","ui");
        settings.NodePath=settings.NodePath??FindNode();UiRoot=settings.UiDataDir;Directory.CreateDirectory(UiRoot);
        for(int i=0;i<args.Length-1;i++)if(args[i]=="--data-dir")settings.DataDir=Path.GetFullPath(args[i+1]);
        foreach(string arg in args)if(arg=="--install"){Install(settings);Console.WriteLine(Json.Serialize(new{installed=true,path=InstallExe}));if(Array.IndexOf(args,"--quiet")<0)MessageBox.Show("安装完成。可从桌面或开始菜单打开 Codex × Harness。","Codex × Harness");return;}
        foreach(string arg in args)if(arg=="--self-test"){
          if(!IsLocalUrl("http://127.0.0.1:1234/#test")||IsLocalUrl("https://example.com")||IsLocalUrl("http://127.0.0.1:1234@evil.com"))throw new Exception("Navigation policy failed");
          Console.WriteLine(Json.Serialize(new{ok=true,webViewRuntime=CoreWebView2Environment.GetAvailableBrowserVersionString(),nodeFound=File.Exists(settings.NodePath)}));return;
        }
        string identity=WindowsIdentity.GetCurrent().User.Value+"-"+Hash(Path.GetFullPath(settings.DataDir).ToLowerInvariant());
        bool first;using(var mutex=new Mutex(true,"Local\\CodexHarness-"+identity,out first)){
          if(!first){try{using(var existing=EventWaitHandle.OpenExisting("Local\\CodexHarnessActivate-"+identity))existing.Set();}catch{}return;}
          using(var signal=new EventWaitHandle(false,EventResetMode.AutoReset,"Local\\CodexHarnessActivate-"+identity))
          using(var form=new MainWindow(settings)){
            var activation=new Thread(()=>{while(signal.WaitOne()){if(form.IsDisposed)return;try{form.BeginInvoke((Action)(()=>{if(form.WindowState==FormWindowState.Minimized)form.WindowState=FormWindowState.Normal;form.Show();form.Activate();}));}catch{}}});activation.IsBackground=true;activation.Start();
            Application.ThreadException+=(s,e)=>form.ShowError("应用遇到错误，请重新连接；群聊和任务检查点会保留。",e.Exception);
            Application.Run(form);
          }
          mutex.ReleaseMutex();
        }
      }catch(Exception e){Log(e);MessageBox.Show("无法启动 Codex × Harness。请确认已安装 Node.js 24+ 和 Microsoft WebView2 Runtime。\n\n"+Safe(e.Message),"Codex × Harness",MessageBoxButtons.OK,MessageBoxIcon.Error);}
    }
    static string FindNode(){foreach(string p in (Environment.GetEnvironmentVariable("PATH")??"").Split(Path.PathSeparator)){try{string f=Path.Combine(p.Trim('"'),"node.exe");if(File.Exists(f))return f;}catch{}}return "";}
    public static string InstallExe;
    public static void Install(Settings settings){
      string source=AppDomain.CurrentDomain.BaseDirectory,programRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","CodexHarness"),target=Path.Combine(programRoot,"versions","0.4.0-preview.1");
      var manifest=Json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(source,"desktop-files.json")));var files=(System.Collections.IEnumerable)manifest["files"];
      if(!File.Exists(settings.NodePath))throw new Exception("安装前请安装 Node.js 24+。");
      CoreWebView2Environment.GetAvailableBrowserVersionString();
      if(!Path.GetFullPath(target).StartsWith(Path.GetFullPath(programRoot)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))throw new Exception("Invalid installation target.");
      InstallExe=Path.Combine(target,"CodexHarness.exe");
      foreach(var p in Process.GetProcessesByName("CodexHarness")){try{if(p.Id!=Process.GetCurrentProcess().Id&&String.Equals(p.MainModule.FileName,InstallExe,StringComparison.OrdinalIgnoreCase))throw new InvalidOperationException("请先关闭正在运行的桌面软件，再安装更新；群聊和任务检查点会保留。");}finally{p.Dispose();}}
      foreach(var item in files){string relative=item as string;if(relative==null||Path.IsPathRooted(relative)||relative.Contains(".."))throw new Exception("Invalid release manifest.");string from=Path.GetFullPath(Path.Combine(source,relative)),to=Path.GetFullPath(Path.Combine(target,relative));if(!from.StartsWith(Path.GetFullPath(source),StringComparison.OrdinalIgnoreCase)||!to.StartsWith(Path.GetFullPath(target)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||!File.Exists(from))throw new Exception("Incomplete release package.");Directory.CreateDirectory(Path.GetDirectoryName(to));if(!String.Equals(from,to,StringComparison.OrdinalIgnoreCase))File.Copy(from,to,true);}
      if(!String.Equals(Path.GetFullPath(source).TrimEnd(Path.DirectorySeparatorChar),Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase))File.Copy(Path.Combine(source,"desktop-files.json"),Path.Combine(target,"desktop-files.json"),true);
      string userRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexHarness");Directory.CreateDirectory(userRoot);settings.RuntimeRoot=Path.Combine(target,"runtime");
      File.WriteAllText(Path.Combine(userRoot,"appsettings.json"),Json.Serialize(settings),Encoding.UTF8);
      dynamic shell=Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
      foreach(string folder in new[]{Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),Environment.GetFolderPath(Environment.SpecialFolder.Programs)}){
        string link=Path.Combine(folder,"CodexHarness Desktop.lnk");if(File.Exists(link)){dynamic old=shell.CreateShortcut(link);string oldTarget=old.TargetPath;if(!oldTarget.StartsWith(programRoot+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))continue;}
        dynamic shortcut=shell.CreateShortcut(link);shortcut.TargetPath=InstallExe;shortcut.WorkingDirectory=target;shortcut.Description="Codex × Harness 群聊与模型工作台";shortcut.IconLocation=InstallExe;shortcut.Save();
      }
      using(var key=Registry.CurrentUser.CreateSubKey(@"Software\CodexHarness")){key.SetValue("InstallLocation",target);key.SetValue("Version","0.4.0-preview.1");}
    }
    public static bool IsLocalUrl(string value){Uri u;return Uri.TryCreate(value,UriKind.Absolute,out u)&&u.Scheme=="http"&&u.Host=="127.0.0.1"&&String.IsNullOrEmpty(u.UserInfo)&&u.Port>0;}
    public static string Hash(string value){using(var sha=SHA256.Create()){return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-","").Substring(0,20);}}
    public static string Safe(string value){return Regex.Replace(value??"","(?:#[A-Za-z0-9]+|Bearer\\s+[^\\s\"']+)","[redacted]").Substring(0,Math.Min(800,Regex.Replace(value??"","(?:#[A-Za-z0-9]+|Bearer\\s+[^\\s\"']+)","[redacted]").Length));}
    public static void Log(Exception e){try{string dir=UiRoot??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"CodexHarness","ui");Directory.CreateDirectory(dir);string f=Path.Combine(dir,"desktop.log");if(File.Exists(f)&&new FileInfo(f).Length>5*1024*1024){for(int i=2;i>=1;i--){string a=f+"."+i,b=f+"."+(i+1);if(File.Exists(b))File.Delete(b);if(File.Exists(a))File.Move(a,b);}File.Move(f,f+".1");}File.AppendAllText(f,DateTime.UtcNow.ToString("o")+" "+e.GetType().Name+": "+Safe(e.Message)+Environment.NewLine);}catch{}}
  }
  public sealed class MainWindow:Form {
    readonly Settings config;readonly WebView2 web=new WebView2();readonly ToolStripStatusLabel status=new ToolStripStatusLabel();readonly Panel errorPanel=new Panel();readonly Label errorLabel=new Label();
    Process bridge;string origin,currentReady;bool closing,starting;SavedState state;readonly string stateFile;readonly System.Windows.Forms.Timer saveTimer=new System.Windows.Forms.Timer{Interval=400};
    public MainWindow(Settings settings){
      config=settings;Text="Codex × Harness";Width=1380;Height=920;MinimumSize=new Size(820,600);StartPosition=FormStartPosition.CenterScreen;AutoScaleMode=AutoScaleMode.Dpi;
      try{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}
      stateFile=Path.Combine(config.UiDataDir,"session.bin");state=LoadState();saveTimer.Tick+=(s,e)=>{saveTimer.Stop();SaveState();};
      var menu=new MenuStrip();var app=new ToolStripMenuItem("应用");app.DropDownItems.Add("重新连接",null,async(s,e)=>await Connect());app.DropDownItems.Add("打开数据目录",null,(s,e)=>{Directory.CreateDirectory(config.DataDir);Process.Start("explorer.exe",config.DataDir);});app.DropDownItems.Add("退出",null,(s,e)=>Close());menu.Items.Add(app);
      app.DropDownItems.Insert(1,new ToolStripMenuItem("安装到此电脑",null,(s,e)=>{try{Program.Install(config);MessageBox.Show("安装完成。桌面和开始菜单已添加入口，群聊数据保持不变。","Codex × Harness");}catch(Exception error){ShowError("安装未完成："+Program.Safe(error.Message),error);}}));
      var help=new ToolStripMenuItem("帮助");help.DropDownItems.Add("项目与反馈",null,(s,e)=>OpenExternal("https://github.com/HJLiyu/deepseek-harness-plugin"));help.DropDownItems.Add("关于",null,(s,e)=>MessageBox.Show("Codex × Harness Desktop 0.4.0-preview\n群聊、模型接入和协作工作台\n本机运行，使用既有项目与会话。","关于"));menu.Items.Add(help);MainMenuStrip=menu;
      var footer=new StatusStrip();status.Text="正在启动本机服务…";footer.Items.Add(status);
      web.Dock=DockStyle.Fill;web.Visible=false;errorPanel.Dock=DockStyle.Fill;errorPanel.Padding=new Padding(40);errorLabel.Dock=DockStyle.Top;errorLabel.Height=120;errorLabel.Font=new Font("Microsoft YaHei UI",12);errorLabel.Text="正在启动 Codex × Harness…";
      var retry=new Button{Text="重新连接",Dock=DockStyle.Top,Height=44};retry.Click+=async(s,e)=>await Connect();errorPanel.Controls.Add(retry);errorPanel.Controls.Add(errorLabel);
      Controls.Add(web);Controls.Add(errorPanel);Controls.Add(footer);Controls.Add(menu);Shown+=async(s,e)=>await Connect();FormClosing+=(s,e)=>{closing=true;SaveState();StopBridge();web.Dispose();};
    }
    SavedState LoadState(){try{var bytes=ProtectedData.Unprotect(File.ReadAllBytes(stateFile),null,DataProtectionScope.CurrentUser);return Program.Json.Deserialize<SavedState>(Encoding.UTF8.GetString(bytes))??new SavedState();}catch{return new SavedState();}}
    void SaveState(){try{var bytes=ProtectedData.Protect(Encoding.UTF8.GetBytes(Program.Json.Serialize(state)),null,DataProtectionScope.CurrentUser);string temporary=stateFile+".tmp";File.WriteAllBytes(temporary,bytes);if(File.Exists(stateFile))File.Replace(temporary,stateFile,null);else File.Move(temporary,stateFile);}catch(Exception e){Program.Log(e);}}
    void ScheduleSave(){saveTimer.Stop();saveTimer.Start();}
    public void ShowError(string text,Exception error){if(error!=null)Program.Log(error);if(closing||IsDisposed)return;status.Text="连接需要检查";errorLabel.Text=text;errorPanel.Visible=true;errorPanel.BringToFront();}
    async Task Connect(){
      if(starting||closing)return;starting=true;
      try{
        StopBridge();status.Text="正在连接本机工作台…";
        if(!File.Exists(config.NodePath))throw new Exception("找不到 Node.js，请在 appsettings.json 中设置 NodePath 或安装 Node.js 24+。");
        string entry=Path.Combine(config.RuntimeRoot,"desktop","service.mjs");if(!File.Exists(entry))throw new Exception("桌面运行文件不完整，请重新安装软件。");
        if(web.CoreWebView2==null){
          var environment=await CoreWebView2Environment.CreateAsync(null,Path.Combine(config.UiDataDir,"WebView2"));await web.EnsureCoreWebView2Async(environment);
          var core=web.CoreWebView2;core.Settings.AreDevToolsEnabled=false;core.Settings.AreDefaultContextMenusEnabled=false;core.Settings.AreBrowserAcceleratorKeysEnabled=false;core.Settings.IsPasswordAutosaveEnabled=false;core.Settings.IsGeneralAutofillEnabled=false;
          core.NavigationStarting+=(s,e)=>{Uri u;if(Uri.TryCreate(e.Uri,UriKind.Absolute,out u)&&u.GetLeftPart(UriPartial.Authority)==origin)return;e.Cancel=true;if(e.IsUserInitiated)OpenExternal(e.Uri);};
          core.NewWindowRequested+=(s,e)=>{e.Handled=true;Uri u;if(Uri.TryCreate(e.Uri,UriKind.Absolute,out u)&&u.GetLeftPart(UriPartial.Authority)==origin)core.Navigate(e.Uri);else if(e.IsUserInitiated)OpenExternal(e.Uri);};
          core.PermissionRequested+=(s,e)=>e.State=CoreWebView2PermissionState.Deny;core.DownloadStarting+=(s,e)=>e.Cancel=true;
          core.ProcessFailed+=(s,e)=>ShowError("界面进程已停止。任务由本机服务保留，请选择重新连接。",null);
          core.SourceChanged+=(s,e)=>{Uri u;if(Uri.TryCreate(core.Source,UriKind.Absolute,out u)&&u.GetLeftPart(UriPartial.Authority)==origin&&Regex.IsMatch(u.AbsolutePath,@"^/(?:g/[0-9a-f-]+)?$")){state.LastPath=u.AbsolutePath;ScheduleSave();}};
          core.WebMessageReceived+=(s,e)=>{try{Uri u;if(!Uri.TryCreate(e.Source,UriKind.Absolute,out u)||u.GetLeftPart(UriPartial.Authority)!=origin)return;var m=Program.Json.Deserialize<Dictionary<string,object>>(e.WebMessageAsJson);string key=m.ContainsKey("key")?m["key"] as string:null;if(m.ContainsKey("type")&&(m["type"] as string)=="session"&&AllowedKey(key)&&m.ContainsKey("value")){string value=m["value"] as string;if(value!=null&&value.Length<=700000){state.Session[key]=value;ScheduleSave();}}}catch{}};
          string restore=Program.Json.Serialize(state.Session);
          await core.AddScriptToExecuteOnDocumentCreatedAsync("if(location.hostname==='127.0.0.1'&&window===window.top){window.__CODEX_HARNESS_DESKTOP__=true;const saved="+restore+";for(const k of Object.keys(saved))sessionStorage.setItem(k,saved[k]);const original=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){original.call(this,k,v);if(this===sessionStorage&&['groupDrafts/v1','group-preview-open','group-preview-width'].includes(k))window.chrome.webview.postMessage({type:'session',key:k,value:String(v)});};}");
        }
        var info=new ProcessStartInfo(config.NodePath,"\""+entry+"\""){WorkingDirectory=config.RuntimeRoot,UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true,StandardOutputEncoding=Encoding.UTF8,StandardErrorEncoding=Encoding.UTF8};info.EnvironmentVariables["ELECTRON_RUN_AS_NODE"]="1";
        bridge=new Process{StartInfo=info,EnableRaisingEvents=true};var owned=bridge;
        owned.OutputDataReceived+=(s,e)=>{if(e.Data==null||e.Data.Length>32768||closing)return;try{var m=Program.Json.Deserialize<Dictionary<string,object>>(e.Data);BeginInvoke((Action)(()=>{if(bridge!=owned||closing)return;var type=m["type"] as string;if(type=="ready")Ready(m["url"] as string);else if(type=="disconnected"||type=="error"){status.Text=m["message"] as string;if(!web.Visible)errorLabel.Text=status.Text;}}));}catch{}};
        owned.ErrorDataReceived+=(s,e)=>{if(!String.IsNullOrEmpty(e.Data))Program.Log(new Exception("本机服务启动器报告错误；请检查数据目录与运行文件。"));};
        owned.Exited+=(s,e)=>{if(!closing)try{BeginInvoke((Action)(()=>{if(bridge==owned)ShowError("本机连接进程已退出，请选择重新连接。",null);}));}catch{}};
        owned.Start();owned.BeginOutputReadLine();owned.BeginErrorReadLine();owned.StandardInput.WriteLine(Program.Json.Serialize(new{action="start",dataDir=config.DataDir}));
      }catch(Exception e){ShowError("启动失败："+Program.Safe(e.Message),e);}finally{starting=false;}
    }
    static bool AllowedKey(string key){return key=="groupDrafts/v1"||key=="group-preview-open"||key=="group-preview-width";}
    void Ready(string url){
      if(!Program.IsLocalUrl(url)){ShowError("服务返回了不受支持的地址。",null);return;}
      var u=new Uri(url);string nextOrigin=u.GetLeftPart(UriPartial.Authority);bool changed=currentReady!=url;origin=nextOrigin;currentReady=url;status.Text="已连接 · 群聊与模型接入 · 本机数据";
      errorPanel.Visible=false;web.Visible=true;web.BringToFront();
      if(changed||String.IsNullOrEmpty(web.CoreWebView2.Source)||web.CoreWebView2.Source=="about:blank"){
        string last=Regex.IsMatch(state.LastPath??"",@"^/(?:g/[0-9a-f-]+)?$")?state.LastPath:"/";web.CoreWebView2.Navigate(origin+last+u.Fragment);
      }
    }
    void StopBridge(){var owned=bridge;bridge=null;if(owned==null)return;try{if(!owned.HasExited){owned.StandardInput.WriteLine("{\"action\":\"stop\"}");owned.StandardInput.Close();if(!owned.WaitForExit(1500))owned.Kill();}}catch{}owned.Dispose();}
    static void OpenExternal(string url){Uri u;if(!Uri.TryCreate(url,UriKind.Absolute,out u)||!String.IsNullOrEmpty(u.UserInfo)||(u.Scheme!="https"&&u.Scheme!="http"))return;try{Process.Start(new ProcessStartInfo(u.AbsoluteUri){UseShellExecute=true});}catch{}}
  }
}
