# CONTRACTS-3 — 优化方案 A→E 批次的接口唯一事实来源

> **归档文档（历史）**：本文件是 Suwen 1.2→2.0 开发过程的原始记录，仅用于追溯，不是当前用户文档。当前文档入口见 [docs/README.md](../README.md)。

基准：`C:\projects\suwen`，版本 1.1.0 → 本轮目标 1.2.0。
需求来源：`原始升级任务书.md`（下称“任务书”，T01–T11 / F01–F15）。
所有实现必须遵守本文件；与既有 `docs/CONTRACTS.md`、`docs/CONTRACTS-2.md` 冲突时以本文件为准（新接口向前兼容旧接口）。

## 0. 所有权 / 写入范围

| 角色 | 写入范围 |
|---|---|
| Lead | `omicslab/runtime/**`（新）、`omicslab/workspace/**`（新）、`omicslab/execution/base.py`、`execution/local.py`、`agent/loop.py`、`agent/approvals.py`、`agent/tools.py`（仅 backend 接线）、`server/state.py`、`server/chat.py`、`server/routes.py`、`server/app.py`、`config.py`、`cli.py`、`tests/test_runtime*.py`、`tests/test_workspace*.py`、`tests/test_scheduler.py`、`tests/test_backend.py` |
| frontend3 | `omicslab/web/**` 全部；不写 Python |
| evidence2 | `omicslab/discovery/**`（含 engine 评估段、`discovery/evidence.py`、`discovery/tools.py` 的 evidence 工具）、`tests/test_evidence.py`、`tests/test_discovery.py`（可与 Lead 协调） |
| remote2 | `omicslab/ssh/**`、`omicslab/server/routes_ssh.py`、`omicslab/server/terminal.py`、`omicslab/execution/ssh_backend.py`、`omicslab/ssh/worker.py`；`tests/test_ssh.py`、`tests/test_execution_ssh.py` |
| docs2（稍后） | `README.md`、`CHANGELOG.md`、`docs/*`（除本文件）、`pyproject.toml` 版本、`omicslab/__init__.py` 版本行 |

禁止：把失败包装成 `ok=True`；用 text-hit 提升证据；断开订阅时取消 Run；取消无关会话；静默本地回退执行远端任务；真实凭据落盘明文。

## 1. 通用约定

- ID：Run `rn_<12hex>`，Trace `tr_<12hex>`，Event `ev_<8hex>_<seq>`，Workspace `ws_<12hex>`，AgentTask `at_<12hex>`，Approval `ap_<12hex>`。用 `omicslab.agent.types.new_id(prefix)` 风格生成（`new_id("rn")` 等）。
- 时间统一 `datetime.now(timezone.utc).isoformat()`。
- 错误 envelope 保持 `{"error":{"message","code","detail"}}`；新增 code：`run_in_progress`(409)、`run_not_found`(404)、`workspace_invalid`(400)、`workspace_not_found`(404)、`backend_unavailable`(503)、`remote_unavailable`(502)、`approval_not_found`(404)、`task_not_found`(404)。
- SSE 仍为单行 envelope：`data: {"type": ..., "data": {...}, "ts": ...}`；新增事件类型：`heartbeat`、`run_status`、`child_run`、`approval_resolved`。旧事件类型不变。
- 一切持久状态先提交（SQLite/JSON 原子写）再广播（SSE）；广播失败不影响执行。
- 旧入口（`POST /api/chat`、`/api/chat/stop`、`/api/kernel/*`、`/api/files/*`、`/api/jobs/*`）保留兼容，内部改为走新 RunService / WorkspaceContext；不允许两套独立执行逻辑。
- 测试：新增用例必须在不联网、无真实 SSH 的条件下可跑；真实远端/真模型单独标注“未验证”。pytest 基线 274，只可增加。

## 2. Runtime：EventStore（`omicslab/runtime/events.py`）

SQLite（WAL）文件：`settings.home / "runtime.db"`；`PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON`；`meta(key,value)` 记录 `schema_version=3`。

表：
```sql
runs(
  run_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, session_id TEXT NOT NULL,
  parent_run_id TEXT, root_run_id TEXT NOT NULL, client_request_id TEXT,
  status TEXT NOT NULL, agent_id TEXT, workspace_json TEXT NOT NULL,
  created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT, updated_at TEXT NOT NULL,
  last_activity TEXT, finish_reason TEXT, error_json TEXT, usage_json TEXT,
  result_text TEXT, meta_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX ux_runs_client_request ON runs(client_request_id) WHERE client_request_id IS NOT NULL;
events(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
  trace_id TEXT NOT NULL, run_id TEXT NOT NULL, type TEXT NOT NULL,
  payload_json TEXT NOT NULL, schema_version INTEGER NOT NULL DEFAULT 3, ts TEXT NOT NULL
);
CREATE INDEX ix_events_trace ON events(trace_id, seq);
agent_tasks(
  task_id TEXT PRIMARY KEY, parent_run_id TEXT NOT NULL, run_id TEXT NOT NULL,
  session_id TEXT NOT NULL, profile TEXT, status TEXT NOT NULL, goal TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT,
  budget_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, error_json TEXT,
  position INTEGER NOT NULL DEFAULT 0
);
approvals(
  approval_id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, tool TEXT NOT NULL,
  arguments_json TEXT NOT NULL, reason TEXT NOT NULL, target_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, decision TEXT
);
```

`class EventStore`：
- `__init__(path: Path)`；`close()`；`schema_version` 属性。
- `create_run(run: dict) -> dict`（必含 run_id/trace_id/session_id/root_run_id/status/workspace/created_at/updated_at；`client_request_id` 冲突抛 `RunConflict`）。
- `get_run(run_id) -> dict | None`；`update_run(run_id, **fields)`（白名单字段，更新 updated_at/last_activity）；`list_runs(session_id=None, parent_run_id=None, status=None, limit=50) -> list[dict]`；`find_by_client_request(client_request_id)`。
- `append_event(trace_id, run_id, event_type, payload, *, event_id=None) -> dict`（返回含 seq/event_id/ts）；如有 `event_id` 重复则幂等返回已存在行。
- `append_events_bulk(items: list[dict]) -> list[dict]`（每项 trace_id/run_id/type/payload/ts）。
- `list_events(trace_id, after_seq=0, limit=500) -> list[dict]`；`max_seq(trace_id) -> int`。
- `create_agent_task/update_agent_task/get_agent_task/list_agent_tasks(parent_run_id)`。
- `create_approval/update_approval/get_approval/list_approvals(run_id=None, status=None)`。

任何 DB 异常不得打断主循环：`append_event` 失败时写 logger.exception 并返回内存 dict（seq=-1），RunService 继续广播。

## 3. Runtime：RunService（`omicslab/runtime/runs.py`）

```python
class RunService:
    def __init__(self, settings, events, loop, workspace_service, *, approver, max_subscribers=100)
    async def submit(self, conversation_id: str, message: str, *, agent: str | None = None,
                     provider: str | None = None, model: str | None = None,
                     attachments: list[dict] | None = None,
                     client_request_id: str | None = None,
                     workspace_id: str | None = None,
                     parent_run_id: str | None = None) -> dict
    def get(self, run_id: str) -> dict | None
    def list(self, *, conversation_id=None, parent_run_id=None, limit=50) -> list[dict]
    async def cancel(self, run_id: str, reason: str = "") -> dict
    def subscribe(self, trace_id: str, after_seq: int = 0) -> AsyncIterator[dict]  # 事件+心跳
    async def append_user_message(self, run_id: str, message: str) -> dict  # steering：排队到当前 run 后继续
```

行为要求：
1. `submit`：校验会话存在（不存在的 conversation_id → 404）；解析 workspace（缺省用会话绑定/默认工作区）；`client_request_id` 存在则直接返回该 run（**不重复执行**）；同会话存在活跃 run（status ∈ preparing/running/waiting_approval/stopping）→ 抛 `RunConflict(active_run_id)`（API 返回 409 `run_in_progress`，带 `detail.run_id`）。
2. 创建 run（status=`preparing`）后立刻返回；后台 asyncio task 执行 loop。执行前 `update_run(status="running", started_at=...)`。
3. 执行：`await self.loop.run(...)`，emit 由 RunService 包装为 `AgentEvent` → `events.append_event(trace_id, run_id, ...)` → 广播给所有订阅者（每订阅者 `asyncio.Queue(maxsize=1000)`，满时丢弃最旧并记 `dropped` 计数，不阻塞执行）。
4. 每个持久事件同时落轨迹（沿用 `TrajectoryRecorder`）。
5. 终态：`succeeded`（finish_reason=stop）、`failed`（error）、`cancelled`（用户取消且已确认内核中断/进程退出）、`interrupted`（服务重启/进程丢失对账）、`unknown`（外部副作用不确定）。`finish_reason=cancelled` 时需 `cancel_requested` 先置 `stopping`，确认后 `cancelled`。
6. `cancel(run_id)`：只取消该 run 及其子任务（`agent_tasks.parent_run_id` 递归向下）；中断该 run workspace 对应内核（按 workspace 作用域，不影响其他会话）；`approver.cancel_for_run(run_id)`；返回 `{"ok":True,"run_id","status":"stopping"}`。
7. `subscribe`：先补发 `list_events(after_seq)`，然后挂上订阅者队列；每 15s 无事件时 yield `{"type":"heartbeat","data":{"run_id","trace_id","seq","ts"},"ts"}`；run 进入终态且最后一个事件发完后关闭。订阅者断开只移除订阅，不取消 run。
8. 服务启动对账 `recover_on_startup()`：把上次进程留下的 `running/preparing/waiting_approval/stopping` run 标记 `interrupted`，附加 `meta_json.recovered=true`，追加 `run_status` 事件；不自动重放。子任务同样处理。
9. 服务关闭 `shutdown()`：取消所有活跃 run task（**注意**：不是用户取消语义，标记 `interrupted`，不发 cancelled），关闭订阅者。

工具与后端执行统一入口：`ToolContext.backend`（见 §5），loop 构造 context 时注入 `run_id/workspace/backend`。

## 4. Workspace（`omicslab/workspace/**`）

`WorkspaceContext`（dataclass，可序列化进 Run.workspace_json）：
```python
workspace_id, revision:int, backend_kind:"local"|"ssh", connection_id:str|None,
root:str, cwd:str, environment_ref:str|None,
allowed_read_roots:list[str], allowed_write_roots:list[str]
```
`WorkspaceStore(settings)`：`settings.home/workspaces.json`，原子写；记录 `selected_id`、`items`。
`WorkspaceService(settings, store, connections=None)`：
- `list() -> list[dict]`（含 `selected: bool`）、`get(workspace_id)`、`selected()`。
- `create_local(path, *, name="", create=False, data_roots=None) -> dict`：规范化绝对路径（`Path.resolve()`），校验存在/目录/可写；禁止 `os.chdir`。
- `create_ssh(connection_id, remote_path, *, name="", environment_ref="") -> dict`：路径按 POSIX 校验（不以 `/` 开头视为无效），不调用本地 resolve；可调用 ConnectionService 校验连通性，失败保存但标记 `verified=false`。
- `validate_local(path) -> {"ok","resolved","exists","is_dir","writable","error"}`；`validate_ssh(connection_id, path)` 同理。
- `select(workspace_id)`；`update(workspace_id, **fields)`；`delete(workspace_id)`（默认工作区不可删）。
- `context(workspace_id=None) -> WorkspaceContext`；`browse(workspace_id, path="")` 本地走 `server.files.list_dir`（root=workspace root），SSH 走 `ConnectionService` 的 SFTP list。
- `probe(workspace_id) -> dict`：本地 `{kind:"local",python,hostname,platform,cwd,disk_free,writable}`；SSH 通过 backend `probe_environment()`。
- 默认工作区：首次创建 `ws_default`，root=`settings.workspace`（已存在）；`selected_id` 缺省指向它。
- 会话绑定：`Conversation.meta["workspace_id"]`（不存在则默认）；`POST /api/conversations` 接受 `workspace_id`；切换只影响新会话/新 run，旧 run 用 snapshot。

REST（`server/routes_workspaces.py`）：
`GET /api/workspaces`、`POST /api/workspaces`（body {kind,name,path,connection_id,create,data_roots}）、`GET/PATCH/DELETE /api/workspaces/{id}`、`POST /api/workspaces/{id}/select`、`POST /api/workspaces/validate`、`GET /api/workspaces/{id}/browse?path=`、`POST /api/workspaces/{id}/probe`、`GET /api/workspaces/{id}/backend-status`。
`GET /api/health` 增加 `runtime`、`workspaces`、`execution` 诊断（见 T11）。

## 5. ExecutionBackend（`omicslab/execution/`）

```python
class ExecutionBackend(ABC):
    kind: str            # "local" | "ssh"
    context: WorkspaceContext
    async def start() -> None
    async def close() -> None
    async def probe_environment() -> dict
    async def stat(path: str) -> dict
    async def list_dir(path: str = "") -> dict          # 同 server.files.list_dir 结构
    async def read_text(path: str, max_bytes: int = 200000) -> dict
    async def write_text(path: str, content: str) -> dict
    async def mkdir(path: str) -> dict
    async def delete(path: str) -> dict
    async def upload_dir(...) / async def download(...)  # 可选能力，未实现抛 BackendUnsupported
    async def execute_python(code: str, *, timeout_s: int | None = None, silent: bool = False) -> dict
    async def list_variables() -> list[dict]
    async def var_detail(name: str) -> dict
    async def spawn_process(kind: str, code: str, name: str = "") -> dict
    async def process_log(job_id: str, offset: int = 0) -> dict
    async def process_cancel(job_id: str) -> dict
    async def process_list() -> list[dict]
    async def interrupt() -> dict
    async def build_notebook() -> dict
```
- `LocalBackend(settings, context, kernel_service, jobs, files_helpers)` 包装现有 KernelService/JobManager/server.files。
- `SSHBackend(settings, context, connection_service)` 由 remote2 实现：SFTP 文件、远端持久 worker（`ssh/worker.py`，JSON-lines，仅监听 stdio，不监听端口）、exec cwd、进程登记、日志、取消进程组、probe。
- 统一错误：`BackendError(message, code, detail)`；远端不可用 → `RemoteUnavailable(BackendError)`，**禁止回退本地**。
- `ToolContext` 新增字段（均可选、默认 None，保持旧测试通过）：`backend`、`workspace`、`run_id`、`agent_task_id`、`scheduler`。工具优先用 `ctx.backend`，缺失时沿用旧全局对象（兼容 CLI/tests）。
- 工具输出必须带 `data.execution_target = {"kind","root","cwd","connection_id"}`；`run_python_code/run_shell/文件/变量/图表/后台任务/终端` 全部走同一 backend。

## 6. ConnectionService（remote2）

`omicslab/ssh/connections.py`：进程内单例（`get_connection_service()`），包装 `SSHManager`，HTTP 路由、Agent 工具、SSHBackend、终端、workspace 探测 **共用同一实例与同一份凭据**。
- `test_profile(profile, *, password=None) -> dict`；`exec(profile_id, command, *, cwd=None, timeout_s=..)`；`open_sftp(profile_id)`；`open_terminal(profile_id)`；`probe(profile_id, path)`。
- 临时密码：可只在内存（`password_memory`），测试成功后可显式 `remember` 决定是否落盘；持久凭据不得明文/Base64 回显，改为 `credential_id` 引用（系统凭据库不可用时降级为“仅内存”，并在 UI 明示）。
- 传输/命令重试：仅“确定未提交”的连接错误可重试；执行中失联 → `unknown` 并返回对账信息，**不得自动执行第二次**。
- 终端改为 paramiko `invoke_shell()` PTY：支持 resize send、Ctrl+C、持续 cwd、stdin；窗口尺寸用 `{type:"resize",cols,rows}`。

## 7. Approval（Lead + 前端）

`Approver` 保持**单例稳定身份**：`set_policy(policy)` 原地更新；`request(ctx, tool, arguments, reason)` 记录并 emit `approval_request`，payload 增加：
```json
{"id","tool","arguments","reason","run_id","agent_task_id","child_run_id","target":{"kind","root","cwd","connection_id"},"expires_at"}
```
- `resolve(id, approved)` 不变；`cancel_all(reason)` 仅保留给服务关闭；新增 `cancel_for_run(run_id, reason="")`、`cancel_for_task(task_id)`、`pending(run_id=None)`。
- `put_settings()` 不再 `rebuild_approver`，改调 `state.approver.set_policy(policy)`。
- REST：`GET /api/approvals?run_id=&status=`、`POST /api/approvals/{id}`（body {decision}）。子任务审批进全局审批中心。
- 子调用事件转发：`loop._run_sub` 不再 `_noop_emit`；子 run 用独立 trace，父 trace emit `child_run`（`{child_run_id, task_id, agent_id, status, event}` 摘要）；审批事件同时进父流（带 child 身份）。
- 结构化失败：子任务失败时返回 `ToolResult(ok=False, content="子任务失败：…", data={"status":"failed","error":{...},"task_id":...})`，不得 ok=True。

## 8. ChildTaskScheduler（`omicslab/runtime/scheduler.py`）

```python
class ChildTaskScheduler:
    def __init__(self, settings, events, runs, loop, agents, conversations, *, max_concurrent=2, max_depth=1)
    async def spawn(self, goal: str, *, profile: str | None, parent_run_id: str,
                    workspace: WorkspaceContext, budget: dict | None = None,
                    input_refs: list[str] | None = None) -> dict      # AgentTask
    def get(self, task_id) -> dict
    def list(self, parent_run_id: str | None = None) -> list[dict]
    async def wait(self, task_ids: list[str], *, timeout_s: float = 120) -> list[dict]
    async def send_message(self, task_id, message: str) -> dict        # 追加用户消息并触发续跑
    async def cancel(self, task_id) -> dict                            # 只取消该任务子树
```
- 子任务拥有独立持久 Session（`Conversation.meta.kind="child"`, `parent_run_id`, `agent_task_id`）与独立 Run（`parent_run_id` 指向父 run，`root_run_id` 同根）；事件写子 trace；父 trace 收到 `child_run` 摘要事件。
- 并发上限默认 2（`settings.max_child_tasks`，配置项新增，默认 2，范围 1-8；`max_child_depth` 默认 1）。超限 → 排队（status=queued），有空位再执行。
- 预算：`{max_iterations, timeout_s, max_tokens}`；预算耗尽 → `failed`/`budget_exhausted` 终态。
- 结果契约：`{"task_id","status","summary","artifact_refs","evidence_refs","warnings","error","usage"}`。`awaiting_input` 与 `failed` 分开。
- 父 run 取消时级联取消子任务；子任务单独取消不影响兄弟任务与父任务。
- 子任务计算使用隔离内核：`scope = "task:" + task_id`（KernelPool 见 §10），默认 `max_scopes=4`、空闲 600s 回收。
- Agent 工具：`spawn_agent(goal, profile=None, budget=None)`、`get_agent_task(task_id)`、`wait_agent_tasks(task_ids, timeout_s=120)`、`send_agent_message(task_id, message)`、`cancel_agent_task(task_id)`、`list_agent_tasks()`；`delegate_agent` 兼容实现 = spawn + wait，返回结构化 JSON 文本（含 status/summary/…），失败时 `ok=False`。
- REST：`GET /api/runs/{run_id}/children`、`GET /api/agent-tasks?parent_run_id=`、`GET /api/agent-tasks/{id}`、`POST /api/agent-tasks/{id}/messages`、`POST /api/agent-tasks/{id}/cancel`。
- 前端任务树消费上述 API + SSE `child_run` 事件。

## 9. 前端（frontend3）

- T01：`modal-root` 空时 `pointer-events:none`，backdrop/dialog `pointer-events:auto`；关闭幂等；移除 `modalStack` 残留；异步 action 失败显示错误并恢复按钮；Esc/X/背景/确认取消路径全部验证；路由卸载清理弹窗；连续 20 次开关不遮挡。
- T02：全局审批中心（侧栏“审批”或对话内审批卡），子任务审批显示来源（agent、主机、目录、工具）、允许/拒绝、超时倒计时；子任务进度用 `child_run` 事件显示为任务树/子卡片（不显示模型内部推理）。
- T03：新 Run API；Chat 发送后立即返回 run_id，用 `GET /api/traces/{trace_id}/events?after_seq=` 订阅；切页/刷新后自动重新订阅（sessionStorage 保存 conversation_id+run_id+last_seq）；`heartbeat` 忽略但重置 45s 计时；超时提示“连接中断，任务状态待确认”并轮询 `GET /api/runs/{id}` 重连；外层 `try/finally` 复位 streaming/busy；状态文案：连接中/排队中/等待审批/运行中/正在停止；409 时提示“已有运行，等待或停止”；发送失败保留草稿。
- T04/T09：顶部工作台条（项目/工作区/主机/目录/环境/连接状态）+ 工作区切换弹层（本地路径输入、最近目录、校验、SSH 档案+远端目录、探测结果）；左栏会话；中央 Chat；右侧 Results/Files/Variables 可切换可拖拽；底部 Compute（终端/日志/后台任务/子任务树）可收起；保留旧路由入口；设置里技能/注册表/记忆/连接。
- 验收：Edge headless 1280×720 与 1440×900 截图；用 `elementFromPoint` 验证 T01；不引入构建步骤与外部 CDN；零 console error。

## 10. 其它

- KernelPool（Lead）：`AppState.kernels: dict[str, KernelService]`，scope 默认 `"workspace:<workspace_id>"`、子任务 `"task:<task_id>"`；`get_kernel(scope)` 懒启动；`shutdown_all()`；空闲回收；`/api/kernel/*` 作用于当前工作区 scope。
- T10（evidence2）：新增 `omicslab/discovery/evidence.py`：`AnalysisResult`（必需：`data_sha256, script_sha256, seed, test, effect_size, ci_low, ci_high, p_value, q_value_or_none, correction, method, sample_definition, exclusions, execution_status, artifact_refs, environment`），`AnalysisResult.from_payload(dict) -> (AnalysisResult|None, errors:list[str])`；`EvidenceEvaluator.evaluate(preregistration, result, run_info) -> {"verdict":"supported|refuted|inconclusive","strength":"strong|moderate|weak","reproducibility":"none|code_recorded|rerun_verified","reasons":[...]}`：只有 `execution_status=="completed"` 且数值字段合法（p∈[0,1]、CI 含 effect、q 合法、test/method 非空、数据/脚本 hash 存在）才可 supported/refuted；缺失必需字段→inconclusive；text 命中不参与。新增工具 `discovery_record_analysis_result`（toolset=discovery）接收结构化 JSON；引擎从工具结果读取（不解析自由文本），并与预注册 success_criteria 比较。`reproducible` 字段删除/替换为两层 reproducibility；`Evidence` 增加 `analysis_result`（dict|None）、`reproducibility`。报告/证据显示结构化数值。
- T11（docs2）：README/ARCHITECTURE/API/CHANGELOG/INSTALL 与诊断导出；版本 1.2.0；`GET /api/diagnostics?export=1` 输出脱敏 JSON（IDs、版本、后端、最近错误），含 `X-Request-ID` 中间件（请求 ID 回显响应头与日志）。
- 迁移（Lead）：启动时若存在旧 `trajectories/*.jsonl`/conversations，保留不动；RunService 只对新运行写 SQLite；`legacy` run 元数据标记 `unknown`，不伪造历史 run。
- 版本：`pyproject.toml`/`__init__.py`/`state._version()` → 1.2.0；CHANGELOG 记录 A–E。

## 11. 验收映射（任务书第 12 节）

| 验收项 | 负责 | 证据 |
|---|---|---|
| modal 20 次开关 | frontend3 | 浏览器脚本 elementFromPoint + 截图 |
| 默认 lead | frontend3 + Lead | 首次启动截图/接口 |
| 旧偏好迁移 | frontend3 | localStorage 迁移提示截图 |
| 双击发送/409 | Lead + frontend3 | httpx 测试 + 浏览器 |
| 断线恢复/重复事件 | Lead + frontend3 | after_seq 补发测试、前端去重 |
| 切页/刷新继续运行 | Lead + frontend3 | run 继续 + resubscribe 测试 |
| 崩溃重启对账 | Lead | restart 测试 |
| 子任务审批/取消/任务树 | Lead + frontend3 | SSE/API 测试 + 截图 |
| 设置变更不丢审批 | Lead | 单测 |
| SSH 共享连接/cwd/无重复副作用 | remote2 | fixture 测试（真实 SSH 标注未验证） |
| 工作区切换/两项目隔离 | Lead + frontend3 | WorkspaceContext 测试 |
| 停止只影响自身 | Lead | 多会话测试 |
| 文本“不显著”不提升证据 | evidence2 | 单测 |
| 后台变量缺失提示 | Lead | 工具提示测试 |
| 大目录/大日志有界 | Lead/remote2 | 限流测试 |


---

## 附录：1.2.0 落地核对（代码为准）

> 契约写于实现前；落地时以下细节以代码与 `docs/API.md` 为准（pkgdocs2 核对结果）：

| 契约描述 | 实际实现 |
|---|---|
| 事件库路径 `home/runtime/runtime.db` | `home/runtime/events.db`（SQLite/WAL，schema_version=3） |
| `POST /api/runs` 提交运行 | `POST /api/sessions/{session_id}/runs`；`/api/chat` 保留为 SSE 快捷入口，返回 `connected` 含 run_id/trace_id |
| 事件帧 `type/data/ts` | 帧另含 `seq/event_id/run_id/trace_id/session_id`；重放 `GET /api/runs/{id}/stream?after_seq=` 与 `GET /api/traces/{trace_id}/events` |
| discovery SSE `event: discovery` | 统一 JSON envelope（`data: {"type":"discovery","data":{...}}`）；详见 `omicslab/server/chat.py::_sse` |
| 内核作用域端点仅 status | 另有 `POST /api/kernels/{scope}/execute`、`GET /api/kernels/{scope}/vars`（scope 支持 `main`/`ws:<id>`/裸 id） |
| 子运行事件 | `child_run` 事件 data：`task_id/child_run_id/child_trace_id/agent_id/depth/status/finish_reason/error/result_preview/duration_ms/parent_run_id` |
| 审批 ID 前缀 `ap_` | 已实现（10 hex）；审批行持久化于 `approvals` 表，`approval_resolved` 事件 data：`{id,approved,decided_at}` |
| 轨迹 | 旧 `trajectories/*.jsonl` 只读兼容；新运行写 `runtime/events.db`（runs/events 表） |
| 统计工具数 | 31 个工具 / 13 个 toolset（core/discovery/ssh/registry/vision/agents/...） |
