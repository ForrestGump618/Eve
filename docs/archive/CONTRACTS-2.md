# OmicsLab 二期接口契约（Stage 2, v1.1）

> **归档文档（历史）**：本文件是 Suwen 1.2→2.0 开发过程的原始记录，仅用于追溯，不是当前用户文档。当前文档入口见 [docs/README.md](../README.md)。

本文档是二期新增功能的**唯一接口事实来源**，优先级高于任何口头约定。
一期契约见 `docs/CONTRACTS.md`（仍然有效）。

## 0. 阶段目标（用户需求映射）

| 需求 | 实现 |
| --- | --- |
| 配置 API 后无法调用 | `config.py` 解析/校验重写 + `/api/settings*` 永不 500 + 前端设置页原子保存与真实连通性测试 |
| 视觉模型配置 | `omicslab/agent/vision.py` + 设置页视觉卡片 + `analyze_image` 工具 + 聊天图片自动解读 |
| OmicOS 功能对齐 | 函数注册表（`registry`）、SSH 远程算力（`ssh`）、轨迹记录、发现项目（discovery） |
| RSI 新科研发现 | `omicslab/discovery/`（假设生成→预注册检验→实验执行→证据分级→反思→策略自进化） |
| SSH 连接与资源调用 | `omicslab/ssh/` + `/api/ssh/*` + `ssh_*` 工具 + 前端 SSH 页 |

## 1. 目录 ownership（二期）

- **Lead**：`omicslab/config.py`、`omicslab/agent/vision.py`、`omicslab/agent/loop.py`（图片注入）、
  `omicslab/discovery/**`、`omicslab/registry/**`、`omicslab/agent/providers/**`、
  `omicslab/server/{state,routes,chat,app}.py` 中登记新路由/状态的改动、`omicslab/cli.py`、
  `tests/test_config.py`、`tests/test_discovery.py`、`tests/test_registry.py`、`tests/test_vision.py`。
- **ssh-dev**：`omicslab/ssh/**`、`omicslab/server/routes_ssh.py`、`tests/test_ssh.py`、
  `omicslab/web/js/views/ssh.js` 与 `omicslab/web/css/ssh.css`（仅由 ssh-dev 写这两个前端文件）。
- **frontend2**：除 `omicslab/web/js/views/ssh.js`、`omicslab/web/css/ssh.css` 以外的全部 `omicslab/web/**`；
  负责设置页修复与视觉卡片、发现页、函数库页、SSH 页挂载与导航。
- **skillpack2**：`omicslab/agents/*.md`、`omicslab/skills/**`（新增与更新 frontmatter）。
- **pkgdocs**（二期后半）：`README.md`、`docs/**`（除本文件与 CONTRACTS.md）、`CHANGELOG.md`、
  `scripts/**`、`tests/test_skills.py`、`tests/test_cli.py`。

跨 scope 改动必须先消息通知 Lead，不得直接改。

## 2. 通用约定

- 所有新增 REST 返回 JSON；错误统一 `{"error": {"message","code","detail"}}`（已有异常处理器）。
- 时间戳：`iso_now()`（UTC ISO8601，`Z` 结尾或 `+00:00`）。
- ID：`new_id(prefix)` 生成，如 `dp_xxx`（发现项目）、`hy_xxx`（假设）、`ev_xxx`（证据）、`st_xxx`（策略）、`rt_xxx`（轮次）。
- SSE：沿用一期 envelope：单行 `data: {"type": "...", "data": {...}, "ts": ...}`。
- 新增 SSE 事件类型：`discovery`（data.kind 见 §5）。
- 中文 UI / 中文错误提示；英文代码与字段名。
- 不引入前端构建工具、不引入 CDN；后端新增第三方依赖需在 `pyproject.toml` 声明。

## 3. 配置与 Provider（Lead 实现，ssh-dev/frontend2 只消费契约）

### 3.1 `GET /api/settings`（永不 500）

```json
{
  "settings": { ... public_settings ... },
  "llm": {"configured": true, "provider": "ark", "model": "...", "family": "openai",
          "api_base": "...", "label": "...", "has_key": true, "error": null},
  "vision": {"enabled": true, "model": "...", "base_url": "...", "has_key": true,
             "configured": true, "error": null},
  "providers": {
    "<id>": {"label": "...", "family": "openai|anthropic|mock", "api_base": "...",
             "env_key": "DEEPSEEK_API_KEY", "default_model": "...", "models": ["..."],
             "has_key": true, "configured": true, "no_key_required": false,
             "needs_api_base": false, "needs_model": false, "hint": "..."}
  }
}
```

新增 provider id：`ark`（火山方舟，OpenAI 兼容，`https://ark.cn-beijing.volces.com/api/v3`，
env `ARK_API_KEY`，`needs_model=true`，default_model 空，hint 提示填写推理接入点 ID 或模型名）。
`auto` 仅在 GET 返回中作为 `settings.provider` 的存储值出现，catalog 不包含 `auto`。

### 3.2 `PUT /api/settings` body `{"patch": {...}}`

- 允许字段：provider/model/api_base/temperature/max_tokens/max_iterations/request_timeout_s/
  kernel_python/kernel_timeout_s/shell_timeout_s/approval_policy/allow_shell/allow_file_write/
  sandbox_root_only/default_agent/language/ui/vision_model/vision_base_url。
- 切换 provider（patch.provider 存在且与当前不同）且未给 model：`model="auto"`；
  新 provider 不是 `custom_*` 且未给 api_base：清空 `api_base`（避免旧地址串用）。
- 未知字段忽略；非法类型返回 400。

### 3.3 `POST /api/settings/keys`

```json
{"keys": {"DEEPSEEK_API_KEY": "sk-..."}, "provider": "deepseek",
 "model": "deepseek-chat", "api_base": "", "key": "sk-...", "vision_api_key": "..."}
```

- `key` 为选中 provider 的 env_key 捷径；`keys` 优先；空字符串表示删除该 key。
- `provider/model/api_base` 可选，给了就一并写入 settings.json（**原子保存**）。
- `vision_api_key` 写入 auth.json 的 `VISION_API_KEY`。
- 返回 `{"ok": true, "saved_keys": ["DEEPSEEK_API_KEY"], "settings": ..., "llm": ..., "vision": ...}`。

### 3.4 `POST /api/settings/test_llm`

```json
{"provider": "ark", "model": "ep-...", "api_base": "https://...", "api_key": "..."}
```

- 全部可选；缺省用已保存配置（key 来自 auth/env）。
- 返回 `{"ok": bool, "provider", "model", "latency_ms": 812, "reply": "pong", "error": null|"..."}`。
- 必须实际发一次极小 chat（max_tokens=16），不得只检查 key 是否存在。

### 3.5 `POST /api/settings/test_vision`

body `{"model","base_url","api_key"}`（可选）→ 返回同 test_llm 结构，实际发一次图片理解请求
（内置 1×1 或 8×8 红色 PNG data URL）验证连通性。

### 3.6 `POST /api/settings/vision`

body `{"enabled": bool, "model": "...", "base_url": "...", "api_key": "..."}` →
写入 settings（key 存 auth 的 `VISION_API_KEY`）→ 返回 `{"vision": {...}}`。

## 4. 视觉（Lead 实现）

- `omicslab/agent/vision.py`：
  - `class VisionError(RuntimeError)`；
  - `class VisionClient: __init__(self, settings); configured -> bool; async describe(self, image: bytes|str|Path, prompt: str = "", model: str = "", base_url: str = "", api_key: str = "", timeout_s: int = 120) -> str`
  - 支持 OpenAI 兼容（`/chat/completions` + `image_url` data URL）与 Anthropic（`/v1/messages` + `image` base64）；
    通过 `base_url` 探测 family（含 `anthropic` → anthropic；否则 openai）。图片 ≤ 12MB，自动按扩展名映射 MIME。
- 工具 `analyze_image(path: str, question: str = "请详细描述这张图并解读其中的数据含义")`：
  path 可为工作区相对路径或图库文件名；未配置视觉时返回友好错误（ToolResult ok=False）。
- 聊天的 `attachments`：若含图片且视觉已配置，`loop` 在用户消息前自动注入
  `【图像内容解读 #N】` 文本（每图 ≤ 3000 字），使任意文本模型可用；同时在工具提示中说明可用 `analyze_image`。

## 5. 发现 / RSI（Lead 实现）

### 5.1 数据模型（`omicslab/discovery/types.py`）

- `Hypothesis`: id, project_id, statement, rationale, prediction, test_plan, success_criteria,
  status ∈ {proposed, testing, supported, refuted, inconclusive}, confidence(float 0..1),
  evidence_ids[], round, parent_id, tags[], created_at, updated_at.
- `Evidence`: id, project_id, hypothesis_id, kind ∈ {data, statistics, literature, experiment, critique},
  summary, code, result_excerpt, figures[], strength ∈ {strong, moderate, weak}, reproducible(bool), created_at.
- `Insight`: id, project_id, text, confidence, evidence_ids[], round, created_at.
- `Strategy`: id, project_id, name, description, prompt_hint, uses, successes, reward(float 0..1),
  lineage(strategy_id | null), created_at, updated_at.
- `DiscoveryRound`: id, project_id, index, strategy_id, hypothesis_id, plan, prediction,
  success_criteria, outcome, reward, reflection, started_at, ended_at, error.
- `Project`: id, title, objective, domain, agent, data_hints[], max_rounds(int, default 4),
  budget_minutes(int, default 90), status ∈ {idle, running, paused, done, failed, cancelled},
  created_at, updated_at, current_round, rounds_count, summary.

### 5.2 落盘（`omicslab/discovery/ledger.py`）

`home/discovery/<project_id>/`：`project.json`、`hypotheses.jsonl`、`evidence.jsonl`、
`insights.jsonl`、`strategies.json`、`rounds.jsonl`、`report.md`。
`class ProjectStore: list_projects(); create(title, objective, domain, agent, data_hints, max_rounds, budget_minutes) -> Project;
get(project_id) -> Project (KeyError/ProjectNotFound); save(project); delete(project_id);
append_hypothesis/update_hypothesis/list_hypotheses; add_evidence/list_evidence;
add_insight/list_insights; list_strategies/upsert_strategy; append_round/list_rounds;
write_report(project_id, markdown); read_report(project_id) -> str;`

### 5.3 引擎（`omicslab/discovery/engine.py`）

`class DiscoveryEngine: __init__(self, settings, kernel, registry, store, agents=None, skills=None);
async def run(self, project_id: str, *, emit=None, cancel_event=None, approver=None) -> dict`
（emit 为 `Callable[[AgentEvent], Awaitable[None]]`；返回 `{"status","rounds","report_path"}`）。

每轮固定 7 步（RSI 闭环，必须真实执行，不允许假数据）：

1. **Observe**：汇总目标/数据提示/历史洞察/策略成功率/最近证据。
2. **Hypothesize**：LLM 输出 JSON 数组 `[{statement, rationale, prediction, test_plan, success_criteria,
   novelty, feasibility, impact}]`（2~4 条）；与账本做 token 去重；落库为 `proposed`。
3. **Prioritize**：`score = 0.35*novelty + 0.25*feasibility + 0.20*impact + 0.20*strategy_prior`；
   用 UCB1 在策略库中选策略（`reward + sqrt(2*ln(total_uses+1)/(uses+1))`）；选 1 条假设（无新假设则跳过）。
4. **Pre-register**：把 test_plan/prediction/success_criteria 先写入账本（round），再执行 → 防 p-hacking。
5. **Execute**：`AgentLoop.run` 在临时会话（不落库）中执行计划；prompt 要求：用 `run_python_code` 实际分析、
   输出统计检验与效应量、图存 figures、最后给 `结论:` 行。捕获 tool_result(code/结果/图)、最终文本、错误。
6. **Evaluate**：heuristics + LLM critic → reward(0..1)、evidence strength、hypothesis status/confidence 更新；
   记录 evidence 与 round outcome。
7. **Reflect（自我改进）**：LLM 产出 `{reflection, lessons[], strategy_mutation:{name,description,prompt_hint}}`；
   更新策略统计（uses/successes/reward 指数滑动），新策略写入策略库（lineage=当前策略 id）；
   洞察写入 insights；预算耗尽或达 max_rounds 后生成报告（含假设状态表、关键证据、可复现清单、局限声明）。

- 每步 emit：`AgentEvent("discovery", {"kind": "...", "project_id": ..., ...})`；
  kind ∈ {project, status, round, hypothesis, evidence, insight, strategy, reflection, report, error}。
- LLM 不可用（mock）时必须仍能跑通：mock provider 返回固定 JSON 时解析失败要有降级假设生成，
  不允许整体崩溃。
- 安全：执行代码经既有审批策略；默认 `allow_shell` 照旧。

### 5.4 REST（`omicslab/server/routes_discovery.py`）

- `GET /api/discovery/projects` → `{"projects": [...]}`（含 status/rounds_count/updated_at）
- `POST /api/discovery/projects` body `{title, objective, domain?, agent?, data_hints?, max_rounds?, budget_minutes?}` → `{"project": {...}}`
- `GET /api/discovery/projects/{id}` → `{"project","hypotheses","evidence","insights","strategies","rounds"}`
- `DELETE /api/discovery/projects/{id}` → `{"ok": true}`
- `POST /api/discovery/projects/{id}/run` → **SSE**：`connected` → 若干 `discovery`/`text`/`tool_call`/`figure` → `done{"project_id","status","report"}`；同一项目并发 run 返回 409；可被 `POST /api/discovery/projects/{id}/stop` 取消。
- `GET /api/discovery/projects/{id}/report` → `{"project_id","markdown"}`；报告不存在时 `{"markdown": ""}`。
- `GET /api/discovery/projects/{id}/ledger?kind=hypotheses|evidence|insights|strategies|rounds` → `{"items": [...]}`。
- `POST /api/discovery/projects/{id}/hypotheses` body `{statement, rationale?, prediction?, test_plan?}` → 手动加入 `proposed`。
- `POST /api/discovery/strategies/seed` → 初始化默认策略库（若为空）→ `{"strategies": [...]}`。

### 5.5 工具（`omicslab/discovery/tools.py`，Lead 负责注册到 registry）

`discovery_list()`, `discovery_create(objective, title?, data_hints?)`,
`discovery_get(project_id)`, `discovery_add_hypothesis(project_id, statement, rationale?, prediction?)`,
`discovery_record_evidence(project_id, hypothesis_id, summary, kind?, strength?)`,
`discovery_report(project_id)`。均为轻量账本操作（不执行长任务）。

### 5.6 CLI

`python -m omicslab discover --objective "..." [--data path ...] [--rounds N] [--project id] [--mock]`
→ 打印每轮进度，结束时打印报告路径与假设摘要；退出码 0/1。

## 6. SSH（ssh-dev 实现）

### 6.1 依赖与存储

- 依赖：`paramiko>=3.4`（加入 pipeline `bio`/新 extra `remote`；Lead 装到 venv 并写入 pyproject）。
- 配置：`home/ssh.json`，结构 `{"profiles": [ ... ]}`：
  `{id, name, host, port(22), username, auth: "password"|"key", key_path, password_saved: bool,
    password: "" (仅当 password_saved=true，base64 混淆并附警示), tags[], created_at, updated_at, last_ok, last_error}`。
- 安全：默认不落盘密码（`remember_password=false`）；`password_saved=true` 时 base64 存并标注；
  日志/API 返回**永不含密码/私钥内容**；`GET` 返回 `has_password_saved` 布尔。
- 已知主机密钥：`AutoAddPolicy` + 首次连接记录 fingerprint 到 `home/ssh_known_hosts.json`；
  后续 fingerprint 变化时测试连接返回警告（不静默失败）。

### 6.2 `omicslab/ssh/manager.py`

`class SSHError(RuntimeError)`；`class SSHManager(settings)`：
`list_profiles() -> list[dict]`；`get_profile(profile_id)`；`add_profile(**fields) -> dict`；
`update_profile(profile_id, **fields)`；`remove_profile(profile_id)`；`test_connection(profile_id, password=None) -> {"ok", "server_version", "fingerprint", "latency_ms", "error"}`；
`exec(profile_id, command, timeout_s=120, cwd=None) -> {"ok", "exit_code", "stdout", "stderr", "duration_ms"}`（同步，线程安全连接池可复用；重连 1 次）；
`put_file(profile_id, local_path: Path, remote_path: str, mkdir=True) -> {"ok","bytes","remote_path"}`（SFTP，>4MB 有进度回调可选）；
`get_file(profile_id, remote_path, local_path: Path) -> {"ok","bytes","local_path"}`；
`list_dir(profile_id, remote_path) -> {"path","entries":[{name,is_dir,size,mtime,attributes}]}`；
`remote_info(profile_id) -> {"uname","python","cpu_count","mem_total_mb","gpu","disk_free_gb"}`（容错，缺失字段 null）。
`home/ssh.json` 读写用 `omiclab.utils.atomic_write_text`。

### 6.3 REST（`omicslab/server/routes_ssh.py`，注册到 app）

- `GET /api/ssh/profiles` → `{"profiles":[...]}`（无密码字段，`has_password_saved` 布尔）
- `POST /api/ssh/profiles` body `{name,host,port,username,auth,key_path,password?,remember_password?}` → `{"profile":{...}}`
- `PATCH /api/ssh/profiles/{id}`；`DELETE /api/ssh/profiles/{id}` → `{"ok":true}`
- `POST /api/ssh/profiles/{id}/test` body `{password?}` → test_connection 结果
- `POST /api/ssh/exec` body `{profile_id, command, timeout_s?, cwd?}` → exec 结果（success 时 HTTP 200；远端非零退出仍 200，`ok` 反映 exit_code==0）
- `GET /api/ssh/ls?profile_id=&path=` → list_dir
- `GET /api/ssh/info?profile_id=` → remote_info
- `POST /api/ssh/upload` multipart `file` + Form `profile_id`、`remote_path` → put_file（临时文件落 home/tmp）
- `GET /api/ssh/download?profile_id=&remote_path=` → FileResponse（临时文件；文件名 basename；>200MB 拒绝）
- 错误：连接失败 → 502 `{"error":{"message":"SSH 连接失败: ...","code":"ssh_error"}}`；参数缺失 400；未知 profile 404。

### 6.4 工具（`omicslab/ssh/tools.py`）

`register_ssh_tools(registry, settings)` 注册：`ssh_list_profiles()`、`ssh_exec(profile_id, command, timeout_s=120)`、
`ssh_upload(profile_id, local_path, remote_path)`、`ssh_download(profile_id, remote_path, local_path)`、
`ssh_remote_info(profile_id)`。`ssh_exec`/`ssh_upload` `requires_approval=True`；工具异常返回 `ToolResult(ok=False)`。
Lead 在 `agent/tools.py::build_registry` 末尾调用 `register_ssh_tools`（若 import 失败则跳过，不崩溃）。

### 6.5 前端 SSH 页（ssh-dev 写 `web/js/views/ssh.js` + `web/css/ssh.css`）

- 布局：左侧连接档案列表（卡片：名称/host/user/状态徽标/测试/编辑/删除/新增按钮）；
  右侧：命令输入框 + 执行按钮 + 输出终端区（等宽、可复制、显示 exit_code/耗时）、远程目录浏览（面包屑+列表+上传/下载）、远端信息面板。
- 交互：新档案模态框（名称/host/port/user/auth 切换 password|key/密码或私钥路径/记住密码开关+警示文案）；
  连接测试显示延迟与 server_version；命令支持 Ctrl+Enter；上传支持选择本地文件（浏览器 File → /api/ssh/upload）；下载触发浏览器下载。
- 导出：`export default { mount(el), unmount() }`（与一期 view 结构一致；前端 shell 由 frontend2 接入导航）。
- 事件：使用 `js/api.js`（`api.get/post/patch/del`）与 `js/ui.js`（toast/confirm/模态）。

## 7. 函数注册表（Lead 实现，`omicslab/registry/`）

- `index.py`：`class RegistryIndex: __init__(settings); index_path; refresh(packages: list[str]|None=None) -> dict`（子进程调 kernel_python 内省，JSON 输出）
  `search(query, limit=10) -> list[dict]`、`get(qualname) -> dict|None`、`modules() -> list[dict]`、`stats()`。
- 索引项：`{"name","qualname","module","kind":"function"|"class","signature","summary","package","package_version","docstring"}`。
- 默认扫描包：numpy, pandas, scipy, sklearn, statsmodels, matplotlib, seaborn, scanpy, anndata, omicverse,
  lifelines, gseapy, pydeseq2, flowio, flowkit, rdkit, squidpy, harmonypy, biopython(bio), plotly, networkx, umap, leidenalg。
  未安装的包跳过并记录 `missing_packages`。
- REST：`GET /api/registry/search?q=&limit=`、`GET /api/registry/modules`、`GET /api/registry/function?name=`、
  `POST /api/registry/refresh`（body `{"packages": [...]?}`，可能耗时 → 用 `asyncio.to_thread`）。
- 工具：`registry_lookup(query, limit=8)`（注册到 registry）。

## 8. 轨迹记录（Lead）

- 每次 `AgentLoop.run` 结束写 `home/trajectories/<conversation_id>/<turn_id>.jsonl`：
  首行 `{"type":"meta","conversation_id","agent","provider","model","started_at","ts"}`，
  随后事件行 `{"type":"event","event": {...AgentEvent...}}`；最后 `{"type":"done","finish_reason","usage"}`。
- REST：`GET /api/trajectories?conversation_id=` → `{"items":[{turn_id,path,size,mtime,finish_reason?}]}`；
  `GET /api/trajectories/{conversation_id}/{turn_id}` → `{"turn_id","events":[...]}`。
- 失败不影响主流程（记录异常吞掉并写日志）。

## 9. 前端二期（frontend2）

1. **设置页修复（P0）**：provider 下拉来自 `GET /api/settings.providers`（含 ark）；显示 `configured` 徽标；
   选择 provider 自动填充 api_base/default_model 与 key 提示；"保存并测试" 走 `/api/settings/keys`
   （一次提交 key+provider+model+api_base）→ 再 `/api/settings/test_llm` 展示真实回复；
   保存后即时刷新 `GET /api/settings` 的 llm 状态与聊天默认模型；`llm.error` 用红色提示条展示可操作建议。
2. **视觉卡片**：开关 + 模型 + base_url + API key + "测试视觉"；保存走 `/api/settings/vision` 与
   `/api/settings/test_vision`；未配置时聊天图片附件提示先配置。
3. **发现页（新）**：项目列表 + 新建模态框（标题/目标/领域/数据提示/最大轮数）；
   运行按钮 → SSE 订阅 `/api/discovery/projects/{id}/run`，时间线展示 7 步（观察/假设/排序/预注册/执行/评估/反思）；
   假设卡片（状态色/置信度条/证据列表）、策略库表格（uses/successes/reward/lineage）、报告预览（markdown）与复制路径。
4. **函数库页（新）**：搜索框（防抖）+ 模块过滤器 + 结果列表（签名/摘要/所属包/版本/复制示例）+ 刷新索引按钮。
5. **SSH 页**：挂载 ssh-dev 的 `views/ssh.js`。
6. **聊天图片**：附件选择/粘贴/拖拽图片 → 发送（后端自动解读）；工具结果图片已有内联。
7. 导航侧栏新增 发现/函数库/SSH 三项（图标沿用 icons.js 风格，新增必要 SVG）。
8. 保持既有 8 个页面与全部交互不回归；`node --check` 通过；无外部依赖。

## 10. 智能体与技能（skillpack2）

- 新增 agents（YAML frontmatter 字段沿用一期）：
  - `discovery-lead`（RSI 科研发现总控：规划轮次、调用 discovery 工具、整合证据）tier specialist
  - `hypothesis-smith`（假设生成：可证伪性、机制、预测）
  - `experiment-designer`（实验/分析设计：对照、样本、统计检验、预注册）
  - `evidence-critic`（证据评估：效应量、多重检验、混杂、可复现性、分级）
  - `research-strategist`（反思与策略进化：总结失败模式、提出改进策略）
  - `remote-compute-engineer`（SSH 远程算力：环境探测、批量任务、产物回收）
- 新增 skills：`rsi-discovery-loop`（完整闭环 playbook）、`hypothesis-generation`、`experimental-design`、
  `statistical-rigor`、`causal-inference`、`remote-compute-ssh`、`function-registry`、`vision-interpretation`。
- 更新 `lead.md`：toolsets/instructions 增加 discovery_*/ssh_*/registry_lookup/analyze_image 与"发现项目优先用 discovery 工具"。
- 内容必须自研、可执行（含代码片段/检查清单/常见错误），禁止复制第三方产品文本。
