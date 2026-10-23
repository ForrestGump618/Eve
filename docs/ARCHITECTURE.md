# 架构说明（ARCHITECTURE）

> 本文描述素问 Suwen 2.0.0 的架构与实现约定（主体设计自 1.2.0 延续）。接口历史契约归档在
> [`archive/CONTRACTS.md`](archive/CONTRACTS.md) / [`archive/CONTRACTS-2.md`](archive/CONTRACTS-2.md) / [`archive/CONTRACTS-3.md`](archive/CONTRACTS-3.md)；
> 当前字段与错误码以 `omicslab/server/` 代码为准。若本文与代码不一致，以代码为准，并欢迎提 PR 修正本文。

## 1. 设计目标

1. **本地优先**：单进程、单用户、默认只听 `127.0.0.1`；除用户配置的 LLM 端点外不主动外联。
2. **一个工作区，多个视角**：对话、变量浏览器、后台任务共享同一个工作区内核，避免「每次提问都重新读一遍数据」。
3. **持久可恢复**：每个回合是一等公民的 **run**，事件先落 SQLite 再广播；断线可重放，进程崩溃后不把未完成运行伪装成成功。
4. **执行可替换**：文件、内核、Shell 都经统一的 `ExecutionBackend` 抽象，同一套工具既能跑本机也能跑远端 SSH 工作区。
5. **流式可打断**：生成与工具执行都可取消，取消只影响本 run（及其子任务），并能立刻打断内核里的长计算。
6. **故障不雪崩**：单个坏 skill / 坏 agent 文件、单次工具失败、单个 SSE 断开、运行库写失败，都不能拖垮服务。
7. **可审查**：所有落盘都是 SQLite / JSON / Markdown / PNG，用户随时可以看、可以改、可以备份。

## 2. 组件总览

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser UI  (omicslab/web/**)                                            │
│  index.html + 原生 ES Modules；无构建步骤、无 CDN、离线可用               │
│  工作台 / 对话 / 发现 / 变量 / 文件 / 图库 / 任务 / 技能 / 函数库 /      │
│  记忆 / SSH / 设置                                                       │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ HTTP JSON + SSE + WebSocket
┌──────────────▼───────────────────────────────────────────────────────────┐
│ Server  (omicslab/server/**)                                             │
│  FastAPI + uvicorn；挂载 REST 路由、SSE、/ws/terminal、静态 SPA           │
│  · 生命周期：加载 Settings → 构建单例服务 → 确保目录 → 恢复未完成 run     │
│  · 单例：ConversationStore / WorkspaceService / KernelPool / ToolRegistry│
│          JobManager / MemoryStore / Approver / EventStore / RunService   │
└──────┬──────────────┬──────────────┬──────────────┬──────────────────────┘
       │              │              │              │
┌──────▼──────┐ ┌─────▼──────┐ ┌─────▼──────┐ ┌─────▼─────────────┐
│ Runtime     │ │ Workspaces │ │ AgentLoop  │ │ Storage           │
│ RunService  │ │ WS registry│ │ providers/ │ │ runtime/events.db │
│ EventStore  │ │ KernelPool │ │ tools.py   │ │ ConversationStore │
│ (SQLite v3) │ │ scopes     │ │ skills     │ │ MemoryStore       │
│ approvals   │ │            │ │ approvals  │ │ settings/auth/ws  │
└─────────────┘ └─────┬──────┘ └─────┬──────┘ └───────────────────┘
                      │              │
┌─────────────────────▼──────────────▼─────────────────────────────────────┐
│ Execution Backends (omicslab/execution)                                  │
│  LocalExecutionBackend ──► KernelService / files / JobManager            │
│  SSHExecutionBackend   ──► SFTP + 远端常驻 worker（JSON-lines over stdio）│
└──────────────────────────────────────────────────────────────────────────┘
```

> 示意图覆盖 1.2.0 的核心路径；视觉、RSI 发现、函数注册表与 SSH 工具面见 §2.3。

### 2.1 各组件职责

| 组件 | 位置 | 职责 |
|---|---|---|
| **Browser UI** | `omicslab/web/**` | 纯静态 SPA（12 个页面）。渲染会话、运行事件、变量、文件、图表、工作区；消费 SSE；断线按 `after_seq` 重连。不包含业务逻辑，不直接读盘。 |
| **Server** | `omicslab/server/**` | 路由与鉴权边界（本地监听）。把 HTTP 请求翻译成服务调用，把服务事件编码成 SSE；统一错误信封 `{"error": {...}}`。持有所有单例服务。 |
| **Runtime / RunService** | `omicslab/runtime/runs.py` | 运行生命周期：`submit`（幂等、会话并发检查）、`cancel`（本 run + 子树 + 内核作用域）、`subscribe`（重放 + 心跳）、steering、子任务（`delegate_agent`）与结果聚合。 |
| **EventStore** | `omicslab/runtime/events.py` | SQLite（WAL，schema v3）持久化：`runs` / `events` / `agent_tasks` / `approvals`。先写库再广播；DB 异常降级为内存事件，不阻断主循环。 |
| **WorkspaceService** | `omicslab/workspace/service.py` | 工作区注册表（`home/workspaces.json`）：本地/SSH 工作区、默认 `ws_main`、会话绑定、状态与 scope 解析。 |
| **KernelPool** | `omicslab/server/state.py` | 按 scope（`main` / `ws:<id>` / `task:<task_id>`）懒启动与回收内核；每作用域一个常驻 IPython kernel 与锁。 |
| **ExecutionBackend** | `omicslab/execution/**` | 统一执行接口：内核执行、Shell、文件读写、上传、变量内省；`LocalExecutionBackend` 与 `SSHExecutionBackend` 两实现；`BackendUnavailable` 时**禁止静默回退本地**。 |
| **Agent Loop** | `omicslab/agent/loop.py` | 一次运行的回合状态机：组装上下文 → 调模型 → 解析工具调用 → 执行 → 回填 → 循环直到无工具调用或达到 `max_iterations`；可接收 steering 消息；子智能体走 `run_sub`。 |
| **Providers** | `omicslab/agent/providers/**` | OpenAI 兼容与 Anthropic 两族协议的流式适配，外加 `mock` provider（离线测试用）。统一输出文本增量 / 思维链增量 / 工具调用 / 用量。 |
| **Tools** | `omicslab/agent/tools.py` | `ToolSpec` 注册表：名称、描述、JSON Schema 参数、所属 toolset、是否需审批、异步 handler；工具输出携带 `data.execution_target`。 |
| **Templates** | `omicslab/agent/templates.py` | 加载 Agent 定义（包内 → 工作区 → 环境变量目录，后者覆盖同名 id）。 |
| **Skills** | `omicslab/agent/skills.py` | 加载技能目录（`SKILL.md` + 可选脚本）。默认只把目录注入上下文，正文按需 `skill_view`。 |
| **Memory** | `omicslab/agent/memory.py` | 用户可编辑的长期记忆（Markdown），注入时只取精简索引。 |
| **Approvals** | `omicslab/agent/approvals.py` | `auto` 直接放行；`ask` 时 emit `approval_request` 并等待用户决定，超时按拒绝处理。1.2.0 起审批记录落库、按 `run_id` / `task_id` 归属，`cancel_for_run` / `cancel_for_task` 精确撤销。 |
| **Kernel Service** | `omicslab/kernel/**` | 管理常驻 IPython kernel：启动、执行、超时、中断、重启；变量内省；把 matplotlib 图落成 PNG 并生成 `figure` 事件。 |
| **ConversationStore** | `omicslab/session/store.py` | 会话 JSON 的增删改查与原子持久化；会话 `meta.workspace_id` 绑定工作区。 |
| **JobManager** | `omicslab/session/jobs.py` | 后台 Python / Shell 任务：提交、状态、增量日志、取消、关停。 |
| **Config** | `omicslab/config.py` | `Settings`（持久化 + 环境变量合并）、Provider 目录、密钥解析、路径与目录创建；1.2.0 新增 `max_parallel_runs` / `max_child_tasks` / `max_child_depth` / `max_workspace_scopes` 校验。 |
| **CLI** | `omicslab/cli.py` | `serve` / `cli` / `env`（别名 `doctor`）/ `config` / `skills` / `agents` / `discovery` 子命令。 |
| **Vision** | `omicslab/agent/vision.py`、`vision_tools.py` | 视觉模型客户端（OpenAI 兼容 `image_url` / Anthropic base64 两族协议）与 `analyze_image` 工具；与对话模型解耦。 |
| **Discovery** | `omicslab/discovery/**` | RSI 科研发现：`types.py`（数据模型）、`ledger.py`（JSONL 账本）、`engine.py`（7 步闭环引擎）、`evidence.py`（结构化结果与 `EvidenceEvaluator`）、`tools.py`（`discovery_*` 工具）。 |
| **Registry** | `omicslab/registry/**` | `index.py` 用内核解释器子进程内省科学计算包并落盘索引；`tools.py` 提供 `registry_lookup`。 |
| **SSH** | `omicslab/ssh/**` | `connections.py` 的进程内 `ConnectionService`（共享 `SSHManager` 与凭据，REST/工具/终端/执行后端统一入口）、`manager.py`（连接池、档案、SFTP、远端信息）、`credentials.py`（keyring / 内存凭据）、`worker.py`（远端常驻 worker）、`tools.py`（`ssh_*` 工具）。 |
| **Terminal** | `omicslab/server/terminal.py` | `/ws/terminal`：无 `profile_id` 时桥接本机 shell，有 `profile_id` 时用 paramiko `invoke_shell()` 提供真 PTY；支持 resize 与诊断帧。 |
| **Trajectories（旧版）** | `omicslab/trajectories.py` | 1.1 的回合轨迹（JSONL，meta / event / done）。1.2.0 起新运行只写 SQLite，旧文件保留只读兼容，`/api/trajectories/*` 仍可查。 |

### 2.2 1.2.0 新增子系统

- **运行与事件（runtime）**：`POST /api/chat` 不再直接驱动 AgentLoop，而是 `RunService.submit` 建 run；
  事件先由 `EventStore.append` 写 SQLite（`seq` 自增、`event_id` 幂等），再广播给订阅者。
  SSE 断线用 `GET /api/runs/{run_id}/stream?after_seq=N` 重放；15 秒无事件发 `heartbeat`。
  进程启动时 `recover()` 把仍处于活跃状态的 run 对账为 `interrupted`（带 `meta.recovered=true` 与
  `run_status` 事件），不猜测结果。
- **工作区（workspace）**：工作区 = 本地目录或 SSH 主机根目录；每个工作区有独立内核作用域
  （`main` / `ws:<id>` / 子任务 `task:<task_id>`），`KernelPool` 懒启动并按上限回收。
  会话通过 `meta.workspace_id` 绑定工作区，一个会话只属于一个工作区；默认 `ws_main` 指向启动目录，不可删除。
- **执行后端（execution）**：`ExecutionBackend` 抽象（`start/close/interrupt/status/execute_python/
  list_vars/var_detail/shell/list_dir/read_text/write_text/make_dir/delete_path/save_upload/read_bytes`）。
  `LocalExecutionBackend` 包本机内核与文件服务；`SSHExecutionBackend` 用 SFTP 传文件、用远端常驻
  worker（仅 stdio 的 JSON-lines 协议）执行 Python，工作目录限制在远端 `root` 内。
  远端不可用时抛 `BackendUnavailable`（映射为可读错误），**禁止回退本地执行**。
- **连接服务（ssh/connections.py）**：REST、工具、终端 WebSocket、SSH 执行后端共用进程内单例
  `ConnectionService`，复用 `SSHManager` 连接池与内存凭据；`test_profile` 支持未保存档案试连；
  `probe` 返回主机/路径/凭据状态；`diagnostics` 汇总连接池、凭据后端与最近命令。
- **审批归属**：审批请求携带 `run_id` / `task_id` / `target`（kind/root/cwd/connection_id）；
  运行取消时 `cancel_for_run` 撤销该 run 的待审批；`PUT /api/settings` 不再重建 `Approver`，改为
  `set_policy` 原地更新，避免在途审批丢失。

### 2.3 二期子系统（1.1.0）

- **视觉**：`loop` 只把图片附件登记为工作区路径；需要读图时由模型调用 `analyze_image`，
  后者解析路径 → 校验大小（≤12MB）→ 调 `VisionClient.describe` → 返回文本。
  设置页用两个独立端点保存/回测视觉配置，Key 存 `auth.json` 的 `VISION_API_KEY`。
- **RSI 发现**：每个项目一个目录的账本（见 §4.1）；`DiscoveryEngine.run()` 按
  「观察 → 假设 → 优先级（UCB1 选策略）→ 预注册 → 真实内核执行 → 评估/证据分级 →
  反思/策略进化」循环，每步 emit `discovery` 事件；REST `run` 把事件桥接成 SSE，
  同一项目用 `running` 表加锁（并发 409）。LLM 不可用时降级为启发式模式。
  1.2.0 起统计结论必须经 `discovery_record_analysis_result` 提交结构化数值，
  `EvidenceEvaluator` 只根据「执行完成 + 数值合法 + 预注册判据」给出 supported/refuted/inconclusive；
  文本叙述里的「显著 / 不显著」不参与判决。
- **函数注册表**：索引在**独立子进程**（内核解释器）中生成，避免把 scanpy/torch
  等重依赖 import 进服务进程；服务只读 `home/registry/index.json`。
- **SSH 工具面**：同步 paramiko 实现，路由与工具层统一 `asyncio.to_thread` 包装；
  密码默认不落盘，API 永不回传密码/私钥。
- **旧版轨迹**：`AgentLoop.run` 仍可写 `TrajectoryRecorder`（JSONL），供旧入口与回放使用；
  1.2.0 的主链路事件以 SQLite 为准。

## 3. 请求生命周期：一次对话

```text
User
 │  POST /api/chat  {conversation_id?, message, agent, workspace_id?, provider?, model?,
 │                   attachments?, client_request_id?}
 ▼
Server
 │ 1. RunService.submit：
 │      · client_request_id 命中 → 直接返回已有 run（idempotent=true）
 │      · 取/建会话；检查会话是否已有活跃 run（有 → 409 run_in_progress）
 │      · 解析工作区（显式 workspace_id / 会话绑定 / 默认 ws_main）
 │      · create_run(status=preparing) → 写 SQLite → 发 run_status 事件
 │ 2. 返回 200 + text/event-stream，立即发 "connected"（含 run_id / trace_id）
 ▼
AgentLoop (asyncio task，绑定 run)
 │  for iteration in range(max_iterations):
 │    ├─ 取 steering 追加消息（POST /api/runs/{id}/messages）
 │    ├─ provider.stream(messages, tools) ──► "text" / "reasoning" / "tool_call"
 │    ├─ 无工具调用 ──► 收尾
 │    └─ 每个工具调用：
 │         ├─ 需要审批？──► "approval_request"（写 approvals 表）──► 等待 decision（超时=拒绝）
 │         ├─ ToolRegistry.execute(ctx, name, args)
 │         │     ctx 携带 backend / workspace / run_id / agent_task_id
 │         │     ├─ run_python_code ──► ExecutionBackend.execute_python
 │         │     ├─ run_shell       ──► ExecutionBackend.shell
 │         │     ├─ files_*         ──► ExecutionBackend 文件方法（工作区沙箱）
 │         │     ├─ skill_* / memory_* / agent_* ──► 存储层
 │         │     ├─ delegate_agent  ──► RunService.submit_child（子 run + agent_task）
 │         │     ├─ discovery_* ──► ProjectStore / DiscoveryEngine
 │         │     ├─ registry_lookup ──► RegistryIndex
 │         │     ├─ analyze_image ──► VisionClient
 │         │     ├─ ssh_* ──► ConnectionService（exec/upload 需审批）
 │         │     └─ jobs_*          ──► JobManager
 │         ├─ emit "tool_result"（每个事件先写 events 表，再广播）
 │         └─ 结果写回 messages，继续下一轮
 │  emit "usage"（若有）→ 写终态 run + "done" 事件
 ▼
Server ──► SSE 流关闭；会话更新时间刷新
```

断线重连：前端记住最后收到的 `seq`，用 `GET /api/runs/{run_id}/stream?after_seq=seq` 续传；
服务端先回放 `events` 表中缺失事件（上限 5000 条，超出时发 `stream_gap` 提示从 `next_seq` 重新拉时间线），
之后继续实时推送并每 15 秒发一次 `heartbeat`。事件类型与字段见 [API.md](API.md) 的 §2-§3、§16。
前端对未知 `type` 必须忽略而不是报错（向前兼容）。

### 3.1 上下文预算

- 系统提示 + 指令 + 技能目录 + 记忆索引有硬上限（技能目录默认 6000 字符，记忆索引默认 3000 字符）。
- 工具结果回填前按 `llm_content(max_chars≈24000)` 做头尾截断，中间标注被省略的字符数。
- 历史消息按从新到旧的顺序保留，超预算时优先丢弃最旧的工具输出。

### 3.2 为什么共享内核（以及为什么要多个内核）

Jupyter 内核是一个**有状态的 Python 进程**。同一工作区复用同一个内核，因此：

- 第一轮 `adata = sc.read_h5ad(...)`，第二轮可以直接 `sc.pp.normalize_total(adata)`；
- 变量浏览器读取的是**同一个命名空间**，看到的就是真实对象；
- 图表捕获通过 kernel 的 matplotlib 钩子完成，不依赖模型「记得」保存图片。

1.2.0 起内核按**工作区作用域**隔离：不同项目（不同工作区）各自一个内核，`adata` 不会互相覆盖；
子智能体默认在独立作用域 `task:<task_id>` 中执行，避免污染主对话的变量。
`KernelPool` 懒启动、受 `max_workspace_scopes` 限制，空闲内核可被回收。

## 4. 数据落盘位置

### 4.1 应用主目录（`OMICSLAB_HOME`，默认 `~/.omicslab`）

| 路径 | 内容 | 写入方 |
|---|---|---|
| `settings.json` | UI / 运行设置（provider、model、审批策略、并发/子任务/工作区上限、内核 python 等） | `Settings.save()` |
| `auth.json` | API Keys（按环境变量名存放） | `Settings.set_keys()` |
| `workspaces.json` | 工作区注册表（`version: 1`，含默认 `ws_main`） | `WorkspaceService` |
| `runtime/events.db` | 运行、事件、子任务、审批（SQLite，WAL，schema v3） | `EventStore` |
| `conversations/<id>.json` | 会话与消息（原子写：`*.tmp` → `replace`） | `ConversationStore` |
| `trajectories/<cid>/<turn_id>.jsonl` | **旧版**每回合轨迹（meta / event / done，只读兼容） | AgentLoop（`TrajectoryRecorder`） |
| `discovery/<project_id>/` | RSI 项目账本：`project.json`、`hypotheses.jsonl`、`evidence.jsonl`、`insights.jsonl`、`rounds.jsonl`、`strategies.json`、`report.md` | `ProjectStore` |
| `registry/index.json` | 函数索引（子进程内省生成，原子写） | `RegistryIndex` |
| `ssh.json` | SSH 连接档案（默认不含明文密码） | `ConnectionService` / `SSHManager` |
| `ssh_known_hosts.json` | SSH 主机指纹 | `SSHManager` |
| `tmp/` | 上传/下载临时文件（SSH、索引子进程输出），请求结束清理 | Server / `ConnectionService` |
| `figures/` | 图表 PNG（`/api/figures/<name>` 提供） | KernelService |
| `jobs/<id>.log` | 后台任务日志（增量读 offset） | JobManager |
| `memory/<slug>.md` | 记忆条目（Human-readable Markdown） | MemoryStore |
| `logs/server.log` | 服务日志 | Server |
| `kernels/` | Jupyter 连接文件（临时） | KernelService |
| `uploads/` | 上传暂存 | Server |

### 4.2 工作区（`--workspace`，默认启动目录）

用户的数据、脚本、分析产物、自定义 `skills/` 与 `agents/` 目录都在这里。**所有文件读写工具只允许访问工作区内部**（见 §6.1）。
默认工作区在启动时注册为 `ws_main`；用户可新建更多本地或 SSH 工作区（`workspaces.json`），
每个工作区有自己的根目录与内核作用域。

### 4.3 写入原则

- **先落盘再广播**：运行事件先写 `runtime/events.db`（追加式、`event_id` 幂等），再推给 SSE 订阅者；
  进程崩溃时最多丢最后一条未落盘事件，不会出现「前端看到了、库里没有」。
- **原子写**：JSON 配置与会话先写 `*.tmp` 再 `Path.replace()`，进程崩溃不会留下半个文件。
- **人可读**：会话是 JSON，记忆是 Markdown，图表是 PNG，运行库是标准 SQLite（`sqlite3` 可直接查）。
- **可迁移**：备份 `~/.omicslab` + 工作区即可完整搬家；密钥单独在 `auth.json`，便于排除。
- **追加式账本**：发现项目的 `hypotheses.jsonl` / `evidence.jsonl` / `insights.jsonl` /
  `rounds.jsonl` 只追加不重写（保留修订历史），`project.json` 与 `strategies.json` 原子重写，
  `report.md` 在每次运行结束时重写。
- **降级不阻断**：SQLite 写入异常时 EventStore 退化为内存事件（`seq=-1`），对话继续，只是该次运行不可重放。

## 5. 并发与取消

### 5.1 并发模型

| 场景 | 策略 |
|---|---|
| 多个会话同时对话 | 每个 run 一个 `asyncio.Task`，互不阻塞；受 `max_parallel_runs`（默认 8）限制 |
| 同一会话重复提交 | 会话级活跃 run 检查 + `client_request_id` 唯一索引；冲突返回 409 `run_in_progress` |
| 子智能体 | 每父运行 `max_child_tasks`（默认 4）、嵌套深度 `max_child_depth`（默认 2）；独立 trace 与内核作用域 |
| 内核执行 | 内核是单线程语义，`KernelService` 用锁串行化 `execute`；按作用域各自一把锁 |
| 工作区内核数量 | `max_workspace_scopes`（默认 4）限制同时存在的作用域内核 |
| 后台任务 | 独立子进程，不占内核；数量受 `JobManager` 管理 |
| 发现项目运行 | 单项目一个 `asyncio.Task` + `running` 表锁；同一项目并发 run 返回 409 |
| SSH 操作 | 同步 paramiko 调用统一 `asyncio.to_thread`；连接池由 `ConnectionService` 共享 |
| 函数索引构建 | 子进程内省 + 300s 超时（`asyncio.to_thread` + `wait_for`），不阻塞对话 |
| 运行库写入 | 单写连接 + WAL；事件批量追加（`append_events_bulk` 事务），失败降级内存 |
| 文件写入 | 单文件级原子替换；不做跨文件事务 |

### 5.2 取消的完整链路

```text
POST /api/runs/{run_id}/cancel（或 /api/chat/stop）
  → Server 找到 run handle
  → status=stopping + run_status 事件（先写库）
  → ctx.cancel_event.set()；Approver.cancel_for_run(run_id) 撤销该 run 的待审批
  → AgentLoop 在下一个安全点检查：
       · 等待模型流时：取消流式读取
       · 等待审批时：视为拒绝
       · 执行工具时：把取消信号传给工具
  → run_python_code 调用对应作用域内核的 interrupt()（Jupyter 中断消息），
     使内核里的长计算立即返回 KeyboardInterrupt
  → 级联：取消该 run 的所有子运行与子任务（父 trace 记录 child_run 状态）
  → 15 秒宽限内退出 → cancelled；超时 → interrupted（error.code=cancel_timeout）
```

**设计要点：**

- 取消是**协作式**的：工具实现需要周期性检查 `ctx.cancel_event`；内核执行依靠中断消息，不 kill 内核进程。
- 取消**只影响本 run 及子树**：同会话其它已完成的运行、其它工作区内核不受影响。
- 取消后会话保持可继续：已产生的消息与运行结果照常保存，内核变量仍可用。
- 服务关停时：`RunService.shutdown()` 先把未完成 run 置 `interrupted`（不是 `cancelled`），
  再 `Approver.cancel_all()`、`JobManager.shutdown()`，最后逐个关闭内核并关闭 EventStore。

### 5.3 超时

- 单次模型请求：`settings.request_timeout_s`（默认 180s）。
- 内核执行：`settings.kernel_timeout_s`（默认 180s），超时后中断该次执行。
- Shell 工具：`settings.shell_timeout_s`（默认 120s），超时 kill 子进程组。
- 审批等待：`Approver(timeout_s=120)`，超时按拒绝处理。
- 取消宽限：15s（超时后标记 `interrupted`）。
- 子任务预算：`budget` 的迭代 / 时间 / token 上限，耗尽置 `failed` + `budget_exhausted`。
- SSH：远端 worker 请求超时 900s；`ssh_exec` 默认 120s、最大 3600s。

## 6. 安全边界

> 威胁模型：本机单用户。OmicsLab **不是**多租户系统，不面向公网暴露。若在共享机器上使用，请自行加强 OS 层隔离。

### 6.1 路径沙箱

- 所有文件 API 与文件工具都接收**工作区相对路径**。
- 服务端拼接后 `Path.resolve()`，并校验结果仍在工作区内；`..` 逃逸、绝对路径越界、符号链接指向工作区外一律拒绝。
- 默认 `settings.sandbox_root_only = true`（见 `config.py`）。
- 上传文件按服务端生成的名字落盘，不使用客户端文件名拼接路径。
- SSH 工作区的文件操作在远端 `root` 内解析相对路径，越界报「路径超出 SSH 工作区范围」。

### 6.2 审批策略

| 策略 | 行为 |
|---|---|
| `auto`（默认） | 所有工具直接执行，适合个人可信环境 |
| `ask` | `requires_approval=True` 的工具（`run_shell`、`write_file`、`ssh_exec`、`ssh_upload` 等）先发 `approval_request`，用户在 UI 点「允许 / 拒绝」；超时 = 拒绝 |

- 被拒绝的工具调用会以失败结果回填给模型，模型会得到明确原因并继续。
- `allow_shell` / `allow_file_write` 可单独关闭某类能力。
- 1.2.0 起审批记录持久化到 `runtime/events.db` 的 `approvals` 表，绑定 `run_id` / `task_id`；
  审批中心可按运行过滤，运行取消时自动撤销其待审批。
- 内核代码执行（`run_python_code`）不逐条审批：它和 Jupyter 一样等价于本机代码执行，**只在可信数据上使用**。

### 6.3 密钥存储

- API Key 只存在 `~/.omicslab/auth.json`，或由进程环境变量注入。
- `/api/settings` 只返回 `has_key: true/false`，**永不回传明文 Key**。
- Key 不写日志、不进入 SSE、不写进会话文件、不写进运行库；错误信息做脱敏。
- 仓库 `.gitignore` 明确排除 `auth.json`、`settings.json`、`.omicslab/`。
- 视觉模型 Key 单独存为 `VISION_API_KEY`，与对话模型 Key 隔离。
- SSH 密码默认不落盘，只在进程内存使用；勾选「记住密码」时交给系统凭据库（`keyring`），
  系统无凭据库时退化为仅内存并在界面明示。API 永不回传密码与私钥内容，只返回 `has_password_saved`。
  持久凭据以 `credential_id` 引用，`ssh.json` 不存明文。

### 6.4 其他

- 服务默认绑定 `127.0.0.1`：改动 `host` 前请确认你知道风险（没有内置登录）。
- SPA 无 CDN 依赖，CSP 友好，离线环境不会静默外联。
- 终端 WebSocket（`/ws/terminal`）等价于本机 shell；带 `profile_id` 时是远端 PTY，同样只在可信环境开放。
- 日志默认只记录元数据与错误，不记录完整对话内容。
- `GET /api/runtime/diagnostics` 只导出 IDs、版本、后端状态与最近错误，不含工作区文件内容。

### 6.5 1.2.0 新增面

- **运行库**：`runtime/events.db` 含会话/运行的元数据与工具参数摘要；属于敏感文件，按会话数据同等对待。
- **工作区**：非本地工作区的文件端点直接拒绝（`workspace_not_local`）；SSH 执行在远端 `root` 内。
- **SSH 执行后端**：远端 worker 只通过 stdio JSON-lines 通信；`BackendUnavailable` 时**不回退本地**，
  避免「以为在远端、其实在本机」的数据泄露与结果错配。
- **子任务**：子运行继承父工作区，但使用独立内核作用域；子任务审批按 `task_id` 归属，父 run 取消级联撤销。
- **设置**：`/api/settings*` 永不 500；响应只含 `has_key` 等布尔值，明文密钥不出现在
  响应、日志、会话与运行库中。

## 7. 错误处理与降级

| 故障 | 行为 |
|---|---|
| 单个 skill / agent 文件 frontmatter 非法 | 跳过并记 warning，不阻断服务启动 |
| LLM 返回 4xx/5xx | run 终态 `failed`，`error.code=llm_error`，会话可重试 |
| 工具内部异常 | 归一化为 `ToolResult(ok=false, error=...)` 回填给模型，不冒泡到服务器 |
| SSE 客户端断开 | 只关闭该订阅者，**不取消 run**；重连按 `after_seq` 重放 |
| 运行库写入失败 | 降级为内存事件（`seq=-1`），本次运行不可重放但对话继续 |
| 进程崩溃 / 重启 | 启动时把活跃 run 对账为 `interrupted`（`meta.recovered=true`），不伪装成功 |
| 内核崩溃 | 标记状态为未运行；下一次执行前自动重启（变量丢失，UI 提示） |
| 后台任务失败 | 记录 exit code 与日志尾部，状态置 `failed` |
| 设置解析失败（缺 Key / 缺 base） | `GET /api/settings` 仍返回 200，`llm.configured=false` + `llm.error`；`/api/health` 同步暴露 |
| 发现项目运行失败 | 项目状态置 `failed`、`error` 写入账本，最终仍生成报告；可重新 run |
| 证据数值不完整 | `EvidenceEvaluator` 判 `inconclusive`（不会因文字描述而提升为 supported） |
| SSH 连接/远端操作失败 | 归一化为 `SSHError`，REST 映射 502 `ssh_error`（档案不存在 404、参数非法 400） |
| SSH 执行后端不可用 | 抛 `BackendUnavailable`，工具返回可读错误；**不回退本地** |
| 函数索引未构建/构建失败 | `search` 返回 `ready=false` 与空 items；refresh 失败返回 500/504 并提示解释器/包名问题 |
| 旧轨迹写入失败 | 只记 warning，不影响对话主流程 |

## 8. 测试策略

- `tests/test_tools.py`：工具注册表、文件/内核/记忆/任务工具、审批与错误归一化。
- `tests/test_session.py`：会话存储、JobManager、REST 路由与 SSE 行为。
- `tests/test_skills.py`：内置技能与智能体 frontmatter 校验（二期技能/agent 同步覆盖）。
- `tests/test_cli.py`：CLI 参数、`--help` 与退出码冒烟。
- `tests/test_discovery.py`：发现引擎 7 步闭环、账本落盘、REST/SSE 与降级路径。
- `tests/test_evidence.py`：结构化分析结果校验、`EvidenceEvaluator` 判决与阈值边界（文本不提升证据）。
- `tests/test_registry.py`：函数索引构建/搜索/模块/refresh 与工具。
- `tests/test_vision.py`：视觉客户端双协议、图片校验、`analyze_image` 工具与设置端点。
- `tests/test_trajectories.py`：旧版轨迹写入、列表、回放、删除与非法 id。
- `tests/test_runtime.py`：RunService 生命周期、幂等、409 冲突、事件重放、取消、子任务、崩溃对账。
- `tests/test_terminal.py`：`/ws/terminal` 本地 shell 会话、输入/输出/缩放/退出与协议帧。
- `tests/test_execution_ssh.py`：SSH 执行后端的路径解析、远端不可用错误、工作区隔离（伪连接，不依赖真实主机）。
- `tests/test_ssh.py`：SSH 档案 CRUD/密码脱敏/指纹警告/REST 错误码（伪连接，不依赖真实主机）。
- `tests/test_runtime_compat.py`：Windows selector 事件循环下的 shell / 后台任务回归（不得依赖 Proactor 子进程支持）。
- `scripts/smoke.py`：真实启动服务（mock provider）的端到端自检：对话/内核/图表/文件 API。
- 全部测试**不依赖网络**：LLM 使用 `mock` provider；SSH/视觉/发现均用伪连接或启发式路径。
- **未覆盖**：真实 SSH 远端主机的端到端行为（网络、认证、PTY、远端 worker）与真实模型调用不在自动化测试范围内。

---

本文件对应 Suwen 2.0.0；正文中的“1.2.0 起”表示该能力首次引入的版本。
