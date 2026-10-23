# 验收记录（1.2.0）

本文件记录 OmicsLab 1.2.0 针对《OmicsLab-优化方案-交付DSH.md》T01–T11 / F01–F15 的验收证据。
结论分三级：**已验证**（有可复现命令或截图证据）、**部分验证**（只有单元/集成测试，缺少真实环境）、
**未验证**（环境不可用，明确标注，不以 mock 冒充）。

> 验收环境：Windows 11 + Python 3.11.9（项目 venv `.venv`），本地回环网络，无外网依赖。
> 真实 SSH 服务器与真实 LLM 账号在本机不可用；对应场景一律标注「未验证」。

## 1. 一键复现

```powershell
cd C:\projects\suwen

# 1) 单元 + 集成测试
.\.venv\Scripts\python.exe -m pytest -q

# 2) 端到端冒烟（真实启动服务，mock 模型，46 项）
.\.venv\Scripts\python.exe scripts\smoke.py --timeout 120

# 3) 验收脚本（真实启动服务 + 脚本化 fake OpenAI 兼容模型，12 项）
.\.venv\Scripts\python.exe scripts\acceptance.py --timeout 240
#   报告：.tmp\accept\acceptance_report.json

# 4) 手动体验
cd omicslab
.\.venv\Scripts\python.exe -m omicslab serve --port 5077
```

`scripts/acceptance.py` 覆盖：默认智能体为 lead、双击发送只产生一个运行、`client_request_id` 幂等、
断线重放不重复事件、作用域停止只取消目标运行、审批在运行中保存设置后仍可解析、子任务运行可见并完成、
工作区内核与文件隔离、本地终端 WebSocket 往返、服务崩溃重启后对账为 `interrupted` 且不重跑、健康检查延迟采样。

## 2. 自动化结果（最近一次运行）

| 类别 | 命令 | 结果 |
|---|---|---|
| 测试 | `.venv\Scripts\python.exe -m pytest -q` | **358 passed, 1 warning in 30.28s**（基线 274；含 runtime/evidence/ssh/terminal 新测试） |
| 冒烟 | `.venv\Scripts\python.exe scripts\smoke.py --timeout 150` | **46/46 通过** |
| 验收脚本 | `.venv\Scripts\python.exe scripts\acceptance.py --timeout 300` | **12/12 通过，179.0s**（`.tmp\accept\acceptance_report.json`，含 health p95 采样） |
| 浏览器 | REA `capture_browser_scenario` + Edge headless（frontend2 专项） | 截图证据见 §4 |

### 2.1 发布产物（1.2.0）

`powershell -ExecutionPolicy Bypass -File scripts\publish.ps1 -SkipTests` → 产物校验通过：

| 文件 | 说明 |
|---|---|
| `dist/omicslab-1.2.0-py3-none-any.whl` | 大小与 SHA-256 见 `dist/SHA256SUMS.txt` 及 `Get-ChildItem dist` |
| `dist/omicslab-1.2.0.tar.gz` | 同上；sdist 含 docs/scripts/tests 全量内容 |

### 2.2 最终复验（前端 E2E 后补丁）

- 内核连接文件落盘修复（`kernel/manager.py`：`connection_file` 固定写入 `<home>/jupyter/runtime/`）→ 工作区根目录不再出现 Jupyter 生成的 `tmp*.json`；随后重建发行产物并复验 **pytest 358 passed / smoke 46/46 / acceptance 12/12（179.0s）**。

- 审批 `target` 解析修复（`agent/approvals.py` 的 `_call_or_value`：`str`/`PathLike`/`Workspace` 记录归一化为真实 `root/cwd`）→ 实测审批 payload `target.root = .tmp\rt\ws`（非 `Path.cwd` bound method）；回归测试在 `tests/test_runtime.py`。
- `GET /api/agent-tasks/{task_id}/runs` 修复：按 task 的 `run_id`/`parent_run_id` 返回关联运行（实测返回子运行 + 父运行，均 `succeeded`）。
- 前端真实数据 E2E（frontend2，1.2.0 + fake provider）：子任务卡片运行中→完成（data-critic、CHILD_DONE）、全局审批中心（真实 cwd）、任务详情模态、底部子任务树（顶层 runs=1、children=1）；`console_error_count=0`；侧栏显示 `v1.2.0`。

## 3. §12 验收场景逐项对照

| # | 场景 | 结果 | 证据 |
|---|---|---|---|
| 1 | 弹窗多种关闭路径连续 20 次 | 已验证（浏览器） | `web/js/ui.js` 重写；frontend2 CDP 专项 20 次开关 + `elementFromPoint` 采样；空 `#modal-root` 为 `pointer-events:none` |
| 2 | 首次启动不选专家用 lead | 已验证 | `tests/test_runtime.py`；`scripts/acceptance.py::default agent is lead`；`GET /api/agents/default` |
| 3 | 历史错误角色偏好可迁移 | 已验证（浏览器） | `web/js/views/chat.js` 一次性迁移提示；不再 `agents[0]` |
| 4 | 切换目录、两个项目并存 | 已验证（本地） | `scripts/acceptance.py::workspace kernels and files are isolated`（两工作区分内核执行 `iso_var=1/2`、文件互不可见）；`tests/test_runtime.py::WorkspaceService` |
| 5 | 同会话快速双击发送 | 已验证 | `acceptance.py::double submit`（第二个请求 409 `run_in_progress`）；`tests/test_runtime.py::RunService` 会话单活跃 |
| 6 | 流中断、事件重复到达 | 已验证 | `acceptance.py::reconnect replays without duplicate events`（`after_seq` 重放，`event_id` 去重、seq 递增） |
| 7 | 切页面、刷新、重新打开 | 已验证（浏览器） | `web/js/views/chat.js` sessionStorage 恢复 + `GET /api/runs/{id}/stream` 重订阅；断线不中止运行（`RunService` 独立 task） |
| 8 | 服务进程崩溃重启 | 已验证（本地） | `acceptance.py::server crash is reconciled as interrupted`；`EventStore.recover_runs()`；`tests/test_runtime.py::test_recover_runs_marks_interrupted` |
| 9 | 子任务 ask 审批/拒绝/超时 | 部分验证 | 子任务审批事件与持久化：`tests/test_runtime.py` 子运行、审批表；`acceptance.py::approval survives settings`；拒绝/超时为 `Approver` 单测（`tests/test_tools.py`）；真实子任务 UI 审批见浏览器证据 |
| 10 | 运行中保存设置 | 已验证 | `acceptance.py::approval survives a settings save mid-run`（待审批 → PUT settings 200 → 继续批准成功，审批行 `approved`） |
| 11 | SSH 临时密码测试后 Agent 执行 | 未验证（无真实 SSH） | `ConnectionService` 单例由 `pytest tests/test_ssh.py tests/test_execution_ssh.py` 覆盖（fake paramiko + 本机子进程模拟 worker）；真实服务器不可用 |
| 12 | SSH 选远端目录读取专属数据 | 未验证（无真实 SSH） | `SSHExecutionBackend` SFTP/worker 接口单测覆盖；`probe_environment` 未对真实主机验证 |
| 13 | SSH 长任务、断线重连 | 未验证（无真实 SSH） | `spawn_process/process_log/process_cancel` 单测；真实 nohup/setsid 行为未验证 |
| 14 | SSH 副作用命令响应丢失 | 部分验证 | `manager.exec` 仅「未提交连接错误」重试一次，已提交失联返回 `status=unknown`+对账（`tests/test_ssh.py`）；真实网络不可用 |
| 15 | 停止一个会话/子任务 | 已验证 | `acceptance.py::scoped stop only cancels its own run`（另一运行继续、共享内核存活）；`tests/test_runtime.py::test_release_scope` |
| 16 | 两个分析子任务并行 | 部分验证 | 每个工作区独立 `KernelService`（`state.kernel_for(scope)`）+ 子运行 `max_child_tasks/depth` 限额（`tests/test_runtime.py`）；同工作区并行子任务的命名空间隔离未做真实压测 |
| 17 | 「不显著/p=0.8/FDR」文字不得升级 | 已验证 | `tests/test_evidence.py`（28 例）+ `tests/test_discovery.py`（纯文本不得提升、failed 不得伪装成功）；`engine._evaluate` 已删除 `STAT_TOKEN_RE` 逻辑 |
| 18 | 后台代码引用交互内存变量 | 部分验证 | 工具错误统一返回可操作中文提示（`tests/test_tools.py`）；未实现跨运行内存变量自动注入（按设计需显式 Artifact） |
| 19 | 大目录、大日志、慢网络 | 部分验证 | 日志按 `offset` 分页、目录树单层返回、`scripts/smoke.py` 有界检查；前端列表虚拟滚动未实现（记录为已知限制），未做真实大目录压测 |

## 4. T/F 修复对照

| 项 | 修复 | 证据 |
|---|---|---|
| F01 弹窗空层拦截 | `ui.js` 重写 `#modal-root` 指针事件、栈式关闭、异常提示 | 浏览器专项 + `components.css` |
| F02/F11 子代理事件与审批丢失 | 子运行走 `RunService.submit_child`，父 trace 发 `child_run`，失败结构化 `ToolError`（不再伪装文本） | `tests/test_runtime.py`；`acceptance.py::child task run is visible` |
| F03/T10 文本命中升级证据 | 删除文本规则，`AnalysisResult` + `EvidenceEvaluator`，LLM critic 不得覆盖数值判定 | `tests/test_evidence.py`、`tests/test_discovery.py` |
| F04 SSE 读超时/前端挂起 | 订阅看门狗 45s + `GET /api/runs/{id}` 对账重连；服务端 15s 心跳 | 前端浏览器证据；`runtime/runs.py` |
| F05 覆盖运行登记 | 会话单活跃约束 + `RunConflict`（409） | `acceptance.py::double submit` |
| F06 切页即终止 | 运行由服务端持有，订阅退出不取消 | `acceptance.py::reconnect/replay` |
| F07 默认 agents[0] | `GET /api/agents/default` → lead；旧偏好一次性迁移 | `acceptance.py::default agent` |
| F09 SSH cwd | `exec(cwd=...)` 前缀 cd；SSHBackend 固定 workspace root | `tests/test_ssh.py` |
| F10 共享连接服务 | `get_connection_service` 单例（REST/tools/backend/terminal） | `tests/test_ssh.py` 单例断言 |
| F12 全局停止波及其他会话 | 作用域取消 `runs.cancel(run_id)`，不再 `kernel.interrupt()` | `acceptance.py::scoped stop` |
| F13 盲目重试副作用 | 已提交失联 `status=unknown` + 对账，不第二次执行 | `tests/test_ssh.py` |
| F14 崩溃后伪装继续 | `recover_runs()` → `interrupted`，不自动重跑 | `acceptance.py::crash recovery` |
| F15 密码落盘 | `CredentialStore` 内存优先，无 keyring 时 `credential_stored=false`，旧 `b64:` 迁移不回显 | `tests/test_ssh.py` |
| T01 modal | 同上 F01 | 浏览器 |
| T02 审批中心 | `web/js/approvals.js` 全局 dock + 持久审批表 | 浏览器 + `acceptance.py::approval` |
| T03 运行订阅与重连 | `RunService` + `GET /api/runs/{id}/stream?after_seq` | `acceptance.py::replay/crash` |
| T04 子任务调度 | `submit_child`（并发/深度限额、任务行、父 trace 事件） | `tests/test_runtime.py`；`acceptance.py::child` |
| T05 统一工作区执行环境 | `WorkspaceService` + `ExecutionBackend`(Local/SSH) + 每工作区内核 | `acceptance.py::workspace isolation`；`tests/test_runtime.py` |
| T06 远端 worker | `ssh/worker.py` JSON-lines + `SSHExecutionBackend` | `tests/test_execution_ssh.py`（本机子进程模拟） |
| T07 默认 lead | `default_agent` 设置 + `GET /api/agents/default` | `acceptance.py::default agent` |
| T08 取消身份 | run 级 `cancel_for_run` / scoped stop | `acceptance.py::scoped stop`；`tests/test_runtime.py` |
| T09 工作台 UI | 顶部工作台条 + 工作区切换 + Results/Files/Variables/Compute | 浏览器截图（frontend2） |
| T11 迁移与恢复 | `schema_version=3`、`recover_runs`、旧会话可读；不保留两套执行逻辑（旧 `/api/chat` 为同 RunService 适配） | `tests/test_runtime.py`；`EventStore` |

## 5. 未验证 / 已知限制（不得宣称已完成）

1. **真实 SSH 服务器**：exec / SFTP / PTY / worker 上传启动、known_hosts 指纹变更、各类型私钥、远端 python3/conda 探测、nohup/setsid 作业取消、Windows→Linux 编码、200MB 边界真实网络——全部未验证（仅 fake paramiko + 本机子进程模拟）。
2. **真实 LLM 供应商**：验收使用脚本化 fake OpenAI 兼容服务；真实账号（DeepSeek/OpenAI/方舟等）未在本轮自动化中调用（设置页 `test_llm` 逻辑单元/冒烟已覆盖）。
3. **性能目标**：健康检查本地空载延迟已采样（见 `acceptance_report.json`），但「点击 ~100ms / 取消 1s 内受理 / 重连 5s 内恢复」未在真实浏览器+网络条件下测量，**不写“已达标”**。
4. **前端大列表虚拟滚动**：未实现；大目录/大日志依赖分页与后端有界返回，未做真实规模压测。
5. **macOS / Linux**：本机仅 Windows 验证；POSIX 脚本与终端分支未实测。
6. 同一工作区并行子运行共享该工作区的内核（同一执行环境，符合“同一执行环境”目标）；同名产物冲突需上层命名策略规避，未做专项压测。

## 6. 迁移与回退（§13）

- 升级前备份：`~/.omicslab` 或项目内 `.omicslab/`（conversations、trajectories、discovery、settings、auth、ssh 档案），原始文件不删除。
- 事件库 `runtime/events.db` 使用 `schema_version=3` + `PRAGMA user_version`；启动时 `recover_runs()` 只对账活跃运行为 `interrupted`，不伪造结果。
- 旧会话/旧台账可读：`Conversation`、`Evidence` 等保留 `from_dict` 兼容路径；旧聊天 REST 入口由新 RunService 承接，不并行两套执行逻辑。
- 回退：保留 1.1.0 的 wheel/sdist（`dist/`）与数据目录备份；回退后事件库仍可被 1.2.0 向前迁移，但 1.1.0 不读取 `runtime/events.db`（不影响旧功能）。
