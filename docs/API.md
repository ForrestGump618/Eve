# API 参考（API）

本页对应 Suwen 2.0.0；正文中的“1.2.0 起”表示该能力首次引入的版本，不代表当前版本号。

素问 Suwen 的服务是一个本地 FastAPI 应用，默认地址（`启动工作台.ps1` 默认使用 8766）：

```text
http://127.0.0.1:5077
```

> 本页依据 [`archive/CONTRACTS-3.md`](archive/CONTRACTS-3.md)（1.2.0 时期接口契约）与实际服务端代码整理。契约文档已归档，仅作历史参考；当前字段与错误码以 `omicslab/server/routes_*.py`、`chat.py` 的实现为准。若你发现两者不一致，请先看 `GET /api/health` 与 `GET /api/runtime/diagnostics` 确认运行版本，再提 Issue。

## 0. 通用约定

### 0.1 基础

| 项目 | 说明 |
|---|---|
| Base URL | `http://127.0.0.1:5077` |
| 请求体 | `application/json`（文件上传为 `multipart/form-data`） |
| 字符集 | UTF-8，响应不转义中文 |
| 时间戳 | Unix 秒（float）；运行/事件的 `created_at` 等使用 UTC ISO-8601 字符串（见 §16） |
| 错误信封 | 所有非 2xx 响应统一为 `{"error": {"message", "code", "detail"}}`（见 §0.2） |
| 文件路径 | **工作区相对路径**，禁止 `..` 越界与绝对路径 |
| 对象 ID | 由服务端生成（`run_`、`tr_`、`ws_`、`dp_`、`hy_`、`ev_` 等），客户端**不要解析前缀**，只当不透明字符串 |
| 事件序号 | 运行相关 SSE 帧与 `/api/traces/*/events` 都带单调递增的 `seq`；断线后用 `after_seq` 重放（见 §16） |
| 未知字段 | 一律忽略（向前兼容） |

### 0.2 错误格式

所有非 2xx 响应统一为：

```json
{
  "error": {
    "message": "给人看的中文说明",
    "code": "not_found",
    "detail": "额外的调试信息（可能是字符串、对象或 null）"
  }
}
```

实现方式：路由内可以返回扁平的 `{"message","code","detail"}` 或已包好的 `{"error":{...}}`，服务端异常处理器会归一成上面的形状（见 `omicslab/server/app.py`）。FastAPI 的请求体/查询参数校验失败固定返回 `422` + `validation_error`。

| HTTP 状态 | 常见 `code` | 含义 |
|---|---|---|
| 400 | `bad_request` / `invalid_path` | 参数非法、路径越界 |
| 400 | `settings_invalid` / `invalid_config` / `invalid_patch` | 设置或运行配置非法（`ConfigError`） |
| 400 | `invalid_message` / `invalid_scope` / `empty_code` | 消息/内核作用域/代码为空 |
| 400 | `workspace_invalid` / `workspace_not_local` / `workspace_delete_refused` | 工作区参数非法、非本地工作区不接受本地文件操作、默认或使用中的工作区不能删除 |
| 400 | `invalid_packages` / `invalid_request` | 注册表刷新包列表或请求体格式非法 |
| 401/403 | `unauthorized` / `forbidden` | 未配置 LLM 或缺少密钥 |
| 404 | `not_found` | 会话/文件/任务/技能等通用对象不存在 |
| 404 | `run_not_found` / `session_not_found` / `trajectory_missing` | 运行、会话、轨迹不存在 |
| 404 | `workspace_not_found` / `approval_not_found` / `task_not_found` | 工作区、审批、子任务不存在 |
| 404 | `registry_missing` / `discovery_not_found` / `file_not_found` / `invalid_scope` | 函数索引项、发现项目、远端文件、内核作用域不存在 |
| 409 | `run_in_progress` / `run_finished` | 同一会话已有活跃运行；对已结束的运行发取消/steering |
| 409 | `discovery_running` | 发现项目正在运行，不能重复启动或删除 |
| 409 | `conflict` | 同名冲突、会话正在运行（旧入口兼容） |
| 413 | `too_large` / `file_too_large` | 上传或写入超限（基础上限 200 MB） |
| 422 | `validation_error` | 请求参数不合法（`detail` 保留前 5 条字段错误） |
| 500 | `internal_error` | 未预期异常（看 `~/.omicslab/logs/server.log`） |
| 500 | `settings_error` / `submit_failed` / `workspace_create_failed` | 设置保存、提交运行、创建工作区失败 |
| 500 | `kernel_start_failed` / `kernel_restart_failed` / `kernel_vars_failed` | 指定作用域的内核启动/重启/取变量失败 |
| 500 | `registry_failed` / `discovery_failed` / `trajectory_failed` | 索引构建、发现引擎、轨迹读取失败 |
| 502 | `ssh_error` | SSH 连接或远端操作失败（见 §15） |
| 504 | `registry_timeout` | 函数索引构建超时（> 300 s） |

> 运行类错误还会在运行的终态里体现：`run.error.code` 可能是 `config_error`、`llm_error`、`cancel_timeout`、`budget_exhausted` 等（见 §16.4）。

### 0.3 健康检查（排障第一步）

```bash
curl -s http://127.0.0.1:5077/api/health
```

```json
{
  "ok": true,
  "version": "1.2.0",
  "kernel": {"running": true},
  "kernels": {"main": {"running": true}},
  "llm": {
    "configured": true,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "error": null
  },
  "vision": {"configured": false, "model": ""},
  "workspace": "D:\\data\\pbmc",
  "workspaces_count": 1,
  "runs": {"active": 0, "recovered": 1},
  "runtime": {
    "schema_version": 3,
    "db": "C:\\Users\\me\\.omicslab\\runtime\\events.db"
  },
  "startup_error": null,
  "uptime_s": 128.4
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | bool | 服务可用 |
| `version` | string | 版本号（当前 `1.2.0`，来自安装包元数据） |
| `kernel.running` | bool | 默认（`main`）作用域内核是否在运行 |
| `kernels` | object | 所有已登记作用域的内核状态，键为 `main` 或 `ws:<workspace_id>`（见 §17.2） |
| `llm.configured` | bool | 是否解析出可用的 LLM 配置（`mock` provider 恒为 `true`） |
| `llm.provider` / `llm.model` | string | 当前生效的 provider 与模型 |
| `llm.error` | string \| null | 未配置/配置无效时的可操作错误说明；正常为 `null` |
| `vision.configured` / `vision.model` | bool / string | 视觉模型是否可用、使用的模型名 |
| `workspace` | string | 默认工作区绝对路径 |
| `workspaces_count` | int | 已登记的工作区数量 |
| `runs.active` | int | 本进程内活跃运行数（`queued`/`preparing`/`running`/`waiting_approval`/`stopping`） |
| `runs.recovered` | int | 启动时被判定为 `interrupted` 的遗留运行数 |
| `runtime.schema_version` | int | 运行数据库 schema 版本（当前 `3`） |
| `runtime.db` | string | 运行数据库绝对路径（SQLite WAL） |
| `startup_error` | string \| null | 启动期非致命错误（如内核启动失败），正常为 `null` |
| `uptime_s` | number | 服务运行秒数 |

需要更细的排障信息时：

```bash
curl -s http://127.0.0.1:5077/api/runtime/diagnostics
# {"version":"1.2.0","pid":12345,"startup_error":null,"recovered_runs":[...],
#  "kernels":{...},"runtime":{"schema_version":3,"db":"...","log_path":"..."},
#  "workspaces":[{"workspace_id":"ws_main","backend":"local","status":"idle"}],"log_tail":"..."}
```

`GET /api/runtime/diagnostics` 返回版本、PID、内核与工作区状态、最近恢复的运行以及日志尾部（默认 8000 字符），适合打包进 Issue。

前端轮询或 SSE 重连排障时，还可以打一个极轻量心跳：

```bash
curl -s http://127.0.0.1:5077/api/events/ping
# {"ok":true,"ts":36412.8}
```

`ts` 是服务端事件循环时钟（秒），只用于确认服务没有卡死，不是 Unix 时间戳。

---

## 1. 会话（Conversations）

### 1.1 端点一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/conversations` | 列出会话摘要（按 `updated_at` 倒序） |
| `POST` | `/api/conversations` | 新建会话 |
| `GET` | `/api/conversations/{id}` | 获取会话（含消息） |
| `PATCH` | `/api/conversations/{id}` | 重命名 |
| `DELETE` | `/api/conversations/{id}` | 删除会话 |

### 1.2 对象结构

**Conversation（摘要）**

```json
{
  "id": "c_9f3a2b7c1d4e",
  "title": "PBMC 质控与聚类",
  "agent": "lead",
  "created_at": 1761181200.12,
  "updated_at": 1761181380.55,
  "message_count": 12
}
```

**Conversation（详情）** 额外包含 `messages` 与 `meta`：

```json
{
  "id": "c_9f3a2b7c1d4e",
  "title": "PBMC 质控与聚类",
  "agent": "lead",
  "created_at": 1761181200.12,
  "updated_at": 1761181380.55,
  "messages": [
    {
      "id": "m_1a2b3c4d5e6f",
      "role": "user",
      "content": "把 data/pbmc.h5ad 做质控并聚类",
      "ts": 1761181201.0
    },
    {
      "id": "m_7a8b9c0d1e2f",
      "role": "assistant",
      "content": "先看一下数据规模。",
      "ts": 1761181202.4,
      "tool_calls": [
        {"id": "call_abc", "name": "run_python_code", "arguments": {"code": "adata.shape"}}
      ]
    },
    {
      "id": "m_3c4d5e6f7a8b",
      "role": "tool",
      "name": "run_python_code",
      "tool_call_id": "call_abc",
      "content": "(2700, 32738)",
      "ts": 1761181203.1
    }
  ],
  "meta": {}
}
```

**Message 字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | 消息 id，`m_` 前缀 |
| `role` | string | `user` / `assistant` / `system` / `tool` / `error` |
| `content` | string | 文本内容 |
| `ts` | number | 时间戳 |
| `tool_calls` | array? | 仅 assistant：`[{id,name,arguments}]` |
| `tool_call_id` | string? | 仅 tool：对应的调用 id |
| `name` | string? | 仅 tool：工具名 |
| `figures` | array? | 该消息关联的图表 `[{name,url,title}]` |
| `meta` | object? | 扩展元数据 |

### 1.3 创建会话

```bash
curl -s -X POST http://127.0.0.1:5077/api/conversations \
  -H "Content-Type: application/json" \
  -d '{"agent": "lead", "title": "新会话"}'
```

请求体（均可选）：

```json
{"agent": "lead", "title": "新会话"}
```

返回 `200` + 完整的 `Conversation`（含 `messages: []` 与 `meta: {}`）。列表接口 `GET /api/conversations` 返回 `{"conversations": [ConversationSummary, ...]}`。

### 1.4 重命名 / 删除

```bash
curl -s -X PATCH http://127.0.0.1:5077/api/conversations/c_9f3a2b7c1d4e \
  -H "Content-Type: application/json" -d '{"title": "PBMC 分析（第二版）"}'

curl -s -X DELETE http://127.0.0.1:5077/api/conversations/c_9f3a2b7c1d4e
# {"ok": true}
```

---

## 2. 对话（SSE 流式）

从 1.2.0 起，每次对话都会先创建一个**持久化运行（run）**再流式输出：run 与事件落 SQLite，断线后可重放，同一会话同时只允许一个顶层运行（幂等键保护重复提交）。本节只讲对话入口；run 的完整状态机、时间线、子任务与取消语义见 §16。

### 2.1 发起对话

```text
POST /api/chat
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "conversation_id": null,
  "message": "把 data/pbmc.h5ad 做质控并聚类",
  "agent": "lead",
  "provider": null,
  "model": null,
  "workspace_id": null,
  "client_request_id": null,
  "attachments": [{"path": "data/pbmc.h5ad", "name": "pbmc.h5ad"}]
}
```

| 字段 | 必填 | 说明 |
|---|:---:|---|
| `message` | ✅ | 用户输入（无 `message` 且无 `attachments` 时 400 `invalid_message`） |
| `conversation_id` | ❌ | 为 `null` 时自动新建会话；响应首帧里会返回 `conversation_id`/`session_id` |
| `agent` | ❌ | Agent id，默认取设置中的 `default_agent`（出厂 `lead`） |
| `provider` / `model` | ❌ | 本回合临时覆盖 LLM 设置；`null` 用全局配置 |
| `workspace_id` | ❌ | 指定工作区；缺省用会话绑定的工作区（新会话自动绑定默认工作区） |
| `client_request_id` | ❌ | 幂等键：同一个 id 重复提交（如网络重试）会直接返回**已存在**的 run，不会重复执行 |
| `attachments` | ❌ | 已上传到工作区的文件引用（`path` 为工作区相对路径） |

响应为 `200` + `text/event-stream`。首帧为 `connected`，`data` 里带本轮全部标识：

```json
{
  "type": "connected",
  "data": {
    "conversation_id": "c_9f3a2b7c1d4e",
    "session_id": "c_9f3a2b7c1d4e",
    "run_id": "run_7ac1d2e3f401",
    "trace_id": "tr_1f0c9b8e7d",
    "message_id": "m_1a2b3c4d5e6f",
    "agent": "lead",
    "workspace": {"workspace_id": "ws_main", "backend": "local", "root": "D:\\data\\pbmc"},
    "idempotent": false,
    "ts": 1761181201.52
  }
}
```

同一会话已有活跃运行时返回 `409`（`run_in_progress`），`detail` 带正在运行的 `run_id`；前端可据此改为订阅已有运行（§2.3）。会话不存在返回 `404`（`session_not_found`）。

### 2.2 流重放：断线后继续看

```bash
# 订阅（或重连）某个运行的事件流，从 seq=0 开始重放全部历史
curl -N "http://127.0.0.1:5077/api/runs/run_7ac1d2e3f401/stream?after_seq=0"
```

- 连接建立后先回放数据库里 `seq > after_seq` 的事件，再实时广播；
- 空闲时每 **15 秒**发一个 `heartbeat` 帧（前端可据此判断连接是否还活着，并丢弃迟到的重复帧）；
- 历史事件超过 5000 条时先发 `stream_gap`（带 `next_seq`），提示从该序号继续拉取；
- 运行已结束且事件发完时发 `stream_end`；
- 断流**不会**取消运行——这是本版本相对 1.1.0 的关键行为变化。

运行快照（不含流）：

```bash
curl -s http://127.0.0.1:5077/api/runs/run_7ac1d2e3f401
# {"run_id":"run_...","trace_id":"tr_...","session_id":"c_...","status":"succeeded",
#  "finish_reason":"stop","usage":{...},"result_text":"...","children":[],"approvals":[],
#  "actions":{"cancel":false}, ...}
```

字段表见 §16.2。

### 2.3 会话内运行列表 / 不阻塞提交

```bash
# 某会话的最近运行（按创建时间倒序，limit 1–200，默认 50）
curl -s "http://127.0.0.1:5077/api/sessions/c_9f3a2b7c1d4e/runs?limit=20"

# 只创建运行、不打开 SSE，拿到 stream_url 后再订阅（适合后台任务/移动端）
curl -s -X POST http://127.0.0.1:5077/api/sessions/c_9f3a2b7c1d4e/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"跑一下 QC","client_request_id":"req-2026-001"}'
# {"run":{...},"run_id":"run_...","trace_id":"tr_...","session_id":"c_...",
#  "idempotent":false,"stream_url":"/api/runs/run_.../stream"}
```

### 2.4 停止与取消

```bash
# 兼容旧入口：按会话/运行停止（内部转成 RunService.cancel）
curl -s -X POST http://127.0.0.1:5077/api/chat/stop \
  -H "Content-Type: application/json" -d '{"conversation_id": "c_9f3a2b7c1d4e"}'
# {"ok": true, "stopped": true, "run_id": "run_...", "status": "stopping"}

# 精确取消某个运行（推荐）
curl -s -X POST http://127.0.0.1:5077/api/runs/run_7ac1d2e3f401/cancel
# {"ok": true, "status": "stopping", "run": {...}}
```

取消语义：只取消**这个运行及其子任务子树**（不会误伤同会话其他工作区或其它会话），按工作区作用域中断内核中正在执行的代码，取消该运行的待审批请求；`stopping` 是中间态，15 秒内未退出会被标记为 `interrupted`。对已结束的运行取消返回 `409`（`run_finished`），运行不存在返回 `404`（`run_not_found`）。旧入口在没有可停止的运行时不报错，返回 `{"ok":false,"stopped":false,...}`。

### 2.5 Steering：运行中追加指令

运行进行中可以向模型追加一句用户消息（不打断当前工具调用，在下一步注入）：

```bash
curl -s -X POST http://127.0.0.1:5077/api/runs/run_7ac1d2e3f401/messages \
  -H "Content-Type: application/json" -d '{"content": "顺便检查线粒体基因比例"}'
# {"ok": true, "status": "running", "seq": 42}
```

空内容 400（`invalid_message`）；运行不存在 404；已结束 409（`run_finished`）。

### 2.6 审批中心

当 `approval_policy = "ask"` 且工具需要审批时，SSE 会推送 `approval_request` 事件；审批与运行绑定，刷新页面后可恢复：

```bash
# 待审批（可按运行筛；status=pending 时 pending 与持久化记录一起返回 policy）
curl -s "http://127.0.0.1:5077/api/approvals?status=pending"
# {"pending":[{"id":"appr_x1y2z3","run_id":"run_...","task_id":null,"tool":"run_shell",
#   "arguments":{...},"reason":"...","target":{"kind":"local","root":"D:\\data\\pbmc"},
#   "expires_at":1761181320.0,"created_at":"2026-10-23T06:20:00+00:00"}],
#  "persisted":[...],"policy":"ask"}

# 决定
curl -s -X POST http://127.0.0.1:5077/api/approvals/appr_x1y2z3 \
  -H "Content-Type: application/json" -d '{"decision": "approve"}'
# {"ok": true, "approval_id": "appr_x1y2z3", "approved": true}

# 单条详情（刷新后恢复弹窗）
curl -s http://127.0.0.1:5077/api/approvals/appr_x1y2z3
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `decision` | `approve` / `deny` | 允许或拒绝；接受 `approve/approved/yes/true/allow/1/同意` 等写法，其他一律视为拒绝 |

审批不存在或已处理返回 `404`（`approval_not_found`）。审批器固定超时为 120 秒，等待超时会自动拒绝。审批通过/拒绝都会写回运行数据库，并在运行流上发 `approval_resolved` 事件。

### 2.7 轨迹事件回放

```bash
# 等价于 /api/runtime/timeline/{trace_id}，返回 {trace_id, run, events, next_seq, max_seq}
curl -s "http://127.0.0.1:5077/api/traces/tr_1f0c9b8e7d/events?after_seq=0&limit=200"
```

### 2.8 子任务与委派

父运行把任务委派给子智能体时，会在父轨迹上发 `child_run` 事件；结果通过子运行与子任务记录查询：

```bash
curl -s http://127.0.0.1:5077/api/runs/run_7ac1d2e3f401/children
# {"run_id":"run_...","children":[{"task_id":"task_...","run_id":"run_...","profile":"data-critic",
#   "status":"succeeded","goal":"核对 QC 阈值","result":{...}}],"count":1}

curl -s http://127.0.0.1:5077/api/agent-tasks/task_9b8c7d6e5f4a
# {"task_id":"...","parent_run_id":"run_...","run_id":"run_...","profile":"data-critic",
#  "status":"succeeded","goal":"...","budget":{"max_iterations":6,...},"result":{...},"position":0,...}

curl -s http://127.0.0.1:5077/api/agent-tasks/task_9b8c7d6e5f4a/runs
# {"task":{...},"runs":[{...}]}
```

子任务不存在返回 `404`（`task_not_found`）。子任务的并发/深度上限、预算与失败语义见 §16.5 与架构文档 §5.4。

---

## 3. SSE 聊天事件

每个事件是一行 `data: <json>`，以空行结束：

```text
data: {"type":"text","data":{"delta":"正在"},"ts":1761181203.9}

```

`ts` 为服务端生成事件的时间戳（float，Unix 秒）。运行流（`/api/chat`、`/api/runs/{id}/stream`、`/api/runtime/timeline/*`）的帧统一由 `RunService` 生成，在 `type`/`data`/`ts` 之外还带：

```json
{"type":"text","data":{"delta":"正在"},"ts":1761181203.9,
 "seq":42,"event_id":"ev_8a1b2c3d","run_id":"run_...","trace_id":"tr_...","session_id":"c_..."}
```

| 字段 | 说明 |
|---|---|
| `seq` | 轨迹内单调递增的事件序号；断线重连时用 `after_seq` 续传，客户端可按 `seq` 去重 |
| `event_id` | 事件唯一 id（同一条事件重放时不变） |
| `run_id` / `trace_id` / `session_id` | 该事件所属的运行、轨迹、会话 |

SSE 断线本身**不会**取消运行；重连用 `GET /api/runs/{run_id}/stream?after_seq=<最后收到的 seq>` 即可续上。**前端必须忽略未知 `type`。**

### 3.1 事件类型

| `type` | 主要字段 | 说明 |
|---|---|---|
| `connected` | `conversation_id`, `session_id`, `run_id`, `trace_id`, `message_id`, `agent`, `workspace`, `idempotent` | 流已建立；重放连接还会带 `status` 与 `resumed: true` |
| `status` | `text` | 阶段提示（「正在思考…」） |
| `text` | `delta` | 助手回复的文本增量 |
| `reasoning` | `delta` | 思维链增量（可空；不支持时不会有该事件） |
| `tool_call` | `id`, `name`, `arguments`, `agent`, `category` | 模型请求调用工具 |
| `tool_result` | `id`, `name`, `ok`, `preview`, `data`, `duration_ms` | 工具执行结果（`preview` 为前 2000 字符） |
| `approval_request` | `id`, `tool`, `arguments`, `reason`, `run_id`, `task_id`, `target`, `expires_at` | 需要用户审批 |
| `approval_resolved` | `id`, `approved`, `decided_at` | 审批已通过/被拒（可能来自另一个页面或超时自动拒绝） |
| `figure` | `name`, `url`, `title` | 生成了图表 |
| `usage` | `prompt_tokens`, `completion_tokens`, `total_tokens`, `model` | token 用量（可能多次或没有） |
| `run_status` | `status`, `recovered`（可选） | 运行状态变化：`preparing`/`running`/`waiting_approval`/`stopping`/`interrupted` 等 |
| `user_message` | `run_id`, `message_id`, `content`, `projected` | Steering 追加的用户消息（`projected:true`） |
| `child_run` | `task_id`, `child_run_id`, `child_trace_id`, `agent_id`, `depth`, `status`, `prompt_preview`, `parent_run_id`；结束时追加 `finish_reason`/`duration_ms`/`error`/`result_preview` | 子智能体任务的开始/结束摘要（父轨迹上） |
| `heartbeat` | —（空对象） | 空闲心跳，15 秒一次；用于判断连接存活 |
| `stream_gap` | `next_seq`, `limit` | 断线重放时历史事件超过上限（5000 条），提示从 `next_seq` 继续拉 |
| `stream_end` | `run_id`, `status` | 运行已结束且事件发完，可关闭连接 |
| `error` | `message`, `detail`, `retryable`, `code` | 错误；`retryable=true` 表示可重试 |
| `discovery` | `kind`, `project_id`, … | 仅发现项目运行流（`/api/discovery/projects/{id}/run`）使用；`kind` 见 [§12](#12-rsi-科研发现discovery) |
| `done` | `conversation_id`, `session_id`, `run_id`, `finish_reason`, `status`, `message_id` | 回合结束（`stop` / `cancelled` / `error` / `max_iterations` / `approvals`） |

### 3.2 完整示例

```text
data: {"type":"connected","data":{"conversation_id":"c_9f3a2b7c1d4e","session_id":"c_9f3a2b7c1d4e","run_id":"run_7ac1d2e3f401","trace_id":"tr_1f0c9b8e7d","message_id":"m_1a2b3c4d5e6f","agent":"lead","idempotent":false},"ts":1761181201.52,"seq":1}

data: {"type":"run_status","data":{"status":"running"},"ts":1761181201.53,"seq":2}

data: {"type":"status","data":{"text":"正在思考…"},"ts":1761181201.6,"seq":3}

data: {"type":"text","data":{"delta":"我先检查一下数据规模。"},"ts":1761181202.1,"seq":4}

data: {"type":"tool_call","data":{"id":"call_abc","name":"run_python_code","arguments":{"code":"adata.shape"},"agent":"lead","category":"python"},"ts":1761181202.3,"seq":5}

data: {"type":"tool_result","data":{"id":"call_abc","name":"run_python_code","ok":true,"preview":"(2700, 32738)","data":{"duration_ms":42,"execution_target":{"kind":"local","root":"D:\\data\\pbmc"}},"duration_ms":42},"ts":1761181202.36,"seq":6}

data: {"type":"figure","data":{"name":"fig_ab12.png","url":"/api/figures/fig_ab12.png","title":"UMAP"},"ts":1761181250.0,"seq":7}

data: {"type":"usage","data":{"prompt_tokens":5120,"completion_tokens":380,"total_tokens":5500,"model":"deepseek-chat"},"ts":1761181251.0,"seq":8}

data: {"type":"done","data":{"conversation_id":"c_9f3a2b7c1d4e","session_id":"c_9f3a2b7c1d4e","run_id":"run_7ac1d2e3f401","finish_reason":"stop","status":"succeeded"},"ts":1761181251.1,"seq":9}
```

### 3.3 客户端示例（JavaScript）

```javascript
const res = await fetch("/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
  body: JSON.stringify({ message: "adata.shape", agent: "lead" }),
});

const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = "";

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const chunks = buffer.split("\n\n");
  buffer = chunks.pop() ?? "";
  for (const chunk of chunks) {
    const line = chunk.split("\n").find((l) => l.startsWith("data: "));
    if (!line) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === "text") appendText(event.data.delta);
    else if (event.type === "figure") addFigure(event.data);
    else if (event.type === "done") break;
  }
}
```

断线重连：记录最后一条事件的 `seq`，用指数退避（1s → 2s → 4s …，上限 30s）重新请求 `/api/runs/{run_id}/stream?after_seq=<seq>`；若 `connected` 帧带 `resumed: true`，说明是从持久化轨迹续传，不需要重新拉取整段会话。收到 `heartbeat` 只更新「连接存活」状态，不追加消息。运行结束后服务端会发 `stream_end`，前端应关闭连接并刷新运行快照（`GET /api/runs/{run_id}`）。

---

## 4. 内核（Kernel）

共享 IPython 内核。所有回合共用同一个内核，变量跨请求存在。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/kernel/status` | 内核运行状态 |
| `POST` | `/api/kernel/execute` | 执行代码 |
| `POST` | `/api/kernel/restart` | 重启内核（清空变量） |
| `POST` | `/api/kernel/interrupt` | 中断当前执行 |
| `GET` | `/api/kernel/vars` | 变量列表 |
| `GET` | `/api/kernel/var_detail?name=adata` | 单变量详情 |

### 4.1 状态

```bash
curl -s http://127.0.0.1:5077/api/kernel/status
```

```json
{
  "running": true,
  "python": "C:\\...\\.venv\\Scripts\\python.exe",
  "pid": 12345,
  "started_at": 1761180000.0,
  "kernel_name": "omicslab",
  "execution_count": 7,
  "boot_error": null
}
```

内核是懒启动的：第一次执行代码时才启动（首次调用会多等几秒）。`boot_error` 记录上次启动失败的原始错误，便于排障；`python` 是 `resolve_kernel_python()` 解析出来的解释器路径。

### 4.2 执行

```bash
curl -s -X POST http://127.0.0.1:5077/api/kernel/execute \
  -H "Content-Type: application/json" \
  -d '{"code":"print(adata.shape)","timeout_s":120}'
```

```json
{
  "ok": true,
  "outputs": [
    {"type": "stream", "name": "stdout", "text": "(2700, 32738)\n"}
  ],
  "figures": [],
  "duration_ms": 42,
  "error": null,
  "execution_count": 8,
  "interrupted": false
}
```

| 输出 `type` | 字段 | 说明 |
|---|---|---|
| `stream` | `name`（`stdout`/`stderr`）, `text` | print 输出 |
| `result` | `text` | 表达式结果（`execute_result`） |
| `display` | `text` | `display_data` 的文本表示（HTML 会截断） |
| `image` | `url` | 内核捕获的图片（已存到 figures，同时追加到 `figures` 数组） |
| `error` | `ename`, `evalue`, `traceback` | 异常 |

失败或超时时 `ok: false`，`error` 为说明文本，`outputs` 保留已产生的部分；超时（`timeout_s`，默认取 `kernel_timeout_s=180`）会尝试中断内核并把 `interrupted` 置为 `true`。

> `POST /api/kernel/execute` 与 agent 的工具 `run_python_code` 共用同一个内核和同一把执行锁：agent 正在跑长代码时，手动执行会排队等待。

### 4.3 变量浏览器

```bash
curl -s http://127.0.0.1:5077/api/kernel/vars
```

```json
{
  "running": true,
  "vars": [
    {
      "name": "adata",
      "type": "AnnData",
      "repr": "AnnData object with n_obs × n_vars = 2700 × 32738",
      "shape": [2700, 32738],
      "size_bytes": 104857600,
      "is_dataframe": false,
      "is_anndata": true,
      "is_array": false
    }
  ]
}
```

内核未运行时返回 `{"running": false, "vars": []}`。列表只包含用户变量（跳过模块、`_` 开头与 IPython 内置名），按名字排序；`repr` 截断到 400 字符；`is_array` 表示该对象有 `shape` 与 `dtype`。

单变量详情：

```bash
curl -s "http://127.0.0.1:5077/api/kernel/var_detail?name=adata"
```

```json
{
  "name": "adata",
  "type": "AnnData",
  "repr": "AnnData object with n_obs × n_vars = 2700 × 32738",
  "shape": [2700, 32738],
  "size_bytes": 104857600,
  "is_dataframe": false,
  "is_anndata": true,
  "is_array": false,
  "obs_columns": ["sample", "leiden", "cell_type"],
  "var_columns": ["gene_ids", "highly_variable"],
  "n_obs": 2700,
  "n_vars": 32738
}
```

DataFrame 的详情会额外带 `columns` / `dtypes`（各截断到 80 项）、`head`（前 12 行，`records` 形式）与 `describe`（`include="all"`；AnnData 跳过）；变量不存在时返回 `{"error": "变量不存在: adata"}`，内核未运行返回 `{"error": "内核未运行"}`。

### 4.4 多作用域内核（`/api/kernels/*`）

1.2.0 起内核按**工作区作用域**隔离：默认工作区用 `main`，其它工作区用 `ws:<workspace_id>`。每个作用域一个独立内核进程，变量互不可见。旧端点 `/api/kernel/*` 仍然可用，等价于对 `main` 作用域操作。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/kernels` | 所有已登记作用域的内核状态 |
| `POST` | `/api/kernels/{scope}/start` | 启动指定作用域内核（懒启动，通常不必手动调） |
| `POST` | `/api/kernels/{scope}/restart` | 重启并清空该作用域变量 |
| `POST` | `/api/kernels/{scope}/stop` | 停止该作用域内核（释放内存） |
| `POST` | `/api/kernels/{scope}/execute` | 在该作用域执行代码，body `{"code": "...", "timeout_s": 120}` |
| `GET` | `/api/kernels/{scope}/vars` | 该作用域变量列表 |

`scope` 接受三种写法并自动归一：`main`、`ws:<workspace_id>`、裸 `<workspace_id>`（等价 `ws:<id>`）。

```bash
# 列出所有作用域内核
curl -s http://127.0.0.1:5077/api/kernels
# {"kernels":{"main":{"running":true,...},"ws:ws_ab12cd34ef":{"running":false,...}}}

# 在某个工作区作用域里执行
curl -s -X POST http://127.0.0.1:5077/api/kernels/ws_ab12cd34ef/execute \
  -H "Content-Type: application/json" -d '{"code":"import scanpy as sc; print(sc.__version__)"}'
```

| HTTP | `code` | 场景 |
|---|---|---|
| 404 | `invalid_scope` | 作用域不存在（工作区已被删除） |
| 400 | `empty_code` | `code` 为空 |
| 500 | `kernel_start_failed` / `kernel_restart_failed` / `kernel_vars_failed` | 内核启动、重启或取变量失败 |

作用域数量受设置 `max_workspace_scopes`（默认 4）约束，空闲内核会按需回收；工作区删除时其作用域内核会被一并停止。详细的数据模型见 §17。

---

## 5. 文件（Files）

所有路径都是**工作区相对路径**；`..` 越界或绝对路径会返回 400 `invalid_path`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/files/tree?path=.` | 列目录 |
| `GET` | `/api/files/read?path=x.py&max_bytes=200000` | 读文本 |
| `GET` | `/api/files/raw?path=x.png` | 读二进制（图片等） |
| `POST` | `/api/files/upload` | 上传（multipart） |
| `POST` | `/api/files/write` | 写文本 |
| `POST` | `/api/files/mkdir` | 建目录 |
| `DELETE` | `/api/files?path=a.py` | 删除 |

### 5.1 目录树

```json
{
  "path": "data",
  "entries": [
    {"name": "pbmc.h5ad", "path": "data/pbmc.h5ad", "is_dir": false, "size": 52428800, "mtime": 1761180000.0, "ext": ".h5ad"},
    {"name": "raw", "path": "data/raw", "is_dir": true, "size": 0, "mtime": 1761179000.0, "ext": ""}
  ]
}
```

### 5.2 读取文本

```bash
curl -s "http://127.0.0.1:5077/api/files/read?path=analysis/qc.py&max_bytes=200000"
```

```json
{
  "path": "analysis/qc.py",
  "text": "import scanpy as sc\n...",
  "truncated": false,
  "binary": false,
  "mime": "text/plain",
  "size": 1234
}
```

二进制文件返回 `binary: true`、`text: ""`，请改用 `/api/files/raw`。

### 5.3 上传 / 写入 / 建目录 / 删除

```bash
# 上传到工作区 data/ 目录（同名文件自动重命名成 name_1.ext，不覆盖）
curl -s -X POST http://127.0.0.1:5077/api/files/upload \
  -F "file=@./local/counts.csv" -F "dir=data"
# {"path":"data/counts.csv","size":204800}

# 写文本（会覆盖，父目录自动创建）
curl -s -X POST http://127.0.0.1:5077/api/files/write \
  -H "Content-Type: application/json" \
  -d '{"path":"analysis/qc.py","content":"import scanpy as sc\n"}'
# {"ok":true,"path":"analysis/qc.py","size":21}

# 建目录
curl -s -X POST http://127.0.0.1:5077/api/files/mkdir \
  -H "Content-Type: application/json" -d '{"path":"results"}'
# {"ok":true,"path":"results"}

# 删除（目录会递归删除；不能删工作区根目录）
curl -s -X DELETE "http://127.0.0.1:5077/api/files?path=tmp/old.csv"
# {"ok":true,"path":"tmp/old.csv"}
```

上传单文件上限 200 MB，超出返回 `413`（`too_large`）；`read` 的 `max_bytes` 会被夹在 1 KiB 与 5 MB 之间。

---

## 6. 智能体 / 技能 / 记忆

### 6.1 智能体

```bash
curl -s http://127.0.0.1:5077/api/agents
```

```json
{
  "agents": [
    {
      "id": "lead",
      "name": "首席分析师",
      "description": "OmicsLab 默认入口：负责需求拆解、任务规划、计算执行与最终交付，必要时把子任务分派给领域专家智能体。",
      "category": "general",
      "source": "bundled",
      "toolsets": ["python", "files", "shell", "memory", "skills", "agents", "jobs", "notebook", "system"],
      "skills": [],
      "example_prompts": ["帮我看看这份单细胞数据的质量", "把这个分析整理成报告"],
      "tier": "bundled",
      "path": "omicslab/agents/lead.md"
    }
  ]
}
```

`source` / `tier` 说明来源层级（`bundled` 包内、`workspace` 工作区、`env` 由 `$OMICSLAB_TEMPLATES_DIR` 指定），`path` 是模板文件位置。

### 6.2 技能

```bash
curl -s http://127.0.0.1:5077/api/skills
```

```json
{
  "skills": [
    {
      "name": "single-cell-upstream",
      "description": "单细胞转录组上游流程：10x 及其他格式读取、QC 阈值、双细胞识别、归一化、HVG、PCA、批次整合选型、聚类与注释。",
      "when_to_use": "拿到原始或初步处理过的单细胞表达矩阵，需要从 QC 一路做到带注释的聚类结果时使用；也用于判断是否该整合、整合方法选型、复核已有上游流程的参数。",
      "source": "bundled",
      "path": "C:\\...\\omicslab\\skills\\single-cell-upstream\\SKILL.md"
    }
  ]
}
```

技能详情（含正文与脚本列表）：

```bash
curl -s http://127.0.0.1:5077/api/skills/single-cell-upstream
```

```json
{
  "name": "single-cell-upstream",
  "description": "单细胞转录组上游流程：10x 及其他格式读取、QC 阈值……",
  "when_to_use": "拿到原始或初步处理过的单细胞表达矩阵……",
  "body": "# 单细胞上游分析（single-cell-upstream）\n\n## 适用场景\n...",
  "files": ["scripts/qc.py"],
  "path": "C:\\...\\SKILL.md",
  "source": "bundled"
}
```

### 6.3 记忆

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/memory` | 列表 |
| `GET` | `/api/memory/{slug}` | 读取 |
| `PUT` | `/api/memory/{slug}` | 新建或覆盖 |
| `DELETE` | `/api/memory/{slug}` | 删除 |

```bash
# 列表
curl -s http://127.0.0.1:5077/api/memory
# {"items":[{"slug":"pbmc-data-dict","title":"PBMC 数据字典","updated_at":1761180000.0,"size":512}]}

# 写入
curl -s -X PUT http://127.0.0.1:5077/api/memory/pbmc-data-dict \
  -H "Content-Type: application/json" \
  -d '{"title":"PBMC 数据字典","body":"- data/raw/pbmc.h5ad: 10x v3, 8 samples"}'
# {"slug":"pbmc-data-dict","title":"PBMC 数据字典","body":"...","created_at":1761180000.0,"updated_at":1761180050.0,"size":64}
```

`GET` 单个记忆返回同样的完整对象（含 `body`），列表只返回 `slug` / `title` / `updated_at` / `size`。记忆 slug 必须匹配 `[A-Za-z0-9_-]{1,64}`；正文上限 64 KiB（超限返回 400 `memory_error`）。

---

## 7. 后台任务（Jobs）

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/jobs` | 提交任务 |
| `GET` | `/api/jobs` | 列表 |
| `GET` | `/api/jobs/{id}/log?offset=0` | 增量日志 |
| `POST` | `/api/jobs/{id}/cancel` | 取消 |

### 7.1 提交

```bash
curl -s -X POST http://127.0.0.1:5077/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"kind":"python","code":"import time\nfor i in range(10):\n    print(i); time.sleep(1)","name":"长任务示例"}'
```

```json
{
  "id": "j_5d6e7f8a9b0c",
  "name": "长任务示例",
  "kind": "python",
  "status": "running",
  "started_at": 1761181300.0,
  "ended_at": null,
  "exit_code": null,
  "log_bytes": 0
}
```

`kind` 取值：`python`（用内核同款解释器跑独立进程）或 `shell`（系统 shell）。任务在**工作区**目录下执行，日志写到 `~/.omicslab/jobs/<id>.log`。

### 7.2 增量日志

```bash
curl -s "http://127.0.0.1:5077/api/jobs/j_5d6e7f8a9b0c/log?offset=0"
```

```json
{"text": "0\n1\n2\n", "next_offset": 6, "eof": false}
```

轮询时把 `next_offset` 作为下一次的 `offset`；`eof: true` 表示任务已结束且日志读完。

### 7.3 取消

```bash
curl -s -X POST http://127.0.0.1:5077/api/jobs/j_5d6e7f8a9b0c/cancel
# {"ok":true}
```

---

## 8. 图表（Figures）

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/figures` | 列出图表 |
| `GET` | `/api/figures/{name}` | 取 PNG |
| `DELETE` | `/api/figures/{name}` | 删除 |

```bash
curl -s http://127.0.0.1:5077/api/figures
```

```json
{
  "figures": [
    {"name": "fig_ab12.png", "url": "/api/figures/fig_ab12.png", "size": 48210, "mtime": 1761181250.0}
  ]
}
```

图表由内核自动捕获（matplotlib 图在单元格结束时保存），保存在 `~/.omicslab/figures/`。

---

## 9. 设置与系统

### 9.1 读取设置（永不 500）

```bash
curl -s http://127.0.0.1:5077/api/settings
```

```json
{
  "settings": {
    "workspace": "D:\\data\\pbmc",
    "home": "C:\\Users\\me\\.omicslab",
    "host": "127.0.0.1",
    "port": 5077,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "api_base": "",
    "temperature": 0.0,
    "max_tokens": 0,
    "max_iterations": 24,
    "request_timeout_s": 180,
    "kernel_python": "",
    "kernel_timeout_s": 180,
    "shell_timeout_s": 120,
    "approval_policy": "auto",
    "allow_shell": true,
    "allow_file_write": true,
    "sandbox_root_only": true,
    "ui": {},
    "default_agent": "lead",
    "language": "zh",
    "vision_model": "",
    "vision_base_url": "",
    "vision_enabled": true,
    "max_child_tasks": 4,
    "max_child_depth": 2,
    "max_workspace_scopes": 4,
    "max_parallel_runs": 8
  },
  "llm": {
    "configured": true,
    "provider": "deepseek",
    "model": "deepseek-chat",
    "family": "openai",
    "api_base": "https://api.deepseek.com/v1",
    "label": "DeepSeek",
    "has_key": true,
    "error": null
  },
  "vision": {
    "enabled": true,
    "model": "",
    "base_url": "",
    "has_key": false,
    "configured": false,
    "error": "未配置视觉模型 API Key：请在设置页“视觉模型”卡片填写，或设置环境变量 VISION_API_KEY。"
  },
  "providers": {
    "deepseek": {
      "id": "deepseek",
      "label": "DeepSeek",
      "family": "openai",
      "api_base": "https://api.deepseek.com/v1",
      "default_model": "deepseek-chat",
      "models": ["deepseek-chat", "deepseek-reasoner"],
      "env_key": "DEEPSEEK_API_KEY",
      "has_key": true,
      "no_key_required": false,
      "needs_api_base": false,
      "needs_model": false,
      "configured": true,
      "hint": ""
    },
    "ark": {
      "id": "ark",
      "label": "火山方舟 (Volcengine Ark)",
      "family": "openai",
      "api_base": "https://ark.cn-beijing.volces.com/api/v3",
      "default_model": "",
      "models": [],
      "env_key": "ARK_API_KEY",
      "has_key": false,
      "no_key_required": false,
      "needs_api_base": false,
      "needs_model": true,
      "configured": false,
      "hint": "在火山方舟控制台创建推理接入点（ep-...）或使用模型 ID，填入模型名；Key 形如 ark-xxxx。"
    }
  }
}
```

`providers` 是 **map（provider id → 对象）**，覆盖全部 13 个真实 Provider 与离线测试用的 `mock`。对象字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `label` | string | provider id 与显示名 |
| `family` | string | `openai` / `anthropic` / `mock`，决定线协议 |
| `api_base` | string | 预填 API 地址（切换 provider 时前端直接使用） |
| `default_model` / `models` | string / string[] | 默认模型与可选模型建议 |
| `env_key` | string | 存放 Key 的环境变量名 |
| `has_key` | bool | 该 provider 的 Key 是否已配置 |
| `no_key_required` | bool | 是否免 Key（`mock`） |
| `needs_api_base` / `needs_model` | bool | 前端必须补填地址/模型才能使用 |
| `configured` | bool | 当前是否可直接发起请求 |
| `hint` | string | 可操作提示（如火山方舟接入点说明） |

`settings` 只包含**公开字段**；`llm` 是解析后的生效端点（`api_base` 已按 provider 规则补全，`configured` 表示可以发起请求）；`has_key` 是布尔值，**明文 Key 永不出现在响应里**。

设置读取**永不返回 500**：配置不完整时 `llm.configured=false`、`llm.error` 给出可操作中文建议（缺少 Key、缺少 API 地址、选中的 provider 未知等），设置页据此渲染红色提示条，而不是整页空白。

### 9.2 修改设置

```bash
curl -s -X PUT http://127.0.0.1:5077/api/settings \
  -H "Content-Type: application/json" \
  -d '{"patch": {"provider": "qwen", "model": "qwen-plus", "approval_policy": "ask"}}'
```

返回结构同 `GET /api/settings`。也可以省略 `patch` 直接发扁平对象。允许的 key：`provider`、`model`、`api_base`、`temperature`、`max_tokens`、`max_iterations`、`request_timeout_s`、`vision_model`、`vision_base_url`、`vision_enabled`、`kernel_python`、`kernel_timeout_s`、`shell_timeout_s`、`approval_policy`、`allow_shell`、`allow_file_write`、`sandbox_root_only`、`max_child_tasks`、`max_child_depth`、`max_workspace_scopes`、`max_parallel_runs`、`default_agent`、`language`、`host`、`port`、`workspace`、`ui`（`ui` 为浅合并）。未知 key 被忽略。

其中四个并发/预算字段也提供了更贴近运行时的入口 `GET/PUT /api/runtime/config`（见 §16.6）：

| 字段 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `max_parallel_runs` | 8 | 1–64 | 同时执行的运行数上限 |
| `max_child_tasks` | 4 | 1–16 | 每个父运行可创建的子任务数上限 |
| `max_child_depth` | 2 | 1–4 | 子智能体嵌套深度上限 |
| `max_workspace_scopes` | 4 | 1–16 | 同时存在的内核作用域上限 |

保存失败的错误码：

| HTTP | code | 场景 |
|---|---|---|
| 200 | — | 保存成功（返回最新 `/api/settings` 结构） |
| 400 | `settings_invalid` | 字段类型/取值非法（`ConfigError`，如 provider 不是字符串） |
| 500 | `settings_error` | 写盘失败等未预期错误 |

`host` / `port` / `workspace` 的改动需要重启服务才生效；保存后审批策略**原地生效**（不重建审批器实例），正在等待的审批不会因此丢失。

### 9.3 写入 Key（原子保存）与测试连接

设置页「保存并测试」只调用下面两个端点。**Key 与它所属的 provider/model/api_base 必须在一次请求里落盘**，否则会出现「Key 写了但配置没生效」：

```bash
# 1) 原子保存
curl -s -X POST http://127.0.0.1:5077/api/settings/keys \
  -H "Content-Type: application/json" \
  -d '{"key": "sk-...", "provider": "deepseek", "model": "deepseek-chat", "api_base": ""}'
```

```json
{
  "ok": true,
  "saved_keys": ["DEEPSEEK_API_KEY"],
  "settings": { "...": "同 9.1" },
  "llm": {"configured": true, "provider": "deepseek", "model": "deepseek-chat", "error": null},
  "vision": {"configured": false, "model": "", "error": "..."}
}
```

请求体字段：

| 字段 | 说明 |
|---|---|
| `key` | 选中 provider 的 env_key 捷径（与 `provider` 一起提交） |
| `keys` | 显式多 Key 映射（优先于 `key`），如 `{"DEEPSEEK_API_KEY": "sk-..."}` |
| `provider` / `model` / `api_base` | 可选；给了就一并写入 `settings.json`（空字符串不覆盖） |
| `vision_api_key` | 可选；写入 `auth.json` 的 `VISION_API_KEY` |

Key 值为空字符串表示**删除**该 Key；没有任何可保存内容时返回 400 `bad_request`。旧的扁平写法 `{"DEEPSEEK_API_KEY": "sk-..."}` 仍然可用。

```bash
# 2) 真实连通性测试：支持内联传入尚未保存的配置
curl -s -X POST http://127.0.0.1:5077/api/settings/test_llm \
  -H "Content-Type: application/json" \
  -d '{"provider": "ark", "model": "ep-2025xxxx", "api_base": "https://ark.cn-beijing.volces.com/api/v3", "api_key": "ark-..."}'
# {"ok":true,"latency_ms":812,"reply":"pong","error":null,"provider":"ark","model":"ep-2025xxxx"}
```

- 四个字段全部可选；缺省使用已保存配置（Key 来自 `auth.json` / 环境变量 / provider fallback）。
- 服务端会**真实发起一次极小 chat**（`max_tokens=24`，要求模型回复 `pong`），不是只检查 Key 是否存在。
- 成功与失败都返回 HTTP `200`（便于前端直接展示错误原文）；失败时 `ok=false`，`error` 为可操作中文说明。

### 9.4 视觉模型配置

视觉模型使用独立配置（`vision_enabled` / `vision_model` / `vision_base_url` + `VISION_API_KEY`）与两个专用端点，详见 [§11 视觉模型](#11-视觉模型vision)。

### 9.5 系统信息

```bash
curl -s http://127.0.0.1:5077/api/system/info
```

```json
{
  "platform": "Windows",
  "platform_release": "10",
  "python": "3.11.9",
  "python_executable": "C:\\projects\\suwen\\.venv\\Scripts\\python.exe",
  "cwd": "C:\\projects\\suwen",
  "workspace": "D:\\data\\pbmc",
  "home": "C:\\Users\\me\\.omicslab",
  "cpu_count": 16,
  "version": "1.2.0",
  "kernel_python": "C:\\projects\\suwen\\.venv\\Scripts\\python.exe",
  "uptime_s": 128.4
}
```

### 9.6 终端 WebSocket

```text
WS /ws/terminal?profile_id=<可选的 SSH 档案 id>&cwd=<起始目录>&cols=100&rows=30
```

- 不带 `profile_id`：本机 shell（Windows 优先 `pwsh` → `powershell.exe` → `cmd.exe`；POSIX 用 `$SHELL` / `/bin/bash`）。
- 带 `profile_id`：远端真 PTY（paramiko `invoke_shell()`），支持窗口大小同步与 Ctrl+C；
  PTY 不可用时会发一条 `diagnostic`（`code=pty_fallback`）再降级。
- `cols` 夹在 20–500，`rows` 夹在 5–200。1.2.0 起终端与 REST/工具共享同一个
  `ConnectionService`（复用连接池与内存凭据）。

双向 JSON 消息：

| 方向 | 消息 | 说明 |
|---|---|---|
| 客户端 → 服务端 | `{"type":"input","data":"ls\r"}` | 键盘输入（含转义序列） |
| 客户端 → 服务端 | `{"type":"resize","cols":100,"rows":30}` | 终端尺寸（远端 PTY 生效；本机 shell 忽略） |
| 客户端 → 服务端 | `{"type":"close"}` / `{"type":"exit"}` | 主动结束 |
| 服务端 → 客户端 | `{"type":"output","data":"..."}` | 输出 |
| 服务端 → 客户端 | `{"type":"diagnostic","code":"...","message":"..."}` | 非致命诊断（`terminal_connect_failed` / `cwd_failed` / `channel_error` / `channel_send_failed` / `pty_fallback`） |
| 服务端 → 客户端 | `{"type":"exit","code":0}` | 进程/通道退出 |

无需额外依赖：本机终端用 `subprocess` 启动系统 shell，再通过 WebSocket 桥接 stdio；SSH 终端用 `paramiko`（核心依赖）。

---

## 10. 快速自检脚本

```bash
BASE=http://127.0.0.1:5077
curl -s $BASE/api/health | python -m json.tool
curl -s $BASE/api/agents | python -m json.tool | head -40
curl -s $BASE/api/skills | python -m json.tool | head -40
curl -s $BASE/api/kernel/status | python -m json.tool
```

1.2.0 新增面可这样快速确认：

```bash
# 运行与恢复：运行库版本、内核作用域、工作区后端、日志尾部（脱敏）
curl -s $BASE/api/runtime/diagnostics | python -m json.tool
# 工作区注册表与各作用域内核状态
curl -s $BASE/api/workspaces | python -m json.tool
curl -s $BASE/api/kernels | python -m json.tool
# 最近的运行（可按 session_id / status / parent_run_id 过滤）
curl -s "$BASE/api/runtime/runs?limit=10" | python -m json.tool
# 运行时并发/子任务上限（可 PUT 修改）
curl -s $BASE/api/runtime/config | python -m json.tool
```

若 `health.llm.configured` 为 `false`，按 [常见问题 Q5](FAQ.md) 设置 Key 后重试。

---

## 11. 视觉模型（Vision）

视觉模型与对话模型**独立配置**：对话模型可以只用文本模型，图像理解由
`omicslab/agent/vision.py` 的 `VisionClient` 完成。它同时支持两种线协议：

- **OpenAI 兼容**：`POST {base_url}/chat/completions`，图片以 `image_url` data URL 传入
  （OpenAI、DashScope 兼容模式的 qwen-vl、智谱、Moonshot、SiliconFlow、OpenRouter、Ollama、本地 vLLM 等）。
- **Anthropic**：`POST {base_url}/v1/messages`，图片以 base64 `image` block 传入；
  `base_url` 含 `anthropic` 即按此协议探测。

无 SDK 依赖（只用 `httpx`）；单图上限 **12MB**，按扩展名映射 MIME（png/jpg/jpeg/gif/webp/bmp/tif/tiff），
识别失败时回退 `image/png` / `image/jpeg`。

### 11.1 配置项与 Key 解析顺序

| 设置字段 | 默认 | 说明 |
|---|---|---|
| `vision_enabled` | `true` | 视觉开关；关闭后视为未配置 |
| `vision_model` | `""` | 模型名（如 `gpt-4o-mini`、`qwen-vl-plus`、`gemini-2.0-flash`） |
| `vision_base_url` | `""` | API 地址；有 Key 但为空时默认 `https://api.openai.com/v1` |
| `VISION_API_KEY` | — | 存于 `~/.omicslab/auth.json` 或环境变量 |

Key 解析顺序：`settings.vision_api_key`（若直接写在 settings 中）→ `auth.json` 的
`VISION_API_KEY` / `OMICSLAB_VISION_API_KEY` → 环境变量 → 最后回退 `OPENAI_API_KEY`。
`vision_model` 为空但有 Key 时默认 `gpt-4o-mini`。配置齐全但调用失败时，错误信息会带
「请检查模型名是否是多模态模型」等可操作提示。

### 11.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/settings/vision` | 保存视觉配置（`enabled` / `model` / `base_url` / 可选 `api_key`） |
| POST | `/api/settings/test_vision` | 用内置 32×32 PNG 真实发一次图片理解请求，返回延迟与回复 |

```bash
# 保存（api_key 写入 auth.json 的 VISION_API_KEY）
curl -s -X POST http://127.0.0.1:5077/api/settings/vision \
  -H "Content-Type: application/json" \
  -d '{"enabled": true, "model": "gpt-4o-mini", "base_url": "https://api.openai.com/v1", "api_key": "sk-..."}'
# {"ok": true, "vision": {"enabled": true, "model": "gpt-4o-mini", ..., "configured": true, "error": null}}

# 测试（字段全部可选，缺省用已保存配置）
curl -s -X POST http://127.0.0.1:5077/api/settings/test_vision \
  -H "Content-Type: application/json" \
  -d '{"model": "gpt-4o-mini", "api_key": "sk-..."}'
# {"ok":true,"latency_ms":1234,"reply":"红色","error":null}
```

`/api/settings/test_vision` 与 `test_llm` 一样：成功与失败都返回 HTTP `200`，
失败时 `ok=false` 且 `error` 为原始错误说明；返回 `reply` 截断到 300 字符。

### 11.3 `analyze_image` 工具

| 参数 | 必填 | 说明 |
|---|---|---|
| `path` | ✅ | 图片路径：工作区相对路径，或图库（`~/.omicslab/figures/`）文件名 |
| `question` | ❌ | 针对图片的问题；缺省要求模型描述图表/显微图像并解读数据含义 |

行为要点：

- 路径依次尝试：绝对/相对路径直接存在 → 工作区沙箱内解析 → 图库目录同名文件；越界路径被拒绝。
- 未配置视觉模型时返回友好错误（`ok=false`），提示去设置页「视觉模型」卡片填写，不会 500。
- 返回正文形如 `【视觉模型解读】<文件名>\n\n<描述>`，`data` 中带 `path` 与 `chars`。
- 工具集为 `vision`；`lead` 等智能体在 `toolsets` 中包含 `vision` 时即可调用。

聊天里的图片附件（`attachments: [{path, name}]`）会随消息发送并由后端保存到工作区，
用户消息末尾会附带「## 附件（已上传到工作区，可直接读取）」路径清单；
需要解读图片时，模型调用 `analyze_image`（而不是把二进制塞进文本模型）。

---

## 12. RSI 科研发现（Discovery）

「发现」项目把一次科研探索建模为**多轮闭环**，每轮固定 7 步，结果全部写入可审查的账本：

```text
观察（Observe）→ 假设（Hypothesize）→ 优先级排序（Prioritize，UCB1 选策略）
→ 预注册（Pre-register，先写预测/成功标准再执行）
→ 执行（Execute，真实内核 run_python_code）
→ 评估（Evaluate，启发式 + LLM critic → reward / 证据强度 / 假设状态）
→ 反思（Reflect，更新策略统计 + 生成新策略 + 洞察）
```

- 预注册在写账本之后才执行实验，避免 p-hacking；每轮结束重新计算策略 reward 与假设置信度。
- LLM 不可用时**自动降级为启发式模式**（结构化假设 + 真实 kernel 执行），不崩溃、不伪造数据。
- 达到 `max_rounds` 或 `budget_minutes` 预算后停止，并生成 Markdown 报告。

### 12.1 数据模型

| 实体 | 主要字段 |
|---|---|
| `Project` | `id`(`dp_`), `title`, `objective`, `domain`, `agent`, `data_hints[]`, `max_rounds`(默认 4，1–12), `budget_minutes`(默认 90，5–480), `status`(`idle/running/paused/done/failed/cancelled`), `current_round`, `rounds_count`, `summary`, `created_at`, `updated_at` |
| `Hypothesis` | `id`(`hy_`), `project_id`, `statement`, `rationale`, `prediction`, `test_plan`, `success_criteria`, `status`(`proposed/testing/supported/refuted/inconclusive`), `confidence`(0–1), `evidence_ids[]`, `round`, `parent_id`, `tags[]`, `source`, 时间戳 |
| `Evidence` | `id`(`ev_`), `project_id`, `hypothesis_id`, `kind`(`data/statistics/literature/experiment/critique`), `summary`, `code`, `result_excerpt`, `figures[]`, `strength`(`strong/moderate/weak`), `reproducibility`(`none/code_recorded/rerun_verified`), `analysis_result`(结构化数值结果或 `null`), `reproducible`(旧布尔视图，兼容字段), `round`, `created_at` |
| `Insight` | `id`(`in_`), `project_id`, `text`, `confidence`, `evidence_ids[]`, `round`, `created_at` |
| `Strategy` | `id`(`st_`), `project_id`, `name`, `description`, `prompt_hint`, `uses`, `successes`, `reward`(0–1), `lineage`(`st_*` 或 `null`), 时间戳 |
| `DiscoveryRound` | `id`(`rt_`), `project_id`, `index`, `strategy_id`, `hypothesis_id`, `plan`, `prediction`, `success_criteria`, `outcome`, `reward`, `reflection`, `started_at`, `ended_at`, `error` |

> 1.2.0 把原来的 `reproducible` 布尔值升级为三档 `reproducibility`；旧字段仍随响应返回，等价于 `reproducibility !== "none"`，前端不必立刻迁移。

#### 12.1.1 证据评估（EvidenceEvaluator）

1.2.0 起「证据是否支持假设」不再由模型自由裁量，而是由 `omicslab/discovery/evidence.py` 的 `EvidenceEvaluator` 按**预注册判据**判定：

- 只有通过 `discovery_record_analysis_result` 提交的**结构化结果**参与判决；`summary`/`result_excerpt` 里的文字叙述（包括「p<0.05」「显著」）**不参与**。
- 结构化结果的必需字段：`data_sha256`、`script_sha256`、`seed`、`test`、`effect_size`、`ci_low`、`ci_high`、`p_value`、`q_value_or_none`、`correction`、`method`、`sample_definition`、`exclusions`、`execution_status`、`artifact_refs`、`environment`。
- `execution_status` 取 `completed` / `failed` / `not_run`；**只有 `completed` 且数值合法**才可能得到 `supported` 或 `refuted`，否则一律 `inconclusive`。
- `verdict`：`supported` / `refuted` / `inconclusive`；`strength`：`strong` / `moderate` / `weak`；`reproducibility`：`none` / `code_recorded` / `rerun_verified`。
- 默认阈值：`alpha = q_alpha = 0.05`、强效应 `0.8`、中效应 `0.2`、强证据最小样本 `30`；预注册的 `success_criteria` 里的 `p < ...` 与最小效应声明会覆盖默认 alpha / 效应阈值。
- 评估结果附中文 `reasons[]` 作为审计轨迹，但 `reasons` 不参与判决。

### 12.2 落盘结构

```text
~/.omicslab/discovery/<project_id>/
├── project.json      # Project 记录
├── hypotheses.jsonl  # 追加写入的假设历史
├── evidence.jsonl    # 证据
├── insights.jsonl    # 洞察
├── rounds.jsonl      # 每轮记录（含 reflection）
├── strategies.json   # 策略库（原子重写）
└── report.md         # 报告（运行结束时生成，可重复读取）
```

JSONL 是追加写入的，保留完整历史与修订；`report.md` 是人类可读的 Markdown。

### 12.3 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/discovery/projects` | 列出项目（含 `status` / `rounds_count` / `updated_at` / `live`） |
| POST | `/api/discovery/projects` | 新建项目 |
| GET | `/api/discovery/projects/{id}` | 完整台账快照 + `report` + `live` |
| GET | `/api/discovery/projects/{id}/report` | 报告 Markdown（不存在时 `markdown` 为空串） |
| POST | `/api/discovery/projects/{id}/run` | **SSE** 运行闭环 |
| POST | `/api/discovery/projects/{id}/stop` | 取消运行中的项目 |
| DELETE | `/api/discovery/projects/{id}` | 删除项目（运行中返回 409） |

新建请求体：

```bash
curl -s -X POST http://127.0.0.1:5077/api/discovery/projects \
  -H "Content-Type: application/json" \
  -d '{"title": "PBMC 衰老差异", "objective": "检验老年组与青年组的单核细胞比例差异", "domain": "single-cell", "data_hints": ["data/pbmc.h5ad"], "max_rounds": 3, "budget_minutes": 30}'
# {"ok": true, "project": {"id": "dp_...", "status": "idle", "max_rounds": 3, ...}}
```

`objective` 必填，为空返回 400 `discovery_invalid`；`data_hints` 支持字符串（逗号/换行分隔）或数组；
`title` 为空时由后端补标题；`agent` 缺省用 `settings.default_agent`。

快照响应（`GET /api/discovery/projects/{id}`）：

```json
{
  "project": {"id": "dp_...", "status": "done", "rounds_count": 3, "...": "..."},
  "hypotheses": [{"id": "hy_...", "statement": "...", "status": "supported", "confidence": 0.72, "...": "..."}],
  "evidence": [{"id": "ev_...", "kind": "statistics", "strength": "moderate", "...": "..."}],
  "insights": [{"id": "in_...", "text": "...", "...": "..."}],
  "strategies": [{"id": "st_...", "name": "...", "uses": 2, "reward": 0.61, "lineage": null}],
  "rounds": [{"id": "rt_...", "index": 1, "reward": 0.55, "reflection": "...", "...": "..."}],
  "report": "# 发现报告 ...",
  "live": false
}
```

### 12.4 运行流（SSE）

```bash
curl -N -X POST http://127.0.0.1:5077/api/discovery/projects/dp_xxx/run
```

事件序列：`connected` → 若干 `discovery`（以及执行阶段的 `text` / `tool_call` / `figure`）→ `done`。
`done.data` 为 `{"project_id", "status"}`；同一项目并发运行返回 **409** `discovery_running`，
未知项目返回 **404** `discovery_not_found`。

`discovery` 事件的 `data.kind`：

| `kind` | 主要字段 | 时机 |
|---|---|---|
| `project` | `project`, `phase`(`start`/`done`), `status` | 运行开始/结束 |
| `status` | `text` | 阶段提示（如未配置 LLM、达到预算） |
| `round` | `index`, `round_id`, `plan`, `prediction`, `success_criteria`, `record` | 每轮预注册/评估 |
| `hypothesis` | `phase`, `round`, `hypothesis` | 假设确立/评估 |
| `evidence` | `round`, `evidence` | 新增证据 |
| `insight` | `round`, `insight` | 反思产出 |
| `strategy` | `strategy`, `phase`(`update`/`mutate`) | 策略统计更新/进化 |
| `reflection` | `round`, `reward`, … | 每轮反思结果 |
| `report` | `project_id`, `status`, `report`, `report_path`, `summary`, `error` | 报告生成 |
| `error` | `message` | 运行期错误（最终状态变为 `failed`） |
| `finished` | `project_id`, `result`(=`{status, rounds, report_path}`) | 引擎返回后、`done` 之前 |

### 12.5 工具与 CLI

| 工具 | 参数 | 说明 |
|---|---|---|
| `discovery_create_project` | `objective`(必填), `title`, `domain`, `data_hints`, `max_rounds`, `budget_minutes`, `agent` | 创建项目 |
| `discovery_list_projects` | `limit`(默认 20) | 列出项目 |
| `discovery_status` | `project_id` | 查看完整台账 |
| `discovery_run` | `project_id`, `max_rounds`(可选) | 运行闭环（长任务，进度以 discovery 事件推送） |
| `discovery_record_analysis_result` | `project_id`, `hypothesis_id`, 结构化结果字段（见 §12.1.1），其余放进 `payload`/`analysis_result` | **1.2.0 新增**：登记结构化数值结果，由 EvidenceEvaluator 判决；`data.analysis_result` 回显规范化结果，`data.errors` 列出字段错误 |
| `discovery_record_evidence` | `project_id`, `summary`(必填), `hypothesis_id`, `kind`, `strength`, `code`, `result_excerpt` | 手动记账（叙述性证据；`strength` 非法值会被归一） |
| `discovery_report` | `project_id` | 读取报告 |

`discovery_record_analysis_result` 不直接给出 `supported`/`refuted`：它只登记数值，判决发生在 `discovery_run` 的评估步骤，并在 `round`/`hypothesis` 事件里体现。工具集为 `discovery`，共 7 个。

```powershell
# CLI 等价操作（list 为默认动作）
.venv\Scripts\python.exe -m omicslab discovery list
.venv\Scripts\python.exe -m omicslab discovery create --objective "..." --data data\pbmc.h5ad --rounds 3
.venv\Scripts\python.exe -m omicslab discovery run --project dp_xxx
.venv\Scripts\python.exe -m omicslab discovery status --project dp_xxx
```

---

## 13. 函数注册表（Registry）

把已安装科学计算包的公开函数/类索引成可搜索的本地索引，避免模型凭记忆猜 API。
索引由**内核解释器子进程**内省生成（不污染服务进程），落盘在
`~/.omicslab/registry/index.json`；首次查询前可用刷新端点构建。

### 13.1 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/registry/search?q=&limit=` | 按关键词搜索（`limit` 1–50，默认 10） |
| GET | `/api/registry/modules` | 已索引模块列表 |
| GET | `/api/registry/function?name=` | 精确 qualname 详情 |
| POST | `/api/registry/refresh` | 重建索引（body `{"packages": ["numpy", ...]}` 可选） |

```bash
curl -s "http://127.0.0.1:5077/api/registry/search?q=BH%E6%A0%A1%E6%AD%A3&limit=5"
```

```json
{
  "items": [
    {
      "name": "multipletests",
      "qualname": "statsmodels.stats.multitest.multipletests",
      "module": "statsmodels.stats.multitest",
      "kind": "function",
      "signature": "(pvals, alpha=0.05, method='hs', maxiter=1, is_sorted=False, returnsorted=False)",
      "summary": "Test results and p-value correction for multiple tests",
      "package": "statsmodels",
      "package_version": "0.14.2",
      "docstring": "..."
    }
  ],
  "query": "BH校正",
  "ready": true,
  "stats": {
    "items": 4123,
    "modules": 23,
    "functions": 3510,
    "classes": 613,
    "generated_at": "2026-10-23T01:20:00+00:00",
    "missing_packages": ["rdkit", "omicverse"]
  }
}
```

- `ready=false` 表示索引尚未构建（`items` 为空），先调 `POST /api/registry/refresh`。
- `index.get()` 只匹配 `qualname`（大小写不敏感）；未命中返回 404 `registry_missing`。
- `refresh` 在请求内最多等待 **300s**，超时返回 504 `registry_timeout`；子进程失败返回
  500 `registry_failed`；`packages` 不是字符串数组返回 400 `invalid_packages`。
- 返回 `{"ok": true, "stats": {...}, "modules": [...]}`，`stats` 额外含
  `missing_packages` 与 `errors`。

### 13.2 默认扫描包

```text
numpy pandas scipy sklearn statsmodels matplotlib seaborn scanpy anndata omicverse
lifelines gseapy pydeseq2 flowio flowkit rdkit squidpy harmonypy bio(biopython)
plotly networkx umap leidenalg
```

未安装的包会被跳过并记入 `missing_packages`；每个包最多收录 520 个顶层条目。

### 13.3 工具

`registry_lookup(query, limit=8)`：按功能描述或函数名搜索，返回「函数名 + 签名 + 摘要 + 所属包/版本」；
索引不存在时会先自动构建一次。`limit` 上限 30。

---

## 14. 轨迹（Trajectories）

每个对话回合结束后，Agent 会把 meta、全部 `AgentEvent` 与 done 记录写成 JSONL，
用于审计模型行为、复现工具调用、给发现项目提供证据材料。轨迹写入失败**不影响**正常对话。

**`turn_id` 语义**：一次「用户发问 → 助手完成回复」为一个 turn，id 由服务端生成（`turn_` 前缀），
也是文件名（`<turn_id>.jsonl`）。同一会话多次提问会产生多个 turn 文件。

### 14.1 落盘结构

```text
~/.omicslab/trajectories/<conversation_id>/<turn_id>.jsonl
```

```jsonl
{"type":"meta","conversation_id":"c_...","turn_id":"turn_...","agent":"lead","provider":"deepseek","model":"deepseek-chat","started_at":"2026-10-23T01:20:00+00:00","ts":"...","workspace":"D:\\data"}
{"type":"event","event":{"type":"text","data":{"delta":"..."},"ts":...}}
{"type":"event","event":{"type":"done","data":{...},"ts":...}}
{"type":"done","turn_id":"turn_...","finish_reason":"stop","usage":{"prompt_tokens":5120,...},"error":"","events":12,"ended_at":"..."}
```

### 14.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/trajectories?conversation_id=` | 列出轨迹（省略会话 id 则列出全部），按修改时间倒序 |
| GET | `/api/trajectories/{conversation_id}/{turn_id}` | 回放一个回合 |
| DELETE | `/api/trajectories/{conversation_id}/{turn_id}` | 删除一个回合 |

```bash
curl -s "http://127.0.0.1:5077/api/trajectories?conversation_id=c_9f3a2b7c1d4e"
# {"items":[{"turn_id":"turn_...","conversation_id":"c_...","path":"C:\\Users\\me\\.omicslab\\trajectories\\c_...\\turn_....jsonl","size":8421,"mtime":1761181251.0,"finish_reason":"stop"}],"count":1}
```

详情响应：`{"turn_id", "conversation_id", "path", "size", "meta", "events", "done"}`；
不存在或 id 非法返回 404 `trajectory_missing`；删除成功返回 `{"ok": true, "deleted": turn_id}`。
`conversation_id` 与 `turn_id` 只接受 `[A-Za-z0-9_-]`、长度 ≤ 80，防止路径穿越。

---

## 15. SSH 远程算力

SSH 子系统把远端 Linux 主机变成可用的分析算力：连接档案、连通性测试、命令执行、
文件上传/下载、目录浏览与主机信息采集。后端使用 `paramiko`（同步实现，REST/工具层用
`asyncio.to_thread` 包装）。

1.2.0 的改动是**连接共享**：REST、工具、终端 WebSocket 与 SSH 执行后端统一走
`omicslab/ssh/connections.py` 的进程内单例 `ConnectionService`，同一条档案的多个入口复用同一个连接池与凭据；
密码等临时凭据放在进程内存储，不再各自持有。

> 说明：SSH 本地档案、参数校验、错误映射与工具注册有单元测试覆盖；**真实远端主机的端到端行为
> （网络、认证、PTY、远端 worker）未在本项目自动化测试中验证**，如遇问题请附 `GET /api/ssh/diagnostics`
> 的输出。开发者在 Linux 远端上的手工验证记录见 `CHANGELOG.md` 的已知限制说明。

### 15.1 档案与安全

档案存于 `~/.omicslab/ssh.json`：

```json
{
  "profiles": [
    {
      "id": "ssh_...",
      "name": "GPU 节点",
      "host": "10.0.0.12",
      "port": 22,
      "username": "bio",
      "auth": "password",
      "key_path": "",
      "password_saved": false,
      "password": "",
      "tags": ["gpu"],
      "created_at": "2026-10-23T01:20:00+00:00",
      "updated_at": "2026-10-23T01:20:00+00:00",
      "last_ok": true,
      "last_error": ""
    }
  ]
}
```

- 密码**默认不落盘**：普通连接只在进程内使用（`password_memory`），服务重启后需重新输入。
- 勾选「记住密码」（`remember_password=true` 或调用 `/remember`）时走**系统凭据库**（`keyring`）保存；
  系统没有可用凭据库时退化为**仅进程内存**，`GET /api/ssh/diagnostics` 的 `credentials.persistent=false`
  与 `message` 会明确提示「重启服务后需要重新输入」。持久凭据以 `credential_id` 引用，档案文件不存明文。
- **API 返回永不含密码与私钥内容**，只返回 `has_password_saved` 布尔值。
- 首次连接自动记录主机指纹到 `~/.omicslab/ssh_known_hosts.json`；后续指纹变化时
  `test` 返回中文 `warning`（而不是静默失败）。
- 上传/下载临时文件落在 `~/.omicslab/tmp/`，请求结束清理；单文件上限 **200MB**。

### 15.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ssh/profiles` | 列出档案（不含密码，`has_password_saved`） |
| POST | `/api/ssh/profiles` | 新增档案 |
| PATCH | `/api/ssh/profiles/{id}` | 更新档案字段 |
| DELETE | `/api/ssh/profiles/{id}` | 删除档案 |
| POST | `/api/ssh/profiles/{id}/test` | 连通性测试（body 可带临时 `password` / `remember`） |
| POST | `/api/ssh/test` | **1.2.0 新增**：用未保存的档案字段做连通性测试（body 可为 `{"profile": {...}}` 或扁平字段），不写入 `ssh.json` |
| POST | `/api/ssh/profiles/{id}/remember` | **1.2.0 新增**：把密码存入凭据库（body `{"password": "..."}`），返回不含密码的档案 |
| POST | `/api/ssh/exec` | 执行远端命令（`profile_id`、`command`；可选 `cwd`、`timeout_s`、`idempotent`） |
| GET | `/api/ssh/ls?profile_id=&path=` | 列远端目录 |
| GET | `/api/ssh/info?profile_id=` | 采集远端主机信息 |
| GET | `/api/ssh/diagnostics` | **1.2.0 新增**：连接池、凭据后端、最近 10 条命令 |
| POST | `/api/ssh/upload` | 上传（multipart：`file` + `profile_id` + `remote_path`） |
| GET | `/api/ssh/download?profile_id=&remote_path=` | 下载（FileResponse） |

```bash
# 新增档案
curl -s -X POST http://127.0.0.1:5077/api/ssh/profiles \
  -H "Content-Type: application/json" \
  -d '{"name":"GPU 节点","host":"10.0.0.12","port":22,"username":"bio","auth":"key","key_path":"C:\\keys\\id_rsa"}'
# {"profile": {"id": "ssh_...", "name": "GPU 节点", "has_password_saved": false, ...}}

# 记住密码（存入系统凭据库；无凭据库时仅当前进程）
curl -s -X POST http://127.0.0.1:5077/api/ssh/profiles/ssh_xxx/remember \
  -H "Content-Type: application/json" -d '{"password":"********"}'

# 执行命令（远端非零退出仍 HTTP 200，ok 反映 exit_code == 0）
curl -s -X POST http://127.0.0.1:5077/api/ssh/exec \
  -H "Content-Type: application/json" \
  -d '{"profile_id":"ssh_xxx","command":"nvidia-smi -L","timeout_s":30,"cwd":"/data/project"}'
# {"ok":true,"exit_code":0,"stdout":"GPU 0: ...\n","stderr":"","duration_ms":420}

# 排障
curl -s http://127.0.0.1:5077/api/ssh/diagnostics
# {"backend":"ssh","profiles":2,"pooled_connections":1,"known_hosts":"...",
#  "credential":{...},"recent_commands":[{"profile_id":"ssh_...","command":"nvidia-smi","exit_code":0,...}]}
```

`test` 返回 `{"ok", "server_version", "fingerprint", "latency_ms", "error", "warning"}`；
即使连接失败也返回 HTTP `200`（失败原因在 `error`/`warning` 里）。
`exec` 缺 `profile_id`/`command` 返回 400，`timeout_s` 非数字返回 400；执行中连接中断导致结果不可知时
返回 `status="unknown"`（**不要自动重试**，`idempotent=true` 只用于确定未提交的错误重试）。
`ls` 返回 `{"path", "entries": [{"name","is_dir","size","mtime","attributes"}]}`；
`info` 返回 `{"uname","python","cpu_count","mem_total_mb","gpu","disk_free_gb"}`（探测失败的字段为 `null`）。
`diagnostics` 额外返回 `credentials`（后端与是否持久化）与 `recent_commands`（最近 10 条）。

### 15.3 错误码

| HTTP | code | 场景 |
|---|---|---|
| 400 | `bad_request` | 缺少参数、字段类型非法、空上传文件 |
| 404 | `not_found` | 档案/远端条目不存在 |
| 413 | `too_large` | 上传或下载文件超过 200MB |
| 502 | `ssh_error` | 连接失败、认证失败、远端命令/传输失败 |
| 500 | `server_error` | 服务端临时文件等未预期错误 |

### 15.4 工具

| 工具 | 参数 | 审批 |
|---|---|---|
| `ssh_list_profiles` | — | 否 |
| `ssh_exec` | `profile_id`, `command`, `timeout_s`(默认 120，1–3600), `cwd`(可选，不保留到后续命令) | ✅ |
| `ssh_upload` | `profile_id`, `local_path`, `remote_path` | ✅ |
| `ssh_download` | `profile_id`, `remote_path`, `local_path` | 否 |
| `ssh_remote_info` | `profile_id` | 否 |

工具集为 `ssh`；`ssh_exec` / `ssh_upload` 在 `ask` 审批策略下会先请求用户确认，
被拒绝时以失败结果回填模型并附原因。ssh 工作区（`backend="ssh"`）的内核执行走的不是这些工具，
而是执行后端 `SSHExecutionBackend`（见 §17 与架构文档 §2.2）。

---

## 16. 运行与恢复

1.2.0 把「对话回合」升级成可持久化、可重放的**运行（run）**。设计要点：**先把状态写进数据库，再对外广播**；
前端断线、进程重启、页面切换都不会丢结果。实现位于 `omicslab/runtime/`（`events.py` 是 SQLite 存储，`runs.py` 是 `RunService`）。

### 16.1 概念

| 概念 | 前缀 | 说明 |
|---|---|---|
| `run` | `run_` | 一次回合的完整生命周期；状态与结果落 SQLite |
| `trace` | `tr_` | 一个运行的轨迹；子任务有独立 trace，父轨迹上用 `child_run` 事件摘要 |
| `event` | `ev_` | 轨迹上的事件（增量、可重放）；`seq` 在 trace 内单调递增 |
| `agent_task` | `task_` | 子智能体任务记录（与子 run 一一对应） |
| `approval` | `appr_` | 审批记录，绑定 `run_id` / `task_id` |

存储位置：`<home>/runtime/events.db`（SQLite，WAL 模式，`PRAGMA user_version = 3`）。旧版 `trajectories/*.jsonl`
与既有会话文件**保持原样**，只读兼容；新运行只写 SQLite。

### 16.2 运行快照（run snapshot）

`run_snapshot` 是 `GET /api/runs/{run_id}`、`POST /api/sessions/{id}/runs`、`POST /api/runs/{id}/cancel` 等响应的主体：

```json
{
  "run_id": "run_7ac1d2e3f401",
  "trace_id": "tr_1f0c9b8e7d",
  "session_id": "c_9f3a2b7c1d4e",
  "parent_run_id": null,
  "root_run_id": "run_7ac1d2e3f401",
  "status": "succeeded",
  "agent_id": "lead",
  "workspace": {"workspace_id": "ws_main", "root": "D:\\data\\pbmc", "backend": "local"},
  "created_at": "2026-10-23T06:12:00+00:00",
  "started_at": "2026-10-23T06:12:00+00:00",
  "ended_at": "2026-10-23T06:13:40+00:00",
  "last_activity": "2026-10-23T06:13:39+00:00",
  "finish_reason": "stop",
  "error": null,
  "usage": {"prompt_tokens": 5120, "completion_tokens": 380, "total_tokens": 5500},
  "result_text": "QC 与聚类完成……",
  "client_request_id": null,
  "children": [],
  "approvals": [],
  "actions": {"cancel": false}
}
```

| 字段 | 说明 |
|---|---|
| `status` | `queued`/`preparing`/`running`/`waiting_approval`/`stopping`/`succeeded`/`failed`/`cancelled`/`interrupted`/`unknown` |
| `finish_reason` | 结束后为 `stop`/`max_iterations`/`cancelled`/`error`/`approvals`（等待审批超时等） |
| `error` | 失败时为 `{"message","code"}`，`code` 见 §16.4 |
| `result_text` | 助手最后一段完整文本（没有则为空串） |
| `children` | 子任务摘要数组（`task_id`/`run_id`/`profile`/`status`/`goal`/`result`） |
| `approvals` | 该运行关联的审批记录（含已处理的） |
| `actions.cancel` | 该状态是否还能取消 |

### 16.3 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/runs/{run_id}` | 运行快照（`404 run_not_found`） |
| GET | `/api/runs/{run_id}/stream?after_seq=` | 事件流 + 重放 + 心跳（§2.2） |
| POST | `/api/runs/{run_id}/cancel` | 取消运行（§2.4） |
| POST | `/api/runs/{run_id}/messages` | Steering（§2.5） |
| GET | `/api/runs/{run_id}/children` | 子任务摘要列表 |
| GET | `/api/sessions/{session_id}/runs?limit=` | 会话最近运行（limit 1–200，默认 50） |
| POST | `/api/sessions/{session_id}/runs` | 只建运行不开流（§2.3） |
| GET | `/api/agent-tasks/{task_id}` | 子任务详情（`404 task_not_found`） |
| GET | `/api/agent-tasks/{task_id}/runs` | 子任务及其运行 |
| GET | `/api/runtime/timeline/{trace_id}?after_seq=&limit=` | 轨迹时间线（limit 1–2000） |
| GET | `/api/traces/{trace_id}/events?after_seq=&limit=` | 同上（语义别名） |
| GET | `/api/runtime/runs?session_id=&status=&parent_run_id=&limit=` | 运行列表（limit 1–500，按创建时间倒序） |
| GET | `/api/runtime/runs/{run_id}/children` | 子任务列表（runtime 版） |
| GET | `/api/runtime/agent-tasks/{task_id}` | 子任务详情（runtime 版） |
| GET | `/api/runtime/agent-tasks/{task_id}/runs` | 子任务及其运行（runtime 版） |
| GET | `/api/runtime/config` | 运行相关配置（§16.6） |
| PUT | `/api/runtime/config` | 更新运行相关配置 |
| GET | `/api/runtime/diagnostics` | 诊断信息（§0.3） |
| GET | `/api/agents/default` | 当前默认智能体及其来源 |

时间线响应：

```json
{
  "trace_id": "tr_1f0c9b8e7d",
  "run": {"run_id": "run_...", "status": "succeeded", "...": "..."},
  "events": [
    {"seq": 1, "event_id": "ev_8a1b2c3d", "trace_id": "tr_...", "run_id": "run_...",
     "type": "run_status", "data": {"status": "running"}, "schema_version": 3, "ts": "2026-10-23T06:12:00+00:00"}
  ],
  "next_seq": 42,
  "max_seq": 41
}
```

### 16.4 状态机、终态与错误码

```text
queued → preparing → running ⇄ waiting_approval
                       │
                       ├→ stopping → interrupted（15s 内未退出）/ cancelled
                       └→ succeeded | failed | cancelled | interrupted | unknown
```

- 只有 `queued/preparing/running/waiting_approval/stopping` 是活跃状态；终态为
  `succeeded/failed/cancelled/interrupted/unknown`。
- 进程崩溃/重启时，库里仍处于活跃状态的运行会在启动时被**对账**为 `interrupted`，并打上
  `meta.recovered=true`、补一条 `run_status` 事件；`GET /api/health` 的 `runs.recovered` 与
  `/api/runtime/diagnostics` 的 `recovered_runs` 会列出它们（最多前 20 条）。
- `error.code` 取值：

| code | 含义 |
|---|---|
| `config_error` | LLM/视觉/审批等配置问题 |
| `llm_error` | 模型调用失败 |
| `cancel_timeout` | 取消后 15 秒未退出，强制标记 `interrupted` |
| `budget_exhausted` | 子任务预算（迭代/时间/token）耗尽 |
| `internal_error` | 其它未预期异常 |

- **幂等**：`POST /api/chat` 与 `POST /api/sessions/{id}/runs` 支持 `client_request_id`；同一个 id 重复提交返回已存在的运行
  （响应 `idempotent: true`），不会重复调用模型。数据库对 `client_request_id` 建唯一索引（仅非空时生效）。
- **并发**：同一会话同时只允许一个顶层运行；冲突返回 `409 run_in_progress` 并带 `run_id`/`trace_id`。

### 16.5 子任务（child run / agent_task）

智能体通过 `delegate_agent` 工具把任务交给子智能体时，服务端创建**子 run + agent_task**，并在父轨迹上发 `child_run` 事件。

| 限制 | 默认 | 配置字段 |
|---|---|---|
| 同时执行的运行数上限 | 8 | `max_parallel_runs`（1–64） |
| 每个父运行的子任务数上限 | 4 | `max_child_tasks`（1–16） |
| 子智能体嵌套深度上限 | 2 | `max_child_depth`（1–4） |
| 内核作用域数量上限 | 4 | `max_workspace_scopes`（1–16） |

子任务有独立 trace 与独立内核作用域（`task:<task_id>`），预算 `budget` 描述迭代/时间/token 上限；
结果契约为 `{"task_id","status","summary","artifact_refs","evidence_refs","warnings","error","usage"}`。
子任务失败时父运行收到 `ok=false` 的工具结果，**不会**被包装成成功；父运行取消会级联取消整棵子树。
子任务详情字段：

```json
{
  "task_id": "task_9b8c7d6e5f4a",
  "parent_run_id": "run_7ac1d2e3f401",
  "run_id": "run_...",
  "session_id": "c_...",
  "profile": "data-critic",
  "status": "succeeded",
  "goal": "核对 QC 阈值是否合理",
  "created_at": "2026-10-23T06:12:30+00:00",
  "updated_at": "2026-10-23T06:13:10+00:00",
  "ended_at": "2026-10-23T06:13:10+00:00",
  "budget": {"max_iterations": 6, "timeout_s": 300, "max_tokens": 40000},
  "result": {"text": "...", "usage": {...}, "finish_reason": "stop", "duration_ms": 40000},
  "error": null,
  "position": 0
}
```

### 16.6 运行时配置

```bash
curl -s http://127.0.0.1:5077/api/runtime/config
# {"config":{"approval_policy":"auto","max_parallel_runs":8,"max_child_tasks":4,
#   "max_child_depth":2,"max_workspace_scopes":4,"default_agent":"lead"},
#  "runtime":{...},"settings":{"provider":"deepseek","model":"deepseek-chat"}}

curl -s -X PUT http://127.0.0.1:5077/api/runtime/config \
  -H "Content-Type: application/json" -d '{"patch": {"approval_policy": "ask"}}'
# {"ok": true, "config": {...}}
```

只允许改 `approval_policy`、`max_parallel_runs`、`max_child_tasks`、`max_child_depth`、`max_workspace_scopes`、`default_agent`。
空 body 返回 `400 invalid_patch`；非法值返回 `400 invalid_config`（保存后审批器**原地更新**，在途审批不丢）。

### 16.7 事件存储

事件表 `events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, trace_id, run_id, type, payload_json, schema_version=3, ts)`；
`seq` 全局自增、按 trace 排序，`event_id` 幂等去重。写入策略是**追加式**：事件不修改、不删除；
`runs` 表的状态更新走白名单字段。数据库异常时服务降级为内存事件（`seq=-1`），不阻断主循环。

---

## 17. 工作区与执行后端（Workspaces）

工作区把「分析在哪跑」与「文件放在哪」解耦：一个工作区 = 一个目录（本地）或一台远端主机上的根目录（SSH），
并绑定一个内核作用域。默认工作区固定为 `ws_main`。

### 17.1 数据模型

```json
{
  "workspace_id": "ws_ab12cd34ef",
  "name": "GPU 节点",
  "backend": "local",
  "resolved_path": "D:\\data\\pbmc",
  "remote": {},
  "conversation_id": null,
  "project_id": null,
  "status": "idle",
  "created_at": "2026-10-23T06:00:00+00:00",
  "updated_at": "2026-10-23T06:00:00+00:00",
  "default": false,
  "scope": "ws:ws_ab12cd34ef",
  "online": true
}
```

| 字段 | 说明 |
|---|---|
| `workspace_id` | `ws_` 前缀；默认工作区固定 `ws_main` |
| `backend` | `local` 或 `ssh` |
| `resolved_path` / `remote` | 本地工作区给绝对路径；SSH 工作区给 `remote`（含 `profile_id` 与 `root`，默认 `~`） |
| `status` | `idle` / `in_use` / `offline` / `unknown` |
| `conversation_id` | 绑定的会话（一个会话只属于一个工作区） |
| `scope` | 内核作用域：默认工作区为 `main`，其它为 `ws:<workspace_id>` |
| `online` | 本地恒为 `true`；SSH 只有配了 `remote` 才为 `true`（不代表已连通，连通性用 probe） |
| `default` | 是否默认工作区（不可删除） |

存储：`<home>/workspaces.json`（`version: 1`）。默认工作区在首次启动时创建，指向启动时的 `--workspace` 目录。

### 17.2 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workspaces` | `{workspaces, default_id, limit, kernels}` |
| POST | `/api/workspaces` | 新建（`name`、`local_path`、`backend`、`remote`） |
| GET | `/api/workspaces/{id}` | 详情 + 内核状态 + 最近运行 |
| DELETE | `/api/workspaces/{id}` | 删除（同时停止其内核） |
| POST | `/api/workspaces/{id}/probe` | 探测可用性：本地返回 `exists/writable/entries/path`；SSH 经连接服务返回 `ok/remote/detail`（失败也 200） |
| GET | `/api/kernels` | 所有作用域内核状态（§4.4） |
| POST | `/api/kernels/{scope}/start` / `restart` / `stop` / `execute` | 作用域内核操作（§4.4） |
| GET | `/api/kernels/{scope}/vars` | 作用域变量列表 |
| GET | `/api/workspaces/{id}/files/tree?path=&show_hidden=` | 工作区目录树 |
| GET | `/api/workspaces/{id}/files/read?path=&max_bytes=` | 读文本 |
| GET | `/api/workspaces/{id}/files/raw?path=` | 下载原始文件 |
| POST | `/api/workspaces/{id}/files/write` | 写文本（`{path, content}`） |
| POST | `/api/workspaces/{id}/files/mkdir` | 建目录（`{path}`） |
| POST | `/api/workspaces/{id}/files/upload` | 上传（multipart `file` + 查询参数 `dir`，上限 200MB） |
| DELETE | `/api/workspaces/{id}/files?path=` | 删除文件/目录 |

错误码：`404 workspace_not_found`、`400 workspace_invalid` / `workspace_delete_refused`（默认工作区或使用中）、
`400 workspace_not_local`（对 SSH 工作区调用本地文件端点）、`500 workspaces_unavailable` / `workspace_root_missing`、
`404 invalid_scope`、`400 empty_code`、`413 file_too_large`。

```bash
# 建一个本地工作区
curl -s -X POST http://127.0.0.1:5077/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"肺纤维化项目","backend":"local","local_path":"D:\\data\\ipf"}'

# 建一个 SSH 工作区（远端根目录默认 ~）
curl -s -X POST http://127.0.0.1:5077/api/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name":"GPU 节点","backend":"ssh","remote":{"profile_id":"ssh_xxx","root":"/data/projects/ipf"}}'
```

### 17.3 执行后端（ExecutionBackend）

`omicslab/execution/` 定义统一执行接口：`start/close/interrupt/status`、`execute_python`、`list_vars`、`var_detail`、
`shell`、`list_dir/read_text/write_text/make_dir/delete_path/save_upload/read_bytes`。

| 后端 | 实现 | 说明 |
|---|---|---|
| `local` | `LocalExecutionBackend` | 包本机 KernelService、文件服务与 Shell 执行 |
| `ssh` | `SSHExecutionBackend` | SFTP 文件操作 + 远端常驻 worker（JSON-lines over stdio）；工作目录限制在远端 `root` 内，越界报「路径超出 SSH 工作区范围」 |

工具输出里的 `data.execution_target` 标明本次操作真正发生在哪：

```json
{"execution_target": {"kind": "local", "root": "D:\\data\\pbmc", "cwd": "D:\\data\\pbmc", "connection_id": null}}
```

远端不可用时抛 `BackendUnavailable`（HTTP 层映射为可读错误），**禁止自动回退本地执行**——避免把数据算在本机却当成远端结果。
SSH 后端的连接、凭据与 SFTP 走 §15 的连接服务；SSH 文件端点（`/api/workspaces/{id}/files/*`）目前只支持 `local` 工作区，
SSH 工作区的文件操作请走 §15 的 SSH 端点或智能体工具。

---

本文件对应 Suwen 2.0.0。正文中的“1.2.0 起”表示该能力首次引入的版本。
