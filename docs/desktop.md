# Windows 桌面软件

桌面版是独立的 `CodexHarness.exe`，使用 WinForms 原生窗口和系统 WebView2 Runtime。无需浏览器窗口或浏览器应用模式。群聊、模型接入、协作状态和项目设置在同一窗口里操作。

## 使用

1. 从 GitHub Release 下载 Windows x64 ZIP，解压到一个普通目录。
2. 双击 `CodexHarness.exe` 打开。需要 Node.js 24+、Microsoft WebView2 Runtime，以及可用的 Codex 登录。软件复用已安装的运行时，不捆绑另一份大型浏览器或 Node。
3. 可在“应用 → 安装到此电脑”创建当前用户的桌面和开始菜单入口，无需管理员权限。版本文件放在 LocalAppData/Programs/CodexHarness，群聊、凭据和界面数据单独保存。
4. 已有插件数据可在首次安装时指定：`CodexHarness.exe --install --data-dir "实际数据目录绝对路径"`。程序不会复制、覆盖或自动合并其他数据库。当前开发机安装已绑定原有群数据。

从左侧“新建项目群”旁的“模型接入”打开模型管理，无需滚动长侧栏。模型管理在群聊内打开；“使用此连接新建群”会带入已保存的模型，创建前仍需填写项目并确认。打开或关闭模型管理不清空群聊草稿。密钥输入框关闭后会清空。

桌面软件只运行一个相同数据目录的实例，再次打开会激活原窗口。最后群选择及群聊草稿以 Windows 当前用户 DPAPI 加密保存，关闭重开可以恢复。主界面不会把本机访问令牌放进地址栏或日志。

软件窗口打开时，协调器可继续已授权工作。关闭桌面版不会杀死共享协调器或重复任务；其他原生应用仍打开时按原规则继续，所有应用都关闭后由既有生命周期检查暂停并保留原生检查点。重开只核对检查点，不盲目重发操作。初版仍保留 Codex／Harness 的原生审批链；CLI 文件隔离边界由宿主决定。

## 开发

```powershell
node scripts/build-desktop.mjs --package
```

需要 Windows x64 与 .NET Framework 4.8 编译器。构建脚本从官方 NuGet 下载固定版本 WebView2 SDK（约9.4MiB），校验固定 SHA256，缓存到用户的 .codex/cache/webview2-sdk。仅打包原生宿主、三个 SDK 运行文件和明确列出的应用源码；不打包聊天数据、凭据、本机配置、WebView 用户配置和 Node.exe。

输出固定到 data/desktop/current，发布 ZIP 在 data/releases；复用同一套生成目录。WebView2 SDK 文件遵循包内 Microsoft 许可，本项目源代码遵循 MIT。该预览版未使用付费代码签名证书。

参考：[Microsoft WinForms WebView2](https://learn.microsoft.com/en-us/microsoft-edge/webview2/get-started/winforms)、[WebView2 运行时分发](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)。
