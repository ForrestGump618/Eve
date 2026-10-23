# OmicsLab

> **归档文档（历史）**：本文件是 Suwen 1.2→2.0 开发过程的原始记录，仅用于追溯，不是当前用户文档。当前文档入口见 [docs/README.md](../README.md)。

> **1.3.0 工作区升级版**：SSH 页可直接把已有连接与远程目录设为工作区；工作台控制台、文件、变量和智能体工具在选定工作区执行。新增统一明暗 Studio 主题。[升级说明与验证范围](../UPGRADE-1.3.md)。Windows 可运行根目录 `启动工作台.ps1`。

**本地优先、开源、无订阅的生物医学分析工作台。**

OmicsLab 把「对话式 AI」「共享 Jupyter 内核」「变量 / 文件 / 图表管理」「技能库与多智能体」放进同一个本地 Web 界面，并在二期加入视觉理解、RSI 自主科研发现、函数注册表与 SSH 远程算力，在 1.2.0 加入**持久运行与恢复**（run / trace / 事件落 SQLite，断线可续）、**工作区**（本地目录或 SSH 主机独立隔离）与**统一执行后端**（`local` / `ssh`）。数据留在你自己的机器上，模型可以接 DeepSeek、通义千问、Ollama 本地模型或任意 OpenAI / Anthropic 兼容端点。

> **独立实现声明**
>
> OmicsLab 是一个**独立开源实现**。它的功能范围参考了同类商业数据分析工作台（例如 OmicOS）**公开文档中描述的功能面**，用于确定「一个现代组学分析工作台应该有哪些能力」。本项目**不包含、不复制、不反编译**任何第三方产品的代码、prompt、技能文本、图标或其他资源；**不提供、也不实现任何订阅或授权校验的绕过**。本项目所有代码、提示词、技能与文档均从零编写。请通过官方渠道支持你使用的商业产品。

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../../LICENSE)
[![Python](https://img.shields.io/badge/python-3.10%2B-blue.svg)](pyproject.toml)

---

## 目录

- [为什么是 OmicsLab](#为什么是-omicslab)
- [功能总览](#功能总览)
- [快速开始](#快速开始)
- [配置 LLM](#配置-llm)
- [内置技能与智能体](#内置技能与智能体)
- [目录结构](#目录结构)
- [架构一览](#架构一览)
- [1 分钟扩展](#1-分钟扩展)
- [命令行](#命令行)
- [发布与打包](#发布与打包)
- [常见问题](#常见问题)
- [文档](#文档)
- [贡献](#贡献)
- [许可证](#许可证)

---

## 为什么是 OmicsLab

- **本地优先**：服务只监听 `127.0.0.1`，会话、内核、图表、记忆全部写在你自己的 `~/.omicslab` 与工作区里，默认不上传任何数据。
- **开源且全部功能免费**：没有订阅档位、没有功能锁。你看到的每一种能力在 `main` 分支里都是完整实现的。
- **共享内核**：对话、变量浏览器、后台任务共用同一个 IPython 内核，`adata` 这类变量在多次提问之间持续存在 —— 和 Jupyter 里干活的心智模型一致。
- **可替换模型**：DeepSeek / 通义千问 / 智谱 / Kimi / OpenAI / Anthropic / OpenRouter / 硅基流动 / Gemini / Ollama / 自建端点，一个设置页搞定。
- **可扩展**：为自己的课题加一个 Agent、写一个 Skill、补一个工具或一个执行后端，都是一两个 Markdown 文件或一个 `ToolSpec` / 子类的事。

---

## 功能总览

| 能力 | 说明 | 是否免费 |
|---|---|---|:---:|
| 💬 对话式 Agent | 流式输出、思维链、工具调用卡片、图片内联、停止 / 重发 | ✅ |
| 🧠 共享 Jupyter 内核 | 一个常驻 IPython 内核，变量跨轮次、跨面板共享 | ✅ |
| 🔬 变量浏览器 | 实时列出 `adata` / `DataFrame`，查看 shape、列名、dtype、head、describe | ✅ |
| 📁 文件管理 | 工作区内目录树、上传下载、文本 / 图片 / CSV 预览、新建与删除 | ✅ |
| 🖼️ 图表画廊 | 自动收集内核生成的 matplotlib 图，缩略图 + 灯箱 + 下载 + 删除 | ✅ |
| ⏱️ 后台任务 | 长任务（Python / Shell）后台执行，增量日志、状态轮询、取消 | ✅ |
| 🧩 技能库 | 18 个内置组学技能包，按需加载 SKILL.md 操作指南与脚本 | ✅ |
| 📝 记忆 | 把项目偏好、数据字典、结论沉淀成可复用的 Markdown 记忆条目 | ✅ |
| 👥 多智能体 | `lead` 调度 + 12 个专职 Agent（单细胞 / 空间 / 流式 / 绘图 / 报告 / 审稿 / 发现 / 远程算力…），可 `delegate_agent` 派生子任务（独立 trace、并发/深度/预算受控） | ✅ |
| 🖼️ 视觉理解 | 独立视觉模型（OpenAI / Anthropic 协议），`analyze_image` 解读图表与显微图像 | ✅ |
| 🧪 RSI 科研发现 | 观察 → 假设 → 预注册 → 真实执行 → 证据分级 → 反思 → 策略进化的 7 步自主发现闭环 | ✅ |
| 🔎 函数注册表 | 内省已安装科学计算包，函数签名 / 摘要可搜索，避免模型猜 API | ✅ |
| 🧷 持久运行与恢复 | 每个回合持久化为 run / trace / 事件（SQLite schema v3）：断线可重放、页面切换不中断、进程重启后把未完成运行对账为 `interrupted` | ✅ |
| 🗂️ 工作区 | 本地目录或 SSH 主机都是工作区，各自独立内核作用域与会话绑定，默认 `ws_main` | ✅ |
| 🖥️ SSH 远程算力 | 连接档案与凭据管理、命令执行、SFTP 上传下载、目录浏览、远端信息采集、真 PTY 终端；远端还可作为工作区的执行后端 | ✅ |
| 🧾 轨迹回放 | 运行事件（工具调用、审批、文本增量）写入 SQLite，可回放审计；旧版 JSONL 轨迹只读兼容 | ✅ |
| 📡 SSE 流式 | 标准 `text/event-stream` 协议，事件 `after_seq` 重放 + 15s 心跳，断线自动续传 | ✅ |
| 🛡️ 审批策略 | `auto` 全自动 / `ask` 对 shell、写文件、远程执行等敏感工具逐次确认；审批绑定 run，可在审批中心统一处理 | ✅ |
| 🔌 多 LLM Provider | OpenAI / Anthropic 兼容协议，14 个预置 Provider（含火山方舟、Ollama 与离线 Mock）+ 自定义端点 | ✅ |
| 🌙 本地 & 离线 | 无 CDN、无构建步骤；可接 Ollama 完全离线跑 | ✅ |

界面共 **12 个页面**：工作台、对话、发现、变量、文件、图库、任务、技能、函数库、记忆、SSH、设置。
「工作台」汇总工作区切换、会话与计算面板；聊天页支持断线重连后继续查看同一运行的事件流。

---

## 快速开始

### 前置条件

- **Python 3.10+**（开发环境使用 3.11）
- Windows 10/11、macOS 或 Linux
- 首次安装依赖需要网络（离线安装见 [docs/INSTALL.md](../INSTALL.md)）

### Windows（PowerShell）

```powershell
cd omicslab
.\scripts\bootstrap.ps1
.venv\Scripts\python.exe -m omicslab serve --port 5077
# 打开 http://127.0.0.1:5077
```

### macOS / Linux（bash）

```bash
cd omicslab
./scripts/bootstrap.sh
.venv/bin/python -m omicslab serve --port 5077
# 打开 http://127.0.0.1:5077
```

`bootstrap` 做的事：找到可用的 Python → 创建 `.venv` → 升级 pip → `pip install -e .` → 打印下一步命令。重复执行是安全的。

**装完先体检：**

```powershell
.venv\Scripts\python.exe -m omicslab env       # Windows：环境自检
.venv\Scripts\python.exe -m omicslab doctor    # 同上；doctor 是 env 的别名
```

```bash
.venv/bin/python -m omicslab env               # macOS / Linux
```

`env`（别名 `doctor`）会逐项检查 Python 版本、依赖、内核解释器、工作区、LLM 配置是否就绪，并给出修复建议；`--json` 输出机器可读结果，`--strict` 在必需依赖缺失时返回非零退出码（适合 CI）。

### 指定工作区

默认工作区是启动命令所在的当前目录。你的数据放在哪，就把工作区指到哪：

```powershell
.venv\Scripts\python.exe -m omicslab serve --port 5077 --workspace D:\projects\pbmc
```

Web 界面里的文件树、读写工具、后台任务都限制在这个目录内。1.2.0 起，启动目录会注册为默认工作区
`ws_main`；你可以在「工作台」页新建更多工作区（本地目录或 SSH 主机），每个工作区有独立的内核作用域，
互不污染变量。

---

## 配置 LLM

OmicsLab 需要一个大模型才能对话。任选一种方式配置（优先级：**设置页 / settings.json > 环境变量 > 自动推断**）。

### 方式一：Web 设置页（推荐）

启动服务后打开 `http://127.0.0.1:5077` → **设置**：

1. 选择 Provider（如 DeepSeek）；
2. 粘贴 API Key；
3. 选择或手填模型名；
4. 点 **保存并测试**，看到 `pong` 即成功。

Key 保存在 `~/.omicslab/auth.json`（本地文件，不会随仓库提交）。

### 方式二：环境变量

`.venv\Scripts\Activate.ps1`（Windows）或 `source .venv/bin/activate`（macOS/Linux）后设置：

| Provider | 环境变量 | 默认模型 |
|---|---|---|
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-3-5-sonnet-latest` |
| 通义千问（DashScope） | `QWEN_API_KEY` | `qwen-plus` |
| 智谱 GLM | `ZHIPU_API_KEY` | `glm-4-flash` |
| 火山方舟（Volcengine Ark） | `ARK_API_KEY`（或 `VOLCENGINE_API_KEY`） | 推理接入点 ID `ep-...`（必填） |
| Moonshot Kimi | `MOONSHOT_API_KEY` | `moonshot-v1-32k` |
| Ollama（本地） | `OLLAMA_API_KEY`（可留空） | `qwen2.5:7b` |
| OpenRouter | `OPENROUTER_API_KEY` | `deepseek/deepseek-chat` |
| 硅基流动 | `SILICONFLOW_API_KEY` | `Qwen/Qwen2.5-7B-Instruct` |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.0-flash` |

```powershell
# Windows PowerShell（仅当前会话生效）
$env:DEEPSEEK_API_KEY = "sk-..."
.venv\Scripts\python.exe -m omicslab serve --port 5077
```

```bash
# macOS / Linux
export DEEPSEEK_API_KEY="sk-..."
.venv/bin/python -m omicslab serve --port 5077
```

### 方式三：配置文件

编辑 `~/.omicslab/auth.json`（Windows 为 `C:\Users\<你>\.omicslab\auth.json`）：

```json
{
  "DEEPSEEK_API_KEY": "sk-...",
  "QWEN_API_KEY": "sk-..."
}
```

### Provider 前缀规则

Provider 由 **provider id + 模型名** 共同决定，规则如下：

1. 显式设置优先：设置页里的 `provider`，或环境变量 `OMICSLAB_LLM_PROVIDER` / `OMICSLAB_PROVIDER`。
2. 只有模型名时按**模型名前缀**推断：`deepseek-chat` → DeepSeek，`qwen-plus` → 通义千问，`glm-4-flash` → 智谱，`gpt-4o-mini` → OpenAI，`claude-*` → Anthropic。
3. 都推断不出来时，按已配置 Key 的优先级自动选第一个可用 Provider。
4. 模型名可以显式覆盖：`OMICSLAB_LLM_MODEL` / `OMICSLAB_MODEL`。

> ⚠️ **有歧义时请显式指定 provider**。例如本地 Ollama 跑 `qwen2.5:7b`，模型名里含 `qwen`，会被推断成通义千问云端；请在设置页把 Provider 选成 **Ollama**（base URL 默认 `http://127.0.0.1:11434/v1`）。
>
> 自定义端点同理：`custom_openai`（base 由 `CUSTOM_OPENAI_API_BASE` 指定）与 `custom_anthropic`（base 由 `CUSTOM_ANTHROPIC_API_BASE` 指定）需要显式选择 provider，不会自动推断。

### 完全离线（Ollama）示例

```powershell
# 1) 本机先拉起 Ollama 并下载模型
ollama pull qwen2.5:7b
# 2) 启动 OmicsLab，设置页选择 Ollama / qwen2.5:7b
.venv\Scripts\python.exe -m omicslab serve --port 5077
```

---

## 内置技能与智能体

**智能体**（`omicslab/agents/*.md`，13 个）：`lead`（默认总调度）、`single-cell-analyst`、`spatial-analyst`、`flow-cytometrist`、`figure-designer`、`report-writer`、`data-critic`，以及二期的 `discovery-lead`、`hypothesis-smith`、`experiment-designer`、`evidence-critic`、`research-strategist`、`remote-compute-engineer`。

**技能包**（`omicslab/skills/*/SKILL.md`，18 个）：一期的 `single-cell-upstream`、`single-cell-downstream`、`spatial-transcriptomics`、`flow-cytometry`、`bulk-transcriptomics`、`cadd-cheminformatics`、`geo-public-data`、`figure-style`、`report-writing`、`notebook-ops`，以及二期的 `rsi-discovery-loop`、`hypothesis-generation`、`experimental-design`、`statistical-rigor`、`causal-inference`、`remote-compute-ssh`、`function-registry`、`vision-interpretation`。

技能不会一次性塞进上下文：Agent 先用 `skill_list` 看目录，需要时再用 `skill_view` 读取正文与附带脚本。详见 [docs/SKILLS.md](../SKILLS.md)。

---

## 目录结构

```text
omicslab/
├── pyproject.toml            # 包定义、依赖、pytest 配置
├── README.md                 # 你正在读的文件
├── LICENSE                   # Apache-2.0
├── CHANGELOG.md              # 版本变更记录
├── scripts/
│   ├── bootstrap.ps1         # Windows 一键装环境
│   ├── bootstrap.sh          # macOS / Linux 一键装环境
│   ├── dev.ps1               # Windows 开发模式（serve 支持 --reload 时自动启用）
│   ├── dev.sh                # macOS / Linux 开发模式
│   ├── smoke.py              # 端到端冒烟（真起服务，mock 模型跑一轮对话/内核/图表/文件）
│   ├── check_dist.py         # 校验 dist/ 里的 wheel 与 sdist 内容
│   ├── publish.ps1           # Windows：测试 → 打包 → 校验 → SHA256
│   └── publish.sh            # macOS / Linux：同上
├── docs/
│   ├── CONTRACTS.md          # 一期并行开发接口契约（内部）
│   ├── CONTRACTS-2.md        # 二期并行开发接口契约（内部）
│   ├── CONTRACTS-3.md        # 1.2.0 并行开发接口契约（内部）
│   ├── ARCHITECTURE.md       # 组件、请求生命周期、数据落盘、安全边界
│   ├── EXTENDING.md          # 自定义 Agent / Skill / Memory / Tool / 执行后端
│   ├── SKILLS.md             # 内置技能目录
│   ├── API.md                # REST + SSE 接口参考（含运行/工作区/SSH）
│   ├── COMPARISON.md         # 与商业方案的功能对照
│   └── INSTALL.md            # 安装细节、extras、离线安装
├── omicslab/
│   ├── config.py             # 设置、Provider 目录、路径解析
│   ├── cli.py                # `python -m omicslab` 入口
│   ├── trajectories.py       # 旧版每回合轨迹（JSONL，1.2.0 起只读兼容）
│   ├── kernel/               # Jupyter 内核服务、变量内省、图表捕获
│   ├── runtime/              # 1.2.0 运行与事件：events.py（SQLite schema v3）、runs.py（RunService）
│   ├── workspace/            # 1.2.0 工作区注册表与持久化（workspaces.json）
│   ├── execution/            # 1.2.0 统一执行后端：base.py 接口、local.py、ssh_backend.py
│   ├── agent/
│   │   ├── loop.py           # Agent 主循环（思考 → 工具 → 观察）+ 轨迹
│   │   ├── providers/        # OpenAI / Anthropic / Mock 适配
│   │   ├── tools.py          # 工具注册表与内置工具（31 个）
│   │   ├── templates.py      # Agent 模板加载
│   │   ├── skills.py         # 技能加载与目录
│   │   ├── memory.py         # 记忆存储
│   │   ├── approvals.py      # 审批策略与审批记录
│   │   ├── vision.py         # 视觉模型客户端（OpenAI / Anthropic 协议）
│   │   └── vision_tools.py   # analyze_image 工具
│   ├── discovery/            # RSI 科研发现（types / ledger / engine / evidence / tools）
│   ├── registry/             # 函数注册表（index / tools）
│   ├── ssh/                  # SSH：manager、connections（进程内连接服务）、credentials、worker、tools
│   ├── session/              # 会话持久化、后台任务
│   ├── server/               # FastAPI 路由、SSE、终端 WebSocket
│   │   ├── routes.py         # 会话/内核/文件/设置/健康
│   │   ├── chat.py           # 对话与运行（run）SSE/审批端点
│   │   ├── routes_runtime.py # 运行时间线、子任务、诊断
│   │   ├── routes_workspaces.py # 工作区与作用域内核
│   │   ├── routes_discovery.py
│   │   ├── routes_registry.py
│   │   ├── routes_trajectories.py
│   │   ├── routes_ssh.py
│   │   └── terminal.py       # /ws/terminal（本地 shell / SSH PTY）
│   ├── web/                  # 原生 ES Modules SPA（12 个页面，无构建、无 CDN）
│   ├── skills/               # 内置技能包（每个目录一个 SKILL.md）
│   ├── agents/               # 内置智能体（Markdown + frontmatter）
│   └── data/                 # 内置示例数据 / 资源
└── tests/                    # pytest 测试
```

**用户数据**（默认 `~/.omicslab`，可用 `OMICSLAB_HOME` 覆盖）：

```text
~/.omicslab/
├── settings.json         # UI / 运行设置（含并发、子任务、工作区上限）
├── auth.json             # API Keys（请勿提交）
├── workspaces.json       # 1.2.0 工作区注册表（默认 ws_main）
├── runtime/events.db     # 1.2.0 运行与事件（SQLite schema v3）
├── conversations/        # 会话 JSON（原子写）
├── trajectories/         # 旧版 Agent 轨迹（JSONL，只读兼容）
├── figures/              # 图表 PNG
├── jobs/                 # 后台任务与日志
├── memory/               # 记忆 Markdown
├── discovery/            # RSI 发现项目账本（每项目一个目录）
├── registry/             # 函数索引 index.json
├── ssh.json              # SSH 连接档案（默认不含明文密码）
├── ssh_known_hosts.json  # SSH 主机指纹
├── tmp/                  # 上传/下载临时文件
├── logs/                 # 服务日志
├── kernels/              # 内核连接文件
└── uploads/              # 上传暂存
```

> SSH 密码默认只在进程内存中使用；勾选「记住密码」时交给系统凭据库（`keyring`），
> 系统无凭据库时退化为仅内存，并在 SSH 页与 `GET /api/ssh/diagnostics` 里明确提示。

---

## 架构一览

```text
┌─────────────────────────────────────────────────────────────────────┐
│                     Browser SPA (omicslab/web, 12 pages)            │
│  工作台 │ 对话 │ 发现 │ 变量 │ 文件 │ 图库 │ 任务 │ 技能 │ 函数库 │  │
│  记忆 │ SSH │ 设置                                                   │
│        原生 ES Modules · 无构建 · 无 CDN · SSE 断线重连（after_seq） │
└───────────────┬───────────────────────────────┬─────────────────────┘
                │ fetch/JSON                    │ text/event-stream
┌───────────────▼───────────────────────────────▼─────────────────────┐
│                      FastAPI Server (127.0.0.1)                     │
│  /api/chat /api/runs /api/runtime /api/sessions /api/approvals      │
│  /api/workspaces /api/kernels /api/agents /api/skills /api/memory   │
│  /api/jobs /api/figures /api/files /api/settings /api/health        │
│  /api/discovery/* /api/registry/* /api/trajectories/* /api/ssh/*    │
│  /ws/terminal                                                       │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                 Runtime (omicslab/runtime)                          │
│  RunService：submit / cancel / subscribe / steering / child runs    │
│  EventStore：SQLite schema v3（runs · events · agent_tasks ·        │
│             approvals）→ 先落盘再广播，seq 可重放、异常降级不阻断   │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│                 Agent Loop (per run)                                │
│  system prompt + agent instructions + skill catalog + memory index  │
│         │                                                           │
│         ├── LLM Provider (OpenAI / Anthropic / Mock, 流式)          │
│         ├── Vision Client (OpenAI / Anthropic 图片理解)              │
│         ├── Tool Registry（31 个工具 / 13 个 toolset）               │
│         │     run_python_code · run_shell · files · skills ·        │
│         │     memory · agents · jobs · notebook · discovery_* ·     │
│         │     registry_lookup · analyze_image · ssh_*               │
│         └── Approver (auto / ask，按 run / task 归属审批)            │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────┬─────────────────────┐
│  Workspaces & Kernel Pool                     │  Execution Backends │
│  ws_main + 自定义工作区（local / ssh）         │  LocalExecution     │
│  scope：main / ws:<id> / task:<task_id>        │  SSHExecution       │
│  每作用域一个常驻 IPython 内核                 │  （禁止静默回退）    │
│  变量内省 · 图表捕获 · 中断/重启               │  SFTP + 远端 worker │
└───────────────────────────────┬───────────────┴─────────────────────┘
                                │
┌───────────────────────────────▼─────────────────────────────────────┐
│  Storage (per-user, local)                                          │
│  settings/auth/workspaces · runtime/events.db · conversations      │
│  figures/jobs/memory/logs/discovery/registry/tmp/trajectories/ssh   │
└─────────────────────────────────────────────────────────────────────┘
```

一次提问的旅程：

```text
POST /api/chat
  → RunService.submit：建 run（preparing）→ 先写 SQLite → 返回 SSE 首帧 connected
  → 创建/加载会话，构造上下文（agent 指令 + 技能目录 + 记忆索引）
  → Agent Loop 调 LLM（流式）
      → 文本增量 / 工具调用 / 审批请求 → 每个事件先写 events 表再广播
      → 工具经统一执行后端：local 走本机内核/文件；ssh 走远端 worker/SFTP
      → 子智能体：delegate_agent → 子 run（独立 trace、独立内核作用域）
  → 捕获图表 / 统计用量 → 写终态 + 发 done 事件
  → 断线后 GET /api/runs/{run_id}/stream?after_seq=N 重放缺失事件并继续订阅
```

长任务走独立通道：`POST /api/discovery/projects/{id}/run` 以 SSE 推送 7 步发现闭环；
`POST /api/ssh/exec` 等远程操作走线程池，不阻塞对话。
进程崩溃后重启：所有未完成运行被对账为 `interrupted`（不假装成功），可在 `/api/health` 的
`runs.recovered` 与 `/api/runtime/diagnostics` 里看到清单。

更细的设计（并发、取消、路径沙箱、密钥存储、运行状态机）见 [docs/ARCHITECTURE.md](../ARCHITECTURE.md) 与
[docs/API.md](../API.md) 的 §16-§17。

---

## 1 分钟扩展

### 加一个自己的 Agent

新建 `omicslab/agents/my-analyst.md`（或工作区下的 `agents/my-analyst.md`）：

```markdown
---
id: my-analyst
name: 我的分析助手
description: 专注我自己课题的单细胞注释流程
category: single-cell
toolsets: [python, files, skills, memory]
skills: [single-cell-downstream]
example_prompts:
  - 帮我对我上传的 h5ad 做 leiden 聚类
---

你是我的单细胞分析助手。回答前先确认数据路径与物种。
优先复用 shared kernel 中已存在的变量，避免重复读盘。
```

刷新页面，Agent 下拉框里就会出现它。

### 加一个自己的 Skill

新建工作区下的 `skills/my-qc/SKILL.md`（或 `$OMICSLAB_SKILL_ROOTS` 指向的目录）：

````markdown
---
name: my-qc
description: 我的实验室质控标准流程
when_to_use: 当用户要求按实验室 SOP 做质控时
---

# 我的 QC 流程

1. 过滤 `pct_counts_mt > 15` 的细胞；
2. 用 MAD 方法标记离群细胞；
3. 输出 QC 前后细胞数对比表。

```python
import scanpy as sc
adata = adata[:, ~adata.var_names.str.startswith("MT-")].copy()
```
````

内置技能同名时，用户目录版本优先。

### 加一个工具

在工具注册处追加一个 `ToolSpec`：

```python
from omicslab.agent.tools import ToolSpec, ToolResult

async def hello(ctx, **kwargs) -> ToolResult:
    return ToolResult(tool_call_id="", name="hello", ok=True, content="你好，OmicsLab")

spec = ToolSpec(
    name="hello",
    description="向用户问好（示例工具）",
    parameters={"type": "object", "properties": {}},
    toolset="system",
    handler=hello,
    requires_approval=False,
)
```

### 加一个执行后端

继承 `omicslab/execution/base.py` 的 `ExecutionBackend`，实现 `start/close/execute_python/shell` 与文件方法，
即可让工作区跑在别的算力上（容器、集群、云主机）。`local` 与 `ssh` 是两个已实现的后端，可作为模板。

详见 [docs/EXTENDING.md](../EXTENDING.md)。

---

## 命令行

```powershell
# 启动 Web 服务（默认 127.0.0.1:5077）
.venv\Scripts\python.exe -m omicslab serve --port 5077 --workspace .

# 终端聊天客户端（-p "问题" 单次提问后退出）
.venv\Scripts\python.exe -m omicslab cli

# 环境体检（Python / 依赖 / 内核 / LLM / 工作区）
.venv\Scripts\python.exe -m omicslab env      # 别名：doctor

# 设置与 API Key
.venv\Scripts\python.exe -m omicslab config show
.venv\Scripts\python.exe -m omicslab config set provider deepseek
.venv\Scripts\python.exe -m omicslab config set-key deepseek sk-xxx

# 查看技能库 / 智能体
.venv\Scripts\python.exe -m omicslab skills
.venv\Scripts\python.exe -m omicslab agents

# RSI 科研发现项目（list 为默认动作）
.venv\Scripts\python.exe -m omicslab discovery list
.venv\Scripts\python.exe -m omicslab discovery create --objective "..." --data data\pbmc.h5ad --rounds 3
.venv\Scripts\python.exe -m omicslab discovery run --project dp_xxx
.venv\Scripts\python.exe -m omicslab discovery status --project dp_xxx
```

每个子命令都支持 `--help`；环境体检有三种等价写法：`env`、`doctor`、`env doctor`。

开发模式（自动重载后端）：

```powershell
.\scripts\dev.ps1      # Windows
./scripts/dev.sh       # macOS / Linux
```

---

## 发布与打包

仓库自带发布辅助脚本：跑测试 → 生成 sdist + wheel → 校验产物内容 → 写 `SHA256SUMS.txt`。

```powershell
# Windows（默认输出到 dist/）
.\scripts\publish.ps1

# 跳过测试 / 只校验已生成的产物
.\scripts\publish.ps1 -SkipTests
.venv\Scripts\python.exe scripts\check_dist.py dist
```

```bash
# macOS / Linux
./scripts/publish.sh
python3 scripts/check_dist.py dist
```

发布前建议先跑一次端到端冒烟（真实启动服务，mock 模型跑对话、内核、图表、文件 API；不污染你的 `~/.omicslab`）：

```powershell
.venv\Scripts\python.exe scripts\smoke.py
```

**从产物安装：**

```powershell
python -m pip install dist\omicslab-1.2.0-py3-none-any.whl
omicslab serve --port 5077
```

`dist/` 中的文件：

| 文件 | 说明 |
|---|---|
| `omicslab-1.2.0-py3-none-any.whl` | 纯 Python wheel，含 Web 资源 / 技能 / 智能体 / 示例数据 |
| `omicslab-1.2.0.tar.gz` | 源码包（sdist），含测试、文档与发布脚本 |
| `SHA256SUMS.txt` | 上述文件的 SHA-256 校验和 |

---

## 常见问题

**Q：启动报「没有可用的模型 provider」**
没有检测到任何 API Key。按[配置 LLM](#配置-llm) 设置环境变量或 `~/.omicslab/auth.json` 后重启服务。

**Q：页面能打开但对话一直失败**
先在 **设置 → 测试连接** 验证 Key / Base URL / 模型名。自建端点请确认是 OpenAI 兼容的 `/v1` 路径。

**Q：内核里的包和我终端里的不一致**
内核使用 `settings.kernel_python` 或 `OMICSLAB_KERNEL_PYTHON` 指定的解释器。默认是启动 OmicsLab 的那个 Python；用 `pip install -e ".[bio]"` 装生物信息依赖，并确保内核用的是同一个解释器。

**Q：能完全离线吗？**
可以。设置 Provider 为 `ollama` 指向本机模型即可，界面无任何 CDN 请求，技能包与静态资源都在仓库内。

**Q：我的数据会被上传吗？**
不会。除你配置的 LLM 服务商外，服务不向任何地址发送数据；工作区沙箱限制文件读写不越出工作区。

**Q：刷新页面 / 网络断开，正在跑的分析会丢吗？**
不会。1.2.0 起每个回合是持久化的 run：事件先写 `~/.omicslab/runtime/events.db` 再推给浏览器。
刷新或断线后前端用 `GET /api/runs/{run_id}/stream?after_seq=N` 重放缺失事件并继续订阅；
切换页面、关掉浏览器都不影响后台继续执行。若服务进程崩溃，重启时会把未完成的运行**对账为
`interrupted`**（不会伪装成成功），并在 `/api/health` 的 `runs.recovered` 中列出。

**Q：工作台里的「工作区」是什么？为什么要多个内核？**
工作区是一个目录（本地）或一台远端主机上的根目录（SSH），它决定文件树、变量和内核在哪。
每个工作区有独立的内核作用域（`main` / `ws:<id>` / 子任务 `task:<id>`），所以不同项目的 `adata`
不会互相覆盖；会话绑定到工作区后，它的工具调用就在该工作区内执行。默认工作区是 `ws_main`，
不可删除；工作区在「工作台」页管理。

**Q：子智能体会不会失控（无限派活 / 烧 token）？**
有硬上限：同时运行数 `max_parallel_runs`（默认 8）、每个父运行的子任务数 `max_child_tasks`（默认 4）、
嵌套深度 `max_child_depth`（默认 2），以及每个子任务的预算（迭代 / 时间 / token）。超限会被拒绝并
在父轨迹里留下记录；取消父运行会级联取消整棵子树。

**Q：SSH 的密码会保存吗？连接失败怎么排查？**
默认**不落盘**，只在当前进程内存中使用；勾选「记住密码」时交给系统凭据库（`keyring`），
系统没有可用凭据库时会退化为仅内存，并在界面与 `GET /api/ssh/diagnostics` 中明确提示。
排查顺序：SSH 页「测试连接」看 `error` / `warning` / 延迟与 server_version（首次连接会记录主机指纹，
指纹变化会警告）→ `GET /api/ssh/diagnostics` 看连接池、凭据后端与最近命令 → 远程命令超时可在
`ssh_exec` 的 `timeout_s` 里调整（默认 120 秒，最大 3600）。

> 说明：SSH 本地档案、参数校验与错误映射有单元测试覆盖，但**真实远端主机的端到端行为未在本项目自动化测试中验证**。

**Q：设置页显示已保存 Key，但对话仍提示未配置 / 走了 mock？**
点 **保存并测试**：它会一次请求原子保存 Key + provider + model + api_base，并真实回测一次。
`GET /api/settings` 的 `llm.configured=false` 是「没生效」的准确信号，`llm.error` 会给出缺 Key /
缺 API 地址 / 模型名等可操作建议；按设置页红色提示条补齐即可。

**Q：聊天里的图片为什么没有被自动解读？**
图片附件会先保存到工作区并在消息里列出路径；要理解图片内容，需要在设置页「视觉模型」卡片配置
模型名 / API 地址 / Key（或环境变量 `VISION_API_KEY`），配置后模型会调用 `analyze_image` 工具；
未配置时会得到明确提示，不会静默失败。

**Q：端口被占用？**
`serve --port 5078` 换一个端口即可；或用 `Get-NetTCPConnection -LocalPort 5077`（Windows）/ `lsof -i :5077`（macOS/Linux）查看占用进程。

**Q：Windows 上 `run_shell` / 终端面板需要额外依赖吗？**
不需要。两者都通过 `subprocess` 调用系统中的 shell（优先 `pwsh`，其次 Windows PowerShell / `cmd.exe`），再经 WebSocket 桥接，不依赖 PTY 或 `pywinpty`。终端等价于本机 shell，请只在可信环境使用。

**Q：运行历史存在哪里？会一直变大吗？**
存在 `~/.omicslab/runtime/events.db`（SQLite）。目前没有自动清理接口：删除会话不会删除运行历史。
如确需重置，请先停止服务，再删除该文件（运行历史与崩溃恢复信息会一并丢失；会话与旧的
`trajectories/` 不受影响）。

**Q：和 OmicOS 是什么关系？**
没有任何代码或授权关系。OmicsLab 是独立开源实现，只参考了公开文档描述的功能面，不包含、不复用任何第三方代码或内容，也不提供授权绕过。详见 [docs/COMPARISON.md](../COMPARISON.md)。

---

## 文档

| 文档 | 内容 |
|---|---|
| [docs/INSTALL.md](../INSTALL.md) | 安装、extras、离线安装、内核选择、终端说明 |
| [docs/ARCHITECTURE.md](../ARCHITECTURE.md) | 组件图、请求生命周期、落盘位置、并发/取消、运行状态机、安全边界 |
| [docs/EXTENDING.md](../EXTENDING.md) | 自定义 Agent / Skill / Memory / Tool / 执行后端 / LLM 端点 |
| [docs/SKILLS.md](../SKILLS.md) | 内置技能目录与触发时机 |
| [docs/API.md](../API.md) | REST + SSE 接口参考与示例（含运行/工作区/SSH） |
| [docs/COMPARISON.md](../COMPARISON.md) | 与商业方案的功能对照（及边界声明） |
| [CHANGELOG.md](../../CHANGELOG.md) | 版本变更记录 |

---

## 贡献

1. Fork 仓库并从 `main` 拉分支；
2. 运行 `pytest tests/ -q` 保证既有测试通过；
3. 新增技能 / Agent 请附带 frontmatter，并让 `pytest tests/test_skills.py` 通过；
4. 提交 PR，说明动机、改动范围与验证方式。

代码注释用英文，面向用户的 UI 文案用中文。新增第三方依赖前请先在 Issue 里讨论。

---

## 许可证

本项目基于 [Apache License 2.0](../../LICENSE) 发布。© OmicsLab contributors.

第三方商业产品（包括但不限于 OmicOS）的名称与商标归各自所有者所有，本项目与它们没有隶属或背书关系。
