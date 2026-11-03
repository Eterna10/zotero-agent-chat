# Agent Chat for Zotero

在 Zotero 阅读器里选中文字，在**侧边栏**或**悬浮窗口**里提问；回车后，选中的原文和你的问题会发给本机的 agent 命令行（Claude Code / Codex / 自定义），回复显示在同一处。

支持 Zotero 7、8、9、10。

## 界面

悬浮窗口和侧边栏「Agent 对话」区块是**同一个对话的两个视图**，记录、引用、运行状态同步。

- **顶栏**：论文标题；新对话；设置（悬浮窗另有关闭，标题栏可拖动、右下角可缩放）
- **空白时**：「总结核心贡献 / 方法是怎么做的 / 有哪些局限」一键提问
- **选中文字后**：输入框内显示引用，上方出现「解释 / 翻译 / 公式与符号 / 举个例子」快捷操作；也可以自己输入问题
- **输入框底部**：Agent、模型、Effort 三个选择器（模型和 Effort 列表来自本机 CLI），右侧发送按钮，运行时变为停止
- **回复**：Markdown 渲染（标题、列表、表格、引用、代码块带复制）和 **LaTeX 公式**（`$...$`、`$$...$$`、`\(...\)`、`\[...\]`）；每条回复可「复制 / 存为笔记 / 重新生成」，存为笔记时公式会转成 Zotero 笔记编辑器能显示的公式
- **出错时**：显示可能原因（未登录、找不到命令或 node、模型或 Effort 不支持、CLI 版本旧、网络或代理、额度限制等），可展开查看原始输出，或一键「诊断连接」
- **设置**：当前 agent（命令路径、诊断连接、刷新模型列表）、悬浮窗口开关、对话、运行环境

## 额度显示

顶栏的仪表图标显示当前 agent 订阅额度中**用得最多的那一项**（绿 < 70%，橙 < 90%，红 ≥ 90%），点开可以看到每个窗口的已用比例、进度条和重置时间：

| Agent | 数据来源 | 显示内容 |
|---|---|---|
| Claude Code | stream-json 模式下的 `get_usage` 控制请求（与 `/usage` 同源） | 订阅类型；5 小时、每周（全部模型 / Opus / Sonnet / 按模型）窗口；额外用量 |
| Codex | `codex app-server` 的 `account/rateLimits/read` | 订阅类型；5 小时、每周窗口；剩余 credits |

打开界面时读取一次（5 分钟内用缓存），每次回答完成后自动刷新，面板里也可以手动刷新。用 API Key 登录时没有订阅额度，会显示按用量计费的说明。

## 一键安装与登录

设置里每个 agent 都有「安装 / 更新」和「登录」按钮；「诊断连接」发现找不到命令时，会**弹窗询问是否安装**。安装使用官方脚本：

| Agent | Windows | macOS / Linux |
|---|---|---|
| Claude Code | `irm https://claude.ai/install.ps1 \| iex` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| Codex | `irm https://chatgpt.com/codex/install.ps1 \| iex` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` |

安装输出实时显示在设置页。完成后会询问是否打开终端登录（`claude` 或 `codex login`），登录需要在浏览器里授权；之后点「诊断连接」确认。安装失败时会给出原因和可以手动执行的命令。

## 连不上 agent 时：诊断连接

设置 → 「诊断连接」会依次检查并逐行显示结果：

1. 找到命令的实际路径
2. 运行 `--version`
3. Codex 额外检查 `codex login status`
4. 从本机获取模型列表
5. 用当前选择的模型和 Effort 发一个真实的测试请求，显示耗时和回复，失败时给出原因和原始输出

## 模型与 Effort 列表（从本机 CLI 获取）

模型和 Effort 下拉框的选项来自**你电脑上安装的 agent**，CLI 升级后会自动跟着变化：

| Agent | 获取方式 | 得到的信息 |
|---|---|---|
| Claude Code | 以 SDK 模式启动 `claude -p --input-format stream-json --output-format stream-json --verbose`，发送 `initialize` 控制请求 | 模型别名、显示名（如 Opus 5.5）、说明、每个模型支持的 effort 档位 |
| Codex | 启动 `codex app-server`，JSON-RPC 调用 `initialize` → `model/list` | 模型名、显示名、默认模型、每个模型支持的推理强度及默认档位 |

- 打开对话界面时在后台获取一次，结果缓存 24 小时；⚙ 里可以点「从本机刷新模型列表」立即更新。
- Effort 选项随所选模型变化；所选模型不支持调节 effort 时下拉框显示「不支持」，命令里不会带 effort 参数。
- 换到某个模型后，原先选的 effort 如果它不支持，会自动按「默认」处理（不会报错）；换回来时恢复。
- 获取失败（未登录、版本太旧等）时退回内置预设，模型也可以用「自定义…」手动输入。

## 安装

1. 确认终端里能运行：`claude -p "hello"` 或 `codex exec "hello"`（需已登录）
2. Zotero → 工具 → 插件 → 齿轮 → **Install Plugin From File…** → 选 `zotero-agent-chat.xpi`
3. ⚙ →「测试 Claude Code」，能看到版本号即可开始使用

## 找不到命令时

从开始菜单启动的 Zotero 拿不到终端里的 PATH。在终端查出完整路径，填到 ⚙ 的「命令」里：

```powershell
where.exe claude
where.exe codex
```

Windows 上 npm 会生成 `claude`（无扩展名）、`claude.cmd`、`claude.ps1` 三个文件。插件只会启动 `.exe / .cmd / .bat`，填了另外两个也会自动换成同目录的 `.cmd`。

macOS / Linux 用 `which claude`。

## 调用方式

每次发送拼一段提示词（系统提示 + 论文标题 + PDF 路径 + 最近 N 轮问答 + 选中原文 + 问题），通过 stdin 交给子进程，stdout 作为回答：

| Agent | 命令 |
|---|---|
| Claude Code | `claude -p [--model M] [--effort E] [--add-dir <PDF 所在目录>]` |
| Codex | `codex exec --skip-git-repo-check --sandbox read-only [-m M] [-c model_reasoning_effort=E] -` |
| 自定义 | `<命令> <参数>`；参数含 `{prompt}` 时作为参数传入，否则走 stdin；`{pdf_dir}` 替换为 PDF 目录 |

工作目录是 `<Zotero 数据目录>/agent-chat`。Claude 用默认权限模式，Codex 用只读沙箱。

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 额外 PATH 目录 | 空 | 每行一个 |
| 系统提示词 | 内置中文提示 | 留空即默认 |
| 历史轮数 | 6 | 0 表示每次只发当前问题 |
| 超时 | 300 秒 | 超时自动终止 |
| 启用悬浮窗口 | 开 | 关闭后只用侧边栏；选区菜单和工具栏的 💬 会展开并跳到侧边栏的对话区块 |
| 选中文字时自动弹出悬浮窗口 | 开 | 侧边栏区块可见时不会弹出 |
| 告诉 agent PDF 路径 | 开 | 关掉后 agent 只能看到选中的文字 |

## 文件结构

```
manifest.json / bootstrap.js / prefs.js
content/agent-chat.js
  AgentChat     生命周期、三个入口、子进程调用
  ZacSession    每个窗口一个：对话记录、选中原文、运行状态
  ZacChatView   界面，mode = floating（悬浮窗）| embedded（侧边栏）
locale/*/zotero-agent-chat.ftl
icons/chat.svg
```

## 调试

帮助 → 调试输出日志 → 启用，搜索 `[AgentChat]` 可以看到实际执行的命令行。

## 第三方组件

- [KaTeX](https://katex.org) 0.19.1（MIT，见 `content/lib/LICENSE-katex.txt`）：只用于把 LaTeX 转换成 MathML，排版由 Zotero 内置的 MathML 引擎完成。

## 已知限制

- 回答在进程结束后一次性显示；每轮是新进程，有几秒冷启动。
- 多轮上下文靠重发最近 N 轮问答实现。
- Markdown 只做常用子集的渲染。

## 自动更新

更新文件托管在本仓库：`manifest.json` 的 `update_url` 指向
`https://raw.githubusercontent.com/Eterna10/zotero-agent-chat/main/updates.json`，
其中的 `update_link` 指向 `releases/` 目录下对应版本的 `.xpi`（附 sha256 校验）。

- 从 0.7.0 起，Zotero 会自动检查并安装新版本；也可以在插件管理器里点「Check for Updates」。
- 0.4.3–0.6.x 曾因更新地址无效而默认关闭了本插件的自动更新，升级到 0.7.0 后会自动恢复为 Default。
- 0.6.x 及更早的版本里写的是旧的更新地址，需要**手动安装一次 0.7.0**，之后才能自动更新。

发布新版本：

```bash
# 1. 修改 manifest.json 里的 version
./build.sh                       # 生成 releases/zotero-agent-chat-<版本>.xpi 并更新 updates.json
git add -A && git commit -m "release v<版本>" && git push
```

## 安装包下载

最新版本见 [`releases/`](releases/) 目录，或 [updates.json](updates.json) 里的 `update_link`。
