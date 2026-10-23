# OmicsLab — 并行开发契约（v1）

> **归档文档（历史）**：本文件是 Suwen 1.2→2.0 开发过程的原始记录，仅用于追溯，不是当前用户文档。当前文档入口见 [docs/README.md](../README.md)。

> 所有队友必须只改自己 scope 内的文件；跨 scope 需求通过消息沟通，由 Lead 协调。
> 本文件是**接口唯一事实来源**。实现若需偏离，先通知 Lead。

## 1. 项目定位与边界

**OmicsLab**：开源、本地优先的生物医学分析工作台，独立实现。参考同类产品（如 OmicOS）**公开文档描述的功能面**，但：

- ❌ 不复制、不提取、不反编译任何第三方产品的代码、prompt、skill 内容或资源；
- ❌ 不实现任何订阅/授权校验的绕过；
- ✅ 本产品所有档位功能默认全部开放（开源，无订阅）；
- ✅ 代码、prompt、skill 文本全部自研。

技术栈：Python 3.11 + FastAPI（后端）+ 原生 ES Modules SPA（前端，**无构建步骤**）+ Jupyter kernel（共享 IPython 内核）。

## 2. 目录 ownership

| Scope | 负责人 | 只允许写 |
|---|---|---|
| 核心后端 | Lead | `omicslab/config.py`, `omicslab/kernel/**`, `omicslab/agent/providers/**`, `omicslab/agent/loop.py`, `omicslab/agent/context.py`, `omicslab/server/**`, `omicslab/cli.py`, `omicslab/__main__.py`, `omicslab/__init__.py`, `pyproject.toml`, `tests/test_tools.py`, `tests/test_session.py`, `tests/test_cli.py`, `scripts/smoke.py` |
| 工具与扩展系统 | 队友 `toolsys` | `omicslab/agent/tools.py`, `omicslab/agent/templates.py`, `omicslab/agent/skills.py`, `omicslab/agent/memory.py`, `omicslab/agent/approvals.py`, `omicslab/session/**`, `omicslab/utils.py` |
| 前端 | 队友 `frontend` | `omicslab/web/**` |
| 技能/智能体内容 | 队友 `skillpack` | `omicslab/skills/**`, `omicslab/agents/**`, `omicslab/data/**` |
| 打包/文档/测试 | 队友 `pkgdocs` | `README.md`, `docs/**`, `scripts/**`, `tests/test_skills.py`, `tests/test_cli.py`, `.gitignore`, `LICENSE` |

## 3. 运行方式

```powershell
# 服务（后端 + SPA）
.venv\Scripts\python.exe -m omicslab serve --port 5077 --workspace <dir>
# 终端聊天客户端
.venv\Scripts\python.exe -m omicslab cli
# 体检
.venv\Scripts\python.exe -m omicslab env doctor
```

默认 `OMICSLAB_HOME=%USERPROFILE%\.omicslab`，内含 `settings.json`, `auth.json`, `conversations/`, `figures/`, `jobs/`, `memory/`, `logs/`, `kernels/`。

## 4. SSE 聊天协议

`POST /api/chat` → `text/event-stream`，每个事件一行 `data: <json>\n\n`：

```jsonc
{"type":"connected","data":{"conversation_id":"c_...","message_id":"m_..."},"ts":1.0}
{"type":"status","data":{"text":"正在思考…"}}
{"type":"text","data":{"delta":"增量文本"}}
{"type":"reasoning","data":{"delta":"思维链增量（可空）"}}
{"type":"tool_call","data":{"id":"call_x","name":"run_python_code","arguments":{"code":"..."},"agent":"lead","category":"python"}}
{"type":"tool_result","data":{"id":"call_x","name":"run_python_code","ok":true,"preview":"前 2000 字符","data":{"duration_ms":12},"duration_ms":12}}
{"type":"approval_request","data":{"id":"appr_x","tool":"shell","arguments":{"command":"..."},"reason":"..."}}
{"type":"figure","data":{"name":"fig_ab12.png","url":"/api/figures/fig_ab12.png","title":"UMAP"}}
{"type":"usage","data":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2,"model":"deepseek-chat"}}
{"type":"error","data":{"message":"...","detail":"...","retryable":false}}
{"type":"done","data":{"conversation_id":"c_...","finish_reason":"stop"}}
```

请求体：

```jsonc
{"conversation_id": null, "message": "用户输入", "agent": "lead",
 "provider": null, "model": null,
 "attachments": [{"path":"data/x.h5ad","name":"x.h5ad"}]}
```

取消：`POST /api/chat/stop` `{"conversation_id":"c_..."}`。
审批：`POST /api/approvals/{approval_id}` `{"decision":"approve"|"deny"}`。

## 5. REST API 契约

### 会话
- `GET /api/conversations` → `{"conversations":[summary...]}`
- `POST /api/conversations` `{"agent":"lead","title":"..."}` → `Conversation`
- `GET /api/conversations/{id}` → `Conversation`（含 messages）
- `PATCH /api/conversations/{id}` `{"title":"..."}` → `Conversation`
- `DELETE /api/conversations/{id}` → `{"ok":true}`

`Conversation` = `{id,title,agent,created_at,updated_at,message_count?,messages?}`；
`Message` = `{id,role,content,ts,tool_calls?,tool_call_id?,name?,figures?,meta?}`，
`role ∈ user|assistant|system|tool|error`。

### 内核
- `GET /api/kernel/status` → `{"running":true,"python":"...","pid":123,"started_at":1.0,"kernel_name":"omicslab"}`
- `POST /api/kernel/execute` `{"code":"...","timeout_s":120}` → `{"ok":true,"outputs":[{"type":"stream","name":"stdout","text":"..."},{"type":"result","text":"..."},{"type":"image","url":"/api/figures/x.png"}],"figures":[...],"duration_ms":12,"error":null}`
- `POST /api/kernel/restart` → status
- `POST /api/kernel/interrupt` → `{"ok":true}`
- `GET /api/kernel/vars` → `{"vars":[{"name":"adata","type":"AnnData","repr":"...","shape":[1000,2000],"size_bytes":123,"is_dataframe":false,"is_anndata":true}],"running":true}`
- `GET /api/kernel/var_detail?name=adata` → `{"name":"adata","type":"...","repr":"...","shape":[...],"columns":[...],"dtypes":{...},"head":[{"col":1}],"describe":[...],"error":null}`

### 文件（工作区相对路径，禁止越出工作区）
- `GET /api/files/tree?path=.` → `{"path":".","entries":[{"name":"a.h5ad","path":"a.h5ad","is_dir":false,"size":1,"mtime":1.0,"ext":".h5ad"}]}`
- `GET /api/files/read?path=x.py&max_bytes=200000` → `{"path":"x.py","text":"...","truncated":false,"binary":false,"mime":"text/plain","size":1}`
- `GET /api/files/raw?path=x.png` → 二进制响应
- `POST /api/files/upload` multipart `file`, 表单字段 `dir` → `{"path":"...","size":1}`
- `POST /api/files/write` `{"path":"a.py","content":"..."}` → `{"ok":true,"path":"..."}`
- `POST /api/files/mkdir` `{"path":"newdir"}` → `{"ok":true}`
- `DELETE /api/files?path=a.py` → `{"ok":true}`

### 智能体 / 技能 / 记忆
- `GET /api/agents` → `{"agents":[{"id":"lead","name":"...","description":"...","category":"general","source":"bundled","toolsets":[...],"skills":[...],"example_prompts":[...]}]}`
- `GET /api/skills` → `{"skills":[{"name":"single-cell-upstream","description":"...","when_to_use":"...","source":"bundled","path":"..."}]}`
- `GET /api/skills/{name}` → `{"name":"...","description":"...","body":"...","files":["scripts/qc.py"],"path":"..."}`
- `GET /api/memory` → `{"items":[{"slug":"x","title":"...","updated_at":1.0,"size":1}]}`
- `GET /api/memory/{slug}` → `{"slug":"x","title":"...","body":"..."}`
- `PUT /api/memory/{slug}` `{"title":"...","body":"..."}` → item
- `DELETE /api/memory/{slug}` → `{"ok":true}`

### 后台任务
- `POST /api/jobs` `{"kind":"python"|"shell","code":"...","name":"..."}` → job
- `GET /api/jobs` → `{"jobs":[{"id":"j_...","name":"...","kind":"python","status":"running|done|failed|cancelled","started_at":1.0,"ended_at":null,"exit_code":null,"log_bytes":0}]}`
- `GET /api/jobs/{id}/log?offset=0` → `{"text":"...","next_offset":123,"eof":false}`
- `POST /api/jobs/{id}/cancel` → `{"ok":true}`

### 图表
- `GET /api/figures` → `{"figures":[{"name":"fig_x.png","url":"/api/figures/fig_x.png","size":1,"mtime":1.0}]}`
- `GET /api/figures/{name}` → PNG
- `DELETE /api/figures/{name}` → `{"ok":true}`

### 设置 / 系统
- `GET /api/settings` → `{"settings":{...公开字段...},"llm":{"provider":"deepseek","model":"deepseek-chat","api_base":"...","has_key":true,"label":"DeepSeek"},"providers":[catalog]}`
- `PUT /api/settings` `{"patch":{...}}` → 同上
- `POST /api/settings/keys` `{"DEEPSEEK_API_KEY":"sk-..."}` → `{"ok":true}`
- `POST /api/settings/test_llm` → `{"ok":true,"latency_ms":123,"reply":"pong","error":null}`
- `GET /api/health` → `{"ok":true,"version":"1.0.0","kernel":{"running":true},"llm":{"configured":true,"provider":"deepseek"},"workspace":"...","uptime_s":1.0}`
- `GET /api/system/info` → `{"platform":"Windows","python":"3.11.9","cwd":"...","careers":...}`
- `WS /ws/terminal` → 双向 JSON：`{"type":"input","data":"ls\r"}` / `{"type":"output","data":"..."}` / `{"type":"exit","code":0}` / `{"type":"resize","cols":100,"rows":30}`

未知字段一律忽略；错误统一 `{"error":{"message":"...","code":"...","detail":"..."}}` + 4xx/5xx。

## 6. Python 模块接口（队友实现）

### 6.1 `omicslab/session/store.py`
```python
class ConversationStore:
    def __init__(self, settings: Settings) -> None
    def list(self) -> list[dict]          # summary, updated_at desc
    def get(self, cid: str) -> Conversation        # ConfigError/KeyError if missing
    def create(self, agent: str = "lead", title: str = "新会话") -> Conversation
    def save(self, conv: Conversation) -> None
    def delete(self, cid: str) -> bool
    def rename(self, cid: str, title: str) -> Conversation
```
持久化：`<home>/conversations/<id>.json`，原子写（tmp+replace）。

### 6.2 `omicslab/session/jobs.py`
```python
class JobManager:
    def __init__(self, settings: Settings) -> None
    def submit(self, kind: str, code: str, name: str = "") -> dict
    def list(self) -> list[dict]
    def get(self, jid: str) -> dict
    def log(self, jid: str, offset: int = 0) -> dict   # {"text","next_offset","eof"}
    def cancel(self, jid: str) -> bool
    def shutdown(self) -> None
```
`kind=="python"` 用 settings.resolve_kernel_python()；`shell` 用 `subprocess` shell。cwd=workspace，日志写 `<home>/jobs/<id>.log`。

### 6.3 `omicslab/agent/templates.py`
```python
@dataclass
class AgentTemplate:
    id: str; name: str; description: str; instructions: str
    toolsets: list[str]; skills: list[str]; category: str
    example_prompts: list[str]; tier: str; source: str; path: str | None

def load_agents(settings: Settings) -> dict[str, AgentTemplate]
def get_agent(settings: Settings, agent_id: str, agents: dict | None = None) -> AgentTemplate
```
加载顺序（后者覆盖同 id）：包内 `omicslab/agents/*.md` → `<workspace>/agents/*.md` → `$OMICSLAB_TEMPLATES_DIR/*.md`。
格式：YAML frontmatter（`---` 包裹）+ Markdown 正文作为 `instructions`。坏文件跳过并记 warning，不得抛异常崩溃。

### 6.4 `omicslab/agent/skills.py`
```python
@dataclass
class Skill:
    name: str; description: str; when_to_use: str; body: str
    path: Path; source: str; files: list[str]

def load_skills(settings: Settings) -> dict[str, Skill]
def find_skill(settings: Settings, name: str) -> Skill
def catalog_text(skills: dict[str, Skill], max_chars: int = 6000) -> str
```
根目录顺序（同名先者胜）：`$OMICSLAB_SKILL_ROOTS`（`;`/`:` 分隔）→ 包内 `omicslab/skills` → `<workspace>/skills`。
每个 skill 是目录，含 `SKILL.md`（frontmatter: name/description/when_to_use，正文为操作指南）。

### 6.5 `omicslab/agent/memory.py`
```python
class MemoryStore:
    def __init__(self, settings: Settings) -> None
    def list(self) -> list[dict]
    def get(self, slug: str) -> dict
    def put(self, slug: str, title: str, body: str) -> dict
    def delete(self, slug: str) -> bool
    def index_text(self, max_chars: int = 3000) -> str
```
`<home>/memory/<slug>.md`，slug 正则 `[A-Za-z0-9_-]{1,64}`，body ≤ 64 KiB。

### 6.6 `omicslab/agent/tools.py`
```python
@dataclass
class ToolSpec:
    name: str; description: str; parameters: dict; toolset: str
    handler: Callable[..., Awaitable[ToolResult]]; requires_approval: bool = False

class ToolContext:
    settings: Settings; kernel: "KernelService"; registry: "ToolRegistry"
    workspace: Path; conversation_id: str; agent_id: str
    emit: Callable[[AgentEvent], Awaitable[None]]
    cancel_event: asyncio.Event; approver: "Approver | None"
    jobs: "JobManager"; memory: "MemoryStore"

class ToolRegistry:
    def __init__(self, specs: list[ToolSpec]) -> None
    def list_specs(self, toolsets: list[str] | None = None) -> list[dict]   # OpenAI tools JSON
    def get(self, name: str) -> ToolSpec
    async def execute(self, ctx: ToolContext, name: str, arguments: dict) -> ToolResult

def build_registry(settings: Settings) -> ToolRegistry
```
必备工具（名称固定，前端/文档依赖）：
`run_python_code`(python) `run_shell`(shell) `list_files`(files) `read_file`(files) `write_file`(files)
`skill_list`(skills) `skill_view`(skills) `memory_list`(memory) `memory_view`(memory)
`memory_create`(memory) `memory_edit`(memory) `agent_list`(agents) `delegate_agent`(agents)
`submit_background_job`(jobs) `job_status`(jobs) `list_agents_catalog`? 不需要。
`get_system_info`(system) `export_notebook`(notebook)。
`run_shell`/`write_file` 的 `requires_approval=True`（Approver 决定 auto/ask）。

### 6.7 `omicslab/agent/approvals.py`
```python
class Approver:
    def __init__(self, policy: str = "auto", timeout_s: float = 120.0) -> None
    async def request(self, ctx: ToolContext, tool: str, arguments: dict, reason: str) -> bool
    def resolve(self, approval_id: str, approved: bool) -> bool   # server 调用
    def pending(self) -> list[dict]
```
`policy=="auto"` 直接 True；`"ask"` 时 `ctx.emit(AgentEvent("approval_request", ...))` 后等待 Future，超时 → False（拒绝并说明）。

## 7. 前端契约（`omicslab/web/**`）

- 纯静态，无构建、无 CDN 依赖（离线可用）。入口 `index.html`，`js/` 用 ES modules。
- 由 FastAPI 以 `/` 提供（Lead 负责 mount）。
- 必须实现页面：**对话**（流式 markdown、工具调用卡片可折叠、图片内联、停止/重发、会话列表）、**变量**（列表+详情弹窗：shape/head/dtypes/describe）、**文件**（树、预览文本/图片/CSV 表格、上传、下载、新建）、**图表画廊**（缩略图、灯箱、下载、删除）、**后台任务**（提交/轮询日志/取消）、**技能库**（列表+正文查看）、**记忆**（列表/编辑）、**设置**（provider 选择、模型、key 写入、测试连接、审批策略、主题、工作区信息）、**健康状态**。
- 交互要求：SSE 断线重连（指数退避）、请求失败 toast、键盘快捷键（`Ctrl/Cmd+Enter` 发送、`Ctrl/Cmd+K` 命令面板）、可拖拽分栏、深/浅主题持久化、拖拽上传、响应式。
- 设计语言：深色为主、紫色/青色点缀、圆角卡片；中文界面。

## 8. 技能/智能体内容契约（`omicslab/skills/**`, `omicslab/agents/**`）

- 必须包含智能体 `lead`（默认，通用分析负责人），以及至少：`single-cell-analyst`、`spatial-analyst`、`flow-cytometrist`、`figure-designer`、`report-writer`、`data-critic`。
- 技能包（每个一个目录 + SKILL.md）：`single-cell-upstream`、`single-cell-downstream`、`spatial-transcriptomics`、`flow-cytometry`、`bulk-transcriptomics`、`cadd-cheminformatics`、`geo-public-data`、`figure-style`、`report-writing`、`notebook-ops`。
- SKILL.md frontmatter：`name`, `description`, `when_to_use`, `version`；正文给出可执行的分析流程、代码片段、检查清单、常见陷阱。
- 全部自研文本；禁止复制第三方文档原文。
- 附带 `scripts/` 下可运行辅助脚本（可选）。

## 9. 工程约定

- Python：3.10+ 兼容写法，`from __future__ import annotations`，类型标注齐全，异常用 `ConfigError`/`ToolError` 等明确类型；**不得**让单个坏 skill/agent 文件导致整体启动失败。
- 依赖：仅使用 pyproject 已声明依赖；新增依赖需先问 Lead。
- 日志：`logging.getLogger("omicslab.<module>")`。
- 测试：pytest，`asyncio_mode=auto`；不依赖网络（LLM 用 `mock` provider）。
- 代码注释用英文，面向用户的 UI 文案用中文。
- 完成后自测：`pytest tests/<your tests> -q`；确认自己的模块可 import。
