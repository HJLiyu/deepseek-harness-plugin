# Codex × Harness

让 Codex 和另一位 AI 在同一个项目群里协作：共享需求、各自保持上下文、按需分工、独立复核，真人可以随时插话。

这是面向个人本机使用的社区预览版。目前实际验证环境是 Windows、Node.js 24、Codex 桌面版／CLI 和 DeepSeek Harness。欢迎通过 [Issues](https://github.com/HJLiyu/deepseek-harness-plugin/issues) 提交问题、建议和兼容性结果，也欢迎 PR。

## 能做什么

- 一个群绑定一个 Git 项目，成员使用独立工作树；变更经过验证后串行整合。
- 原生 Codex × Harness 群支持双端原生输入、共享群聊与可见协作频道。
- 新增“API／CLI 模型接入”页面：DeepSeek、OpenAI 兼容服务、自定义地址、Ollama；CLI 支持 Codex app-server 和 Harness ACP。
- 可选择预设、密钥方式、模型，检测连接、读取模型目录，手动发起短对话测试。
- 每群复用一对专用上下文；增量同步历史，用量缺失如实标记；默认每需求最多 3 轮协商。
- 工具执行与投递保留检查点；结果未知时不自动重放写入、命令或整轮任务。

## 安装与打开

需要 Git、Node.js 24+、已登录并可用的 Codex。使用原生 Harness 群还需要已安装的 Harness 和 companion；API 或 Codex CLI 伙伴不需要桌面 Harness。

```powershell
git clone https://github.com/HJLiyu/deepseek-harness-plugin.git
cd deepseek-harness-plugin
node scripts/install.mjs --check
node scripts/install.mjs
node cli.mjs group-open
```

安装器注册此仓库的本地 marketplace，不下载模型或复制整个运行环境。找不到 CLI 时，将 `CODEX_BIN` 设为真实 Codex 可执行文件绝对路径。仓库直接启动与插件安装使用的数据目录可能不同：需复用指定运行实例时，用 `HARNESS_PLUGIN_DATA` 指定该实例的数据目录，不能同时运行两个协调器操作同一份数据库。

若 Codex 要求审核钩子，请在宿主界面审核 SessionStart、UserPromptSubmit；安装器不能代你信任。部分 CLI 发行版需要加 `--no-daemon` 才能进入钩子管理界面。不要使用不完整的 CLI 包。

## 接入另一位 AI

1. 打开群聊导航中的 **API／CLI 模型接入**。
2. 选择预设。API 填基础地址（例如 `https://api.deepseek.com/v1` 或 `http://127.0.0.1:11434/v1`）；CLI 点击自动查找，并核对程序和参数。
3. 密钥可引用环境变量，也可在 Windows 以当前用户 DPAPI 加密保存。密钥不会在列表、浏览器本地存储或导出中回显。环境变量必须由运行服务的进程继承；MCP 方式需要在 `mcp.json` 的 `env_vars` 中包含该变量。更改变量后需重开对应服务；可用加密保存避免调整环境。
4. 保存后点 **检测与模型目录**，此操作不发起模型推理。API **测试对话**会发送一条短消息，可能计费。
5. 返回 **新建项目群**，选择已保存的 AI 伙伴，明确填写模型，以及一个单独的真人 Codex 审批聊天编号。它必须与成员聊天分开。已有群不会被自动换模型或换上下文。

API 伙伴有项目内 `read_file`、`list_files`、`write_file` 和 `run_command` 工具。计划与复核阶段禁止写文件和任意命令。项目外文件访问、每条任意命令都需要真人单次批准；命令通过 Codex 原生沙箱运行。完整访问参数须在原生审批中明确批准。API 一次投递最多 20 次工具迭代，响应、文件和命令输出有大小上限。

审批时群里显示完整操作和“批准／拒绝 群编号 审批编号”指令。请在建群时指定的真人聊天发送其中一行。插件核验新增的原生用户记录；模型回复、群内身份标签和旧批准都不能授权。拒绝后不执行。新需求会使旧版本的未执行操作失效。

Codex CLI 使用自己的登录态和原生工作区沙箱；Harness ACP 使用独立 CLI 会话，通过当前版本支持的 session/resume 或 session/load 恢复，并在独立子进程加载阶段权限策略。两种 CLI 的原生文件读取边界取决于宿主，工作区写入沙箱通常不隔离所有读取。CLI 上报的越界审批会转交真人，插件不会把提示词当作安全隔离。

外部伙伴目前串行执行，不启用双执行者并行；仍可分工、复核和轮换整合者。外部 API／CLI 不提供桌面 Harness 原生聊天入口。API 不支持附件、流式兼容或所有厂商特有推理参数。API 密钥有效性与真实付费模型推理需要用户自己的服务验证，本仓库测试不把模拟服务当作真实供应商验收。

## 原生 Harness companion

`companion/` 是 Harness 的 `dsh-codex-group` 本地插件，配合桌面／Web profile 使用。由宿主加载与其版本匹配的插件，而不是把桌面会话交给另一版本的全局 CLI。安装时需配置 `adapterId`（例如 harness-desktop）、`descriptorFile`（实际数据目录的 group-service.json）、`serviceWorker`（实际安装根目录的 group-worker.mjs）。可使用 `node scripts/install-companion.mjs <profile> <runtimeRoot> <dataRoot>`；它保留一份旧配置，宿主在线时优先热更新，首次加载才可能需要重开 Host。

## 开发与反馈

```powershell
node scripts/check.mjs
node --test tests/*.test.mjs
```

无需 npm install：协调器仅使用 Node 内置模块。companion 使用 Harness 宿主提供的接口。见 [CONTRIBUTING.md](CONTRIBUTING.md)、[验证范围](docs/connections.md) 和 [MIT License](LICENSE)。请勿在 Issue 中附带 API 密钥、Cookie、完整聊天数据库或本机页面 URL 的 `#` 片段。

实现参考：[Codex app-server](https://learn.chatgpt.com/docs/app-server)、[OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling)。
