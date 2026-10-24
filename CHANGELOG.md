# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。

## [2.1.0] — 2026-10-24

- 可选 Sage-A1.5 自检请求与结构化并行子任务；继承父任务权限，隔离会话上下文，限制批次、并发与时长。
- 工作流新增独立指标验证节点：读取实际文件，验证失败阻止依赖步骤；支持 JSON 模板校验导入和脱敏导出。
- 新增实验比较：保留指标文件摘要，按同数据集、同协议与同指标排序，始终保留未完成科学复核状态。
- 增加子任务权限继承与取消边界检查，更新中英文文档并保留现有品牌与文档布局。

## [2.0.0] — 2026-10-23

- 正式展示名升级为素问 Suwen，保留 Python 包、旧 API 和旧数据目录。
- 新增模块化 Model Gateway、知识/记忆、MCP、Skills、渠道、持久任务、DAG 与间隔调度。
- 生物工具支持 Europe PMC、UniProt、DNA QC；结论来源与实际数值检查贯穿执行轨迹，未复核结论进入 needs_review。
- 增加配置版本/回滚、DPAPI 凭据、产物快照、诊断与可选 Docker 隔离工具。
- 重做多级设置与各能力页面、工作区布局及明暗主题；修复页面切换后的重复事件绑定。
- 具体能力与尚未实现的子项以 docs/SUWEN-V2-CHECKLIST.md 为准，不宣称完整集成上游科研系统。

## [1.3.0] — 2026-10-23

- SSH 档案可直接绑定远程目录作为工作区；文件、变量、控制台与标准 Agent 工具按当前工作区路由。
- 工作台默认入口，统一 Studio 设计变量、明暗主题与 SSH 工作区向导。

## [1.2.0] — 2026-10-23

三期版本：把「一次对话」升级为**可恢复的运行**，并让同一套工具既能跑本机、也能跑远端 SSH 工作区。
本版本的核心变化是运行层（run / 事件 / 审批 / 子任务）与执行层（工作区 / 执行后端）的重构，
既有 HTTP/SSE 入口与旧轨迹数据保持兼容。

### 新增

- **持久运行与恢复**：
  - 新增 `omicslab/runtime/events.py`（SQLite，WAL，schema v3）与 `omicslab/runtime/runs.py`（`RunService`）。
    每回合是一个有 `run_id` / `trace_id` 的 run，事件**先落库再广播**；表 `runs` / `events` /
    `agent_tasks` / `approvals`，`events.seq` 自增、`event_id` 唯一。
  - `GET /api/runs/{run_id}/stream?after_seq=N` 断线重放（上限 5000 条，超出提示 `stream_gap`），
    空闲 15 秒发 `heartbeat`；`GET /api/traces/{trace_id}/events` 可回放完整时间线。
  - `client_request_id` 幂等：网络重试不会产生第二个 run；同会话已活跃时返回 409
    `run_in_progress`（带 `run_id`）。进程崩溃/重启后，进行中的 run 对账为 `interrupted`
    （`meta.recovered=true`），不伪装成成功。
  - 新增 `POST /api/sessions/{session_id}/runs`（建 run 但不开 SSE）、`POST /api/runs/{id}/cancel`、
    `POST /api/runs/{id}/messages`（steering，运行中追加用户指示）、`GET /api/sessions/{id}/runs`。
  - `GET /api/runtime/timeline|runs|agent-tasks|diagnostics|config`、`GET /api/agents/default`；
    `PUT /api/runtime/config` 可在线调整并发与子任务上限、审批策略与默认智能体。
- **工作区与内核作用域**：
  - `omicslab/workspace/service.py`：工作区注册表 `home/workspaces.json`（`version: 1`），
    默认 `ws_main`（指向启动工作区，不可删除）；支持本地目录与 SSH 工作区；会话通过
    `meta.workspace_id` 绑定，一个会话只属于一个工作区。
  - `KernelPool`：按作用域（`main` / `ws:<id>` / 子任务 `task:<task_id>`）懒启动内核，
    受 `max_workspace_scopes` 限制；新增 `GET /api/kernels` 与 `/api/kernels/{scope}/start|restart|stop|execute|vars`；
    旧 `/api/kernel/*` 保留并等价于 `main`。
  - 新端点：`GET/POST /api/workspaces`、`GET/DELETE /api/workspaces/{id}`、
    `POST /api/workspaces/{id}/probe`，以及限定在工作区内的
    文件端点 `/api/workspaces/{id}/files/*`（非本地工作区直接拒绝）。
- **统一执行后端**：
  - `omicslab/execution/base.py` 定义 `ExecutionBackend`（内核执行、Shell、文件、上传、变量内省、后台作业）；
    `local.py` 包本机实现；`ssh_backend.py` 用 SFTP + 远端常驻 worker（仅 stdio 的 JSON-lines 协议）执行 Python，
    路径限制在远端 `root` 内。远端不可用时抛 `BackendUnavailable`，**不回退本地**。
  - 工具输出统一携带 `data.execution_target`（`kind` / `root` / `cwd` / `connection_id`），UI 与模型都能看到
    「这条结果来自哪个执行目标」。
- **子智能体与委派**：
  - `delegate_agent` 改为创建**子 run + agent_task**，独立 `trace_id` 与内核作用域，结果结构化返回；
    新增 `GET /api/runs/{run_id}/children`、`GET /api/agent-tasks/{task_id}`、`/agent-tasks/{task_id}/runs`。
  - 并发上限 `max_parallel_runs`（默认 8）、`max_child_tasks`（默认 4）、`max_child_depth`（默认 2）；
    子任务有预算（迭代/时间/token）与结果契约，耗尽标记 `budget_exhausted`；父 run 取消级联取消子树。
- **审批中心**：审批记录持久化到 `approvals` 表，携带 `run_id` / `task_id` / `target`（kind/root/cwd/connection_id）
  与 `expires_at`；新增 `GET /api/approvals?run_id=&status=`、`GET /api/approvals/{id}`、
  `POST /api/approvals/{id}`；新增 `approval_resolved` / `child_run` / `run_status` / `user_message` /
  `heartbeat` / `stream_gap` / `stream_end` SSE 事件。
- **SSH 连接服务与远端执行**：
  - `omicslab/ssh/connections.py` 提供进程内单例 `ConnectionService`：REST、工具、终端与 SSH 执行后端
    共享连接池与凭据；新增 `POST /api/ssh/test`（未保存档案试连）、
    `POST /api/ssh/profiles/{id}/remember`、`GET /api/ssh/diagnostics`；
    `POST /api/ssh/exec` 支持 `cwd` / `timeout_s` / `idempotent`。
  - `omicslab/ssh/credentials.py`：密码默认只在进程内存；「记住密码」交给系统凭据库（keyring），
    无凭据库时退化为仅内存并在界面与 `diagnostics` 明示；`ssh.json` 不存明文密码。
  - 终端 `/ws/terminal` 支持 `profile_id`：用 paramiko `invoke_shell()` 提供远端真 PTY，
    支持 `resize`、Ctrl+C 与诊断帧。
- **证据判定（RSI 硬化）**：新增 `omicslab/discovery/evidence.py` 的 `AnalysisResult` 与
  `EvidenceEvaluator`——统计结论必须经 `discovery_record_analysis_result` 提交结构化数值
  （`data_sha256` / `script_sha256` / 检验方法 / 效应量 / CI / p 与 q 值等），
  只有「执行完成 + 数值合法 + 符合预注册判据」才给出 `supported` / `refuted`，否则 `inconclusive`；
  `evidence.reproducibility` 改为 `none` / `code_recorded` / `rerun_verified` 三级（保留 `reproducible` 布尔兼容视图）。
- **诊断与健康**：`/api/health` 增加 `kernels` / `workspaces_count` / `runs{active,recovered}` /
  `runtime{schema_version,db}`；新增 `GET /api/runtime/diagnostics`（版本、PID、内核、工作区后端、
  最近恢复的 run、日志尾部，脱敏）。
- **前端**（12 个页面）：新增「工作台」页（运行状态条、工作区切换、Results/Files/Variables、
  底部 Compute 面板）；对话页支持断线重连接续传与运行时间线；新增全局审批中心与任务树；
  设置页增加并发/子任务/工作区上限；SSH 页支持临时密码、记住密码、终端与诊断。

### 变更

- `POST /api/chat` 的内部实现改为 `RunService.submit`：首帧 `connected` 现在包含 `run_id` / `trace_id` /
  `workspace` / `idempotent`；`/api/chat/stop` 与 `/api/runs/{id}/cancel` 语义统一
  （先 `stopping`，15 秒内未退出则 `interrupted`）。
- `PUT /api/settings` 不再重建 `Approver` 实例，改为原地 `set_policy`，切换审批策略不会丢失在途审批；
  设置新增 `max_parallel_runs` / `max_child_tasks` / `max_child_depth` / `max_workspace_scopes` 及范围校验。
- 错误响应统一为信封 `{"error": {"message", "code", "detail"}}`；新增错误码
  `run_in_progress` / `run_not_found` / `run_finished` / `workspace_invalid` / `workspace_not_found` /
  `workspace_not_local` / `workspace_delete_refused` / `approval_not_found` / `task_not_found` /
  `invalid_scope` / `invalid_patch` / `invalid_config` / `backend_unavailable` / `remote_unavailable`。
- `GET /api/settings` 的 `providers` 保持 map 结构；`llm` / `vision` 永不 500 的行为延续。
- `/api/trajectories/*` 与 `home/trajectories/**` 保留为**旧版**轨迹：1.2.0 起新运行只写 SQLite，
  旧文件只读兼容；`/api/traces/{trace_id}/events` 提供新的回放入口。
- CLI 版本输出改为 `OmicsLab 1.2.0`。

### 修复

- **SSE 断线后事件丢失/顺序错乱**：改为按 `after_seq` 从事件库重放，前端只追加未见过的 `seq`，
  刷新页面后可恢复到当前运行的真实状态。
- **双击发送产生两个并行运行**：`client_request_id` 唯一索引 + 会话级活跃检查，
  重复请求返回同一个 run（`idempotent=true`）或 409 `run_in_progress`。
- **切换设置页丢审批**：审批器实例不再重建；已发出的 `approval_request` 仍可通过审批中心解决，
  运行取消时自动撤销（`cancel_for_run`）。
- **停止一个会话误伤全局**：取消只作用于本 run + 子树 + 对应工作区内核作用域，
  不再中断其它工作区/其它会话的运行与内核。
- **文本叙述提升证据等级**：发现引擎只把 `discovery_record_analysis_result` 提交的结构化结果
  交给 `EvidenceEvaluator`；报告里的「显著 / 不显著 / p=…」文字不参与判定。
- **SSH 执行失败被悄悄落到本地**：远端不可用统一抛 `BackendUnavailable` 并给出可操作错误，
  绝不回退本地执行，避免结果错配与数据外泄。

### 工程

- 新增 14 个测试文件覆盖 runtime / evidence / terminal / execution_ssh 等新面；`pytest -q` 全绿（357 项）。
- 测试全部离线：LLM 用 `mock` provider；SSH / 远端执行 / 视觉用伪连接与启发式路径；
  **真实 SSH 远端与真实模型调用不在自动化测试范围内**（文档中已标注）。
- 新增 `docs/API.md` §16（运行与恢复）与 §17（工作区与执行后端）、
  `docs/CONTRACTS-3.md`（1.2.0 接口契约）；README / ARCHITECTURE / EXTENDING / COMPARISON / INSTALL 同步到 1.2.0。

### 安全边界

- 运行库 `runtime/events.db` 含会话/运行元数据与工具参数摘要，按会话数据同等保护。
- 非本地工作区的文件端点直接拒绝（`workspace_not_local`）；SSH 工作区的相对路径解析限制在远端 `root` 内。
- SSH 密码默认不落盘；API 永不回传密码/私钥，只返回 `has_password_saved`；
  `diagnostics` 只含连接池计数、凭据后端与最近命令，不含明文。
- 所有设置类端点只返回 `has_key` 布尔值，密钥不进入日志、SSE、会话或运行库。

## [1.1.0] — 2026-10-23

二期版本：从「能对话」升级为「能配置、能看图、能自主发现、能连远程算力」。

### 修复（P0）

- **「配置了 API 却无法调用」**。根因有三层：① 设置页旧逻辑只把 Key 写进
  `auth.json`，`provider` / `model` / `api_base` 仍是旧值（甚至停留在 `auto`），
  后端解析不到可用端点便静默回退到 `mock`；② `GET /api/settings` 内部直接
  `resolve_llm()`，缺 Key 时抛异常导致整个设置页 500，用户看不到任何可操作提示；
  ③ 「测试连接」只检查 Key 是否存在，不真正发请求，失败也无从复现。
  现在：`POST /api/settings/keys` 把 Key、provider、model、api_base **一次性原子保存**；
  `GET /api/settings` 永不 500，缺 Key 时返回 `llm.configured=false` + `llm.error`
  可操作建议；`POST /api/settings/test_llm` 真实发起一次极小对话并返回延迟与回复。
  设置页同步重写：provider 下拉来自后端目录、显示 configured 徽标、选择 provider
  自动填充 base/model、保存后立即回测并刷新聊天页模型提示。
- 显式 `api_base` 的 provider 不再被旧地址串用：切换 provider 且未给 model 时
  `model="auto"`，非自定义 provider 且未给 api_base 时清空旧 base。
- 自定义端点错误提示更可操作：识别 `ark-...` 形态的 Key 并提示直接选择
  「火山方舟」，CUSTOM_OPENAI/CUSTOM_ANTHROPIC 缺 API 地址时给出逐项修复指引。

### 新增

- **火山方舟（Volcengine Ark）Provider**：OpenAI 兼容协议，预置
  `https://ark.cn-beijing.volces.com/api/v3`，支持 `ARK_API_KEY` /
  `VOLCENGINE_API_KEY`，`needs_model=true` 时提示填写推理接入点 ID（`ep-...`）或模型名。
- **视觉模型**：`omicslab/agent/vision.py`（OpenAI 兼容 `image_url` 与 Anthropic
  `image` 两种协议，≤12MB，按扩展名映射 MIME）；设置页视觉卡片；`analyze_image`
  工具（工作区相对路径或图库文件名）；`POST /api/settings/vision` 保存、
  `POST /api/settings/test_vision` 用内置 32×32 PNG 真实回测；`/api/health`
  同时报告 `vision.configured`。
- **RSI 科研发现引擎**（`omicslab/discovery/**`）：观察 → 假设 → 优先级（UCB1 策略选择）
  → 预注册检验 → 真实内核执行 → 证据分级/评审 → 反思与策略进化，7 步闭环；
  账本落盘为 JSONL（`project.json` / `hypotheses.jsonl` / `evidence.jsonl` /
  `insights.jsonl` / `rounds.jsonl` / `strategies.json` / `report.md`）；
  `/api/discovery/*` 提供项目 CRUD、SSE 运行流、报告、停止、删除；
  `discovery_*` 6 个工具；CLI `python -m omicslab discovery ...`；
  无真实 LLM 时以启发式模式运行，不崩溃、不造假数据。
- **函数注册表**（`omicslab/registry/**`）：用内核解释器在子进程内省 numpy / pandas /
  scipy / sklearn / statsmodels / matplotlib / seaborn / scanpy / anndata / omicverse /
  lifelines / gseapy / pydeseq2 / flowio / flowkit / rdkit / squidpy / harmonypy /
  biopython / plotly / networkx / umap / leidenalg 的公开函数与类，
  生成可搜索索引（`home/registry/index.json`）；`/api/registry/*` 提供搜索、模块、
  详情、重建索引 4 个端点；`registry_lookup` 工具。
- **轨迹记录**（`omicslab/trajectories.py`）：每个对话回合写
  `home/trajectories/<conversation_id>/<turn_id>.jsonl`（meta + 事件 + done）；
  `/api/trajectories/*` 支持列表、回放、删除；记录失败不影响主流程。
- **SSH 远程算力**（`omicslab/ssh/**`）：paramiko 连接池、档案 CRUD、
  连通性测试（首次记录主机指纹、变化时给中文警告）、命令执行、SFTP 上传/下载、
  目录浏览、远端系统信息；`/api/ssh/*` 10 个端点和 `ssh_*` 5 个工具
  （`ssh_exec` / `ssh_upload` 需审批）；密码默认不落盘，API 永不含密码与私钥内容；
  上传/下载上限 200MB。
- **前端二期**：设置页重写与视觉卡片；新增「发现」「函数库」「SSH」三个页面；
  聊天图片附件（选择/粘贴/拖拽）上传后随消息发送；侧栏导航扩展到 11 项；
  命令面板与路由自动覆盖新页面。
- **内容**：新增 6 个智能体（`discovery-lead`、`hypothesis-smith`、
  `experiment-designer`、`evidence-critic`、`research-strategist`、
  `remote-compute-engineer`）与 8 个技能（`rsi-discovery-loop`、
  `hypothesis-generation`、`experimental-design`、`statistical-rigor`、
  `causal-inference`、`remote-compute-ssh`、`function-registry`、
  `vision-interpretation`）。

### 变更

- `GET /api/settings` 的 `providers` 由数组改为 **以 provider id 为键的 map**，
  单个对象新增 `needs_api_base` / `needs_model` / `hint` 字段；旧前端需同步升级。
- `POST /api/settings/keys` 请求体扩展为 `{key, provider, model, api_base,
  keys, vision_api_key}`，返回新增 `settings` / `llm` / `vision`；
  兼容旧的 `{"DEEPSEEK_API_KEY": "..."}` 扁平写法。
- `POST /api/settings/test_llm` 支持内联传入**尚未保存**的
  `provider` / `model` / `api_base` / `api_key`，返回新增 `provider` / `model`。
- `GET /api/health` 新增 `llm.error` 与 `vision` 字段；`version` 升至 `1.1.0`。
- 工具总数 17 → **30**，新增 toolset：`discovery` / `registry` / `ssh` / `vision`。
- 技能 10 → **18**，智能体 7 → **13**；新增页面 3 个（发现 / 函数库 / SSH）。
- 运行依赖新增 `paramiko>=3.4`（SSH 子系统）；数据目录新增
  `discovery/`、`registry/`、`tmp/`。
- `pyproject.toml`、`omicslab/__init__.py`、服务端版本回退值同步为 `1.1.0`。

### 工程

- 新增测试覆盖设置原子保存与内联测试、视觉客户端与工具、发现引擎与账本、
  函数索引、轨迹、SSH（伪连接）、前端契约字段；全部测试离线运行、使用 mock 模型。
- `scripts/smoke.py` 与发布脚本继续可用；产物名随版本变为 `omicslab-1.1.0*`。

### 安全边界

- 设置页与 API 只回传 `has_key` / `has_password_saved` 布尔值，明文 Key、
  SSH 密码与私钥内容永不出现在响应、日志与会话文件中。
- SSH 档案密码默认不落盘；勾选「记住密码」时以 base64 混淆存储并在 UI 警示
  （不是加密，仅避免明文肩窥）。
- 远程命令执行与上传需按审批策略确认；服务仍只监听 `127.0.0.1`，无内置登录。

## [1.0.0] — 2026-10-22

首个公开版本：本地优先、可扩展的生物医学分析工作台。

### 功能

- **对话式分析**：流式回复、工具调用卡片、图片内联、停止/重发、SSE 断线重连、
  `Ctrl/Cmd+Enter` 发送、`Ctrl/Cmd+K` 命令面板。
- **常驻 Python 内核**：Jupyter 内核复用变量与 import；实时变量表（shape/dtype/head/describe）；
  matplotlib 内联图自动入库；一键导出 `.ipynb`；超时/中断/重启。
- **工作区文件**：目录树、文本/CSV/图片预览、上传（含拖拽）、下载、新建目录、编辑。
- **图表画廊**：自动收集内核产生的图片，缩略图/灯箱/下载/删除。
- **后台任务**：长任务提交、日志增量轮询、取消、退出码。
- **技能库**：10 个内置技能（单细胞上游/下游、空间转录组、流式细胞术、bulk 转录组、
  CADD 化学信息学、GEO 公共数据、绘图风格、报告撰写、Notebook 运维），运行时可查看与调用。
- **智能体**：7 个内置智能体（总控、单细胞、空间、流式、绘图、报告、数据评审），
  `delegate_agent` 支持子任务委派。
- **记忆**：跨会话的 Markdown 记忆条目，可编辑/删除。
- **多模型**：DeepSeek / OpenAI / Anthropic / 通义千问 / 智谱 / Moonshot / Ollama /
  OpenRouter / SiliconFlow / Google / 自定义 OpenAI 兼容端点；无 key 时可用 `mock` 演示。
- **前端零构建**：原生 HTML/CSS/ES Modules，由服务端直接托管，深浅主题、可拖拽分栏、响应式。
- **内置终端（可选）**：WebSocket 桥接本机 shell，无额外 Python 依赖。
- **CLI**：`serve` / `cli` / `env` / `doctor` / `config` / `skills` / `agents`。

### 工程

- Apache-2.0 许可；测试覆盖工具、会话、REST/SSE、技能与 CLI（离线、mock 模型）。
- 发布脚本：`scripts/publish.ps1` / `publish.sh` 生成 sdist + wheel + `SHA256SUMS.txt`；
  `scripts/smoke.py` 端到端冒烟；`scripts/check_dist.py` 校验产物内容。
- `pyproject.toml`：`bio`（scanpy 等）与 `dev`（pytest）可选依赖；纯 Python wheel。

### 安全边界

- 服务默认只监听 `127.0.0.1`，**没有内置登录**，不要暴露到公网或共享网络。
- 文件工具限制在工作区目录内；终端与 `run_shell` 等价于本机 shell，仅在可信环境使用。
# 1.3.0 — SSH workspaces and Studio UI

- Open a saved SSH connection and remote directory as a workspace.
- Route workspace files, Python console, variables, standard agent tools, figures and jobs to SSH.
- Reuse the remote worker across console and agent runs; preserve code history for notebook export.
- Validate remote roots, expand SFTP home paths, reject unknown workspace IDs and protect workspace-root deletion.
- Add a unified Studio theme, styled native controls and visible keyboard focus; move approvals into navigation.
- Add remote workspace integration coverage. See `docs/UPGRADE-1.3.md` for usage and verification limits.

