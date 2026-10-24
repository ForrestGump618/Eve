# -*- coding: utf-8 -*-
"""Generate the remaining task-3 audit documents (integration/E2E, durability, installer,
traceability), update the parity-matrix summary, and re-issue the brand exceptions report.

All facts in the generated docs are taken from files that exist in this workspace or in
docs/research/evidence/. Nothing here invents a TARGET run: prototype evidence is labelled
PROTOTYPE, missing TARGET runs are labelled PENDING_LEAD / UNVERIFIED / NOT_STARTED.
"""
import csv
import hashlib
import os
import re
import json

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"
CWD = os.getcwd()
os.chdir(D)


def write(rel, text):
    p = os.path.join(D, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    return p


def sha256(rel):
    p = os.path.join(D, rel)
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


# ---------------------------------------------------------------- integration doc
integration = """# 集成与端到端验收（Integration & E2E）

日期：2026-10-25 · 负责人：docs-audit（D 角色） · 状态：部分验收（见下）
需求映射：R110-R121、R020-R026（桌面 UI 集成）、R031/R032（后台 daemon）、R060-R064（MCP/Skill）、R111（Provider）、R112（科研数据库）、R116（长跑/恢复）

## 1. 结论摘要（truthfulness first）

1. **TARGET 工作区（本仓库 `desktop-vnext/`）里没有可执行的安装包，也没有 TARGET 侧的 E2E 运行日志。**
   已存在的 Electron E2E / 桌面测试日志全部来自 **PROTOTYPE 工作区**
   `C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\2026-10-23\\c-users-qingyuan-zhuang-documents-deepseek-2\\outputs\\omicslab`
   （证据文件位于 `docs/research/evidence/`）。该原型树与 TARGET 的复制基线同为 `8cabac3`。
2. 复制之后 TARGET 新增/修改了一批文件（Lead 的 `import-service.ts`、`rpc/core.ts`、`conversations.ts`、
   `model-runtime.ts`、`activities/*.ts`、`shared/contract.ts`、`harness/store.ts`，以及后续出现的
   `domain/research.ts`、`domain/hypothesis.ts`、`domain/tools.ts` 等）。**这些文件不在任何已记录的测试日志覆盖范围内。**
3. 因此本报告区分两种结论：
   - `IMPLEMENTED_PASS_PROTOTYPE`：该能力在原型树被真实执行并通过（有日志/JSON 证据）；
   - `UNVERIFIED` / `NOT_STARTED`：TARGET 当前 revision 未被实际执行验证，必须由 Lead 复跑后升级。
4. 任何“已通过完整 vNext 验收 / 8h·24h·72h 稳定 / 干净机器安装 / 真实付费模型账号”的表述都**没有**证据支持。

## 2. 证据来源与适用范围

| 证据文件（docs/research/evidence/） | 内容 | 执行对象 | 局限 |
|---|---|---|---|
| `electron-e2e-result.json` | 打包 Electron E2E 10 项检查通过，`packaged: true`，daemonPid 20700 | PROTOTYPE 打包产物 | 模型为**本地 HTTP fixture**，无外部账号；路径为原型工作区 |
| `desktop-test.log` | `npm test` 48/48 通过、0 失败/0 跳过、80365.36 ms | PROTOTYPE 源码树 | 不含 TARGET 复制后新增文件 |
| `ui-locale-qa-result.json` | 8 组双语 DOM QA 通过 | PROTOTYPE UI + fixture IPC | 无真实 daemon/模型参与 |
| `python-full-test.log` | 482 passed / 1 warning / 36.52 s / EXIT_CODE=0 | PROTOTYPE Python 基线 | mock provider，隔离 home |
| `live-mcp-results.json` | Europe PMC + UniProt 真实只读调用通过 | PROTOTYPE 运行实例 | 2026-10-24 单次结果，非 TARGET 复跑 |
| `python-sample.json` | 固定 Python 统计样例可复现（均值/中位数/sha256） | PROTOTYPE 打包 worker | 无生物学推断，仅 stdlib |
| `windows-build.log` / `suwen-installer-inventory.txt` / `build-environment.json` | NSIS x64 安装包真实构建，未签名 | PROTOTYPE 构建机 | TARGET `desktop/release/` 不存在 |
| `runtime-npm-audit.json` / `runtime-sbom.cdx.json` | 生产依赖 0 漏洞；CycloneDX SBOM | PROTOTYPE `desktop/` | 复制后依赖未变化（lockfile 同哈希） |

## 3. 已记录通过的集成 / E2E 检查（全部为 PROTOTYPE 证据）

### 3.1 打包 Electron E2E（10 项，`electron-e2e-result.json`）

| # | 检查 | 结果 | 备注 |
|---|---|---|---|
| 1 | Electron main + detached `ELECTRON_RUN_AS_NODE` daemon 通过 named pipe 就绪 | PASS | 打包路径下执行 |
| 2 | 渲染进程无 Node `require`，仅 `contextBridge` 暴露受限 API | PASS | contextIsolation/sandbox 生效 |
| 3 | 模型配置用 `safeStorage` 加密落盘 | PASS | 无明文 key |
| 4 | 聊天 fixture 流式输出并提交（commit） | PASS | 本地 HTTP fixture |
| 5 | 关闭 UI 不杀死 daemon | PASS | 进程继续存活 |
| 6 | UI 退出后 30 s 持久计时器继续并完成，`start` 只提交一次 | PASS | timerTask `08f89316-9c5b-4e65-b0e3-44599113173c` |
| 7 | 重开窗口附着同一 daemon 并恢复历史 | PASS | 非新起进程 |
| 8 | 打包 daemon 继承系统代理 + 2 个真实只读 MCP 科研数据库查询通过 | PASS | Europe PMC / UniProt |
| 9 | 打包固定 Python sample worker 可复现 | PASS | 均值/哈希与基线一致 |
| 10 | 打包可选 Python workbench 隔离认证窗口拒绝未授权 HTTP | PASS | 独立 session 分区 |

运行时：Node 24.22.0 / Electron 45.0.0 / SQLite 3.53.4。模型协议明确记录为
`local HTTP fixture only; no external model account`（R111 的“外部账号不可用则用本地 fixture + 明确标注”路线）。

### 3.2 桌面 JS 测试（48/48）

`desktop-test.log`：`npm test` = `tsc && node --test dist/test/*.test.js`，48 tests / 48 pass / 0 fail / 0 skip，
总时长 80365.36 ms。覆盖 context（7 项，10 轮压缩 201,356..201,509 → 2,040..2,834 tokens）、context-async（4 项）、
daemon-integration、durable、import-service、legacy-worker、mcp、providers、security。

### 3.3 UI 双语 DOM QA（8 组）

`ui-locale-qa-result.json`：静态翻译节点/导航/选项切换、语言切换保留未保存设置、重复提交只产生一次任务、
欢迎页恢复、刷新后语言保持、summary 展开、取消 restore 不触发 RPC、批准重试耗尽后禁用、预算/预留/用量区分、
双语兼容性披露。**为 fixture IPC，无真实 daemon/模型**。

### 3.4 Python 基线（482 passed）

`python-full-test.log`：482 passed，1 条 FastAPI/Starlette httpx deprecation warning，36.52 s，EXIT_CODE=0；
解释器 `C:\\ProgramData\\miniconda3\\python.exe`，`OMICSLAB_PROVIDER=mock`，隔离 home，禁用缓存。

### 3.5 真实外部只读科研数据库调用

`live-mcp-results.json`：
- PubMed（Europe PMC）：query `TP53 cancer`，PASS，1427 ms，2026-10-24T15:14:57Z，
  `https://www.ebi.ac.uk/europepmc/webservices/rest/search`，保留 DOI/PMID/URL。
- UniProt：query `gene:TP53 AND organism_id:9606`，PASS，1241 ms，2026-10-24T15:14:58Z，release `2026_03`，
  返回 P04637 等 5 条。

### 3.6 固定 Python 分析样例可复现

`python-sample.json`：count=5，mean=5，median=4，min=2，max=9，sample_stdev=2.6457513110645907，
data_sha256=`7ddb348f009a4df254254ed1d8a71fd7102b2d5710751444d441d26065e02982`，Python 3.12.11。

## 4. TARGET 覆盖矩阵（当前状态）

| 需求 | 验收内容 | TARGET 当前证据 | 状态 |
|---|---|---|---|
| R110 | 多轮对话/取消/恢复/超长历史/输入不抖动 | ContextManager 实现与原型 48 测试覆盖；TARGET 未复跑 | UNVERIFIED |
| R111 | ≥2 Provider 适配器 + 错误可见 | 原型 OpenAI-compatible + Anthropic 本地 fixture 测试通过；无外部账号 | IMPLEMENTED_PASS（fixture 范围，外部账号 BLOCKED_EXTERNAL） |
| R112 | PubMed + 基因/蛋白库真实端到端调用 | 原型真实调用通过；TARGET daemon 尚未接入数据库 handler 之外的 MCP 运行 | UNVERIFIED（TARGET 未复跑） |
| R113 | Paper2Agent 安装/发现/禁用 | Python 基线有 skills/paper2agent + registry；TARGET 无导入/启用闭环 | NOT_STARTED |
| R114 | 沙箱执行公开样例并输出脚本/版本 | Python 基线执行器存在；TARGET 侧无新执行器 | UNVERIFIED |
| R115 | 多 Agent 辩论可审计 | 基线为串行 proposal/critique/revision；TARGET debate handler 未接线 | UNVERIFIED |
| R116 | UI 关闭后 daemon 继续、崩溃/重启恢复、租约回收可见 | 原型 E2E 检查 5/6/7 + SIGKILL 重启测试通过；TARGET 未复跑 | UNVERIFIED |
| R117 | 多次压缩/长工具输出/重启后保留目标与证据 | 原型 10 轮压缩、显式事实 100% 保留；重启保留未在 TARGET 复跑 | UNVERIFIED |
| R118 | 未授权 shell/文件操作被拒绝、敏感配置不泄漏 | 原型 security 测试 + named pipe 未授权 mutation 拒绝；TARGET 未复跑 | UNVERIFIED |
| R119 | 干净 Windows 安装/启动/升级/卸载 | 原型有安装包；干净 VM 生命周期未执行 | NOT_STARTED（PENDING_LEAD） |
| R120 | 8 份机器可读报告 | 全部 8 份文档已生成 | IMPLEMENTED_PASS |
| R121 | 最终交付说明 | 目录/证据已就绪，最终交付动作由 Lead 完成 | NOT_STARTED |

## 5. TARGET 侧已确认的集成缺口

1. **RPC 接线不完整**：`desktop/src/daemon.ts` 只 dispatch 12 个方法
   （`health/snapshot/create/control/approval/configure/python/shutdown/contextHistory/contextRestore/contextCompact/legacyStart`）；
   `desktop/src/shared/contract.ts` 声明约 85 个 `RPC_METHODS`；`desktop/src/rpc/core.ts`（337 行）实现了
   project/conversation/import/evidence/hypothesis/experiment/artifact/defaults/worker/doctor 系列，但**未注册进 daemon dispatch 或 main.ts 白名单**。
2. **preload/main 暴露面**同样只有旧集合（snapshot/create/control/approval/health/context*），
   vNext 页面所需的 project/conversation/import/research/skill/mcp/channel/rsi/defaults 方法不可达。
3. **UI 绑定不完整**（`docs/verification/ui-action-coverage.csv`，137 个控件）：
   WIRED 115 + WIRED_DELEGATED 10 + WIRED_VIA_FORM 1 = 126；`NOT_WIRED` 9 个：
   `import-wizard`、`research-launchers`、`launch-knowledge`、`launch-hypothesis`、`launch-debate`、
   `launch-methods`、`launch-analysis`、`launch-discovery`、`launch-autonomy`；`STATIC_MARKUP` 2 个（纯展示）。
   已声明未被调用的 RPC 18 个：conversation.delete/update、evidence.get、experiment.create/list/result、
   hypothesis.get/list、legacyStart、python、research.analysis/autonomy/debate/discovery/hypothesis/knowledge/methods、secrets.set。
4. **编码缺陷（FIX_REQUIRED，不属品牌问题）**：`desktop/src/rpc/core.ts` 中文字符串被 GBK↔UTF-8 二次编码破坏
   （如 line 129 `'新会话'` 变为乱码、doctor 检查消息 lines 312/316/317/319/321/325/326/328/331-332 乱码），
   需 Lead 以 UTF-8 重写这些字面量后再接线。
5. **未执行**：TARGET 上 `npm ci && npm test`；打包 smoke E2E；真实模型账号；安装包构建；8/24/72h。
6. `desktop/scripts/electron-smoke.mjs`（8,682 B）与 `dist/test/`（8 个编译文件）存在，但 TARGET 侧尚未有运行记录。

## 6. PENDING_LEAD（需 Lead 执行并把结果写回证据目录）

1. TARGET 复跑：`cd desktop; npm ci; npm test`，把完整日志保存为 `docs/research/evidence/target-desktop-test.log`（含 TARGET 绝对路径与时间戳）。
2. TARGET 打包并执行 E2E：`npm run dist:win` → 安装 → 按 `electron-e2e-result.json` 的 10 项重跑，另存 `target-electron-e2e-result.json`。
3. 外部模型账号：若可用，记录真实 provider 调用（脱敏），否则保持 `BLOCKED_EXTERNAL` 并在报告中写明。
4. 修复 `rpc/core.ts` 乱码并把 rpc/core handlers 接入 daemon dispatch + main/preload 白名单；重跑桌面测试。
5. 安装包/干净 VM 生命周期与 SHA256SUMS 见 `docs/release/windows-installer-verification.md`。
6. 8/24/72h 与灾难场景见 `docs/verification/durability-chaos-tests.md`；未执行前不得对外宣称。

## 7. 复现命令（只读/构建，均在本仓库内）

```powershell
cd C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\SuWen\\desktop-vnext\\desktop
npm ci
npm test
npm run dist:win
Get-FileHash release\\SuWen-Setup-*-win-x64.exe -Algorithm SHA256
```

测试不得访问公网（见 `docs/architecture/vnext-contract.md`）；真实外部数据库/MCP 调用单独记录。

## 8. 状态统计

- 已执行并记录的集成/E2E 检查：10（E2E）+ 48（JS 测试）+ 8（DOM QA）+ 482（Python 基线）+ 2（真实 DB 查询）= **550 项通过（原型树）**。
- TARGET 当前 revision 复跑：**0 项**（等待 Lead）。
- 缺口：RPC 接线、9 个 UI 控件、18 个未调用 RPC、编码缺陷、安装包生命周期、长时稳定。
"""

# ---------------------------------------------------------------- durability doc
durability = """# 长时稳定性与混沌/故障注入验收（Durability & Chaos）

日期：2026-10-25 · 负责人：docs-audit（D） · 结论：**未完成 8h/24h/72h 长跑，不得宣称通过**
需求映射：R033-R039、R050、R116、R025、R038

## 1. 结论摘要

1. 代码层面已实现租约/围栏、心跳、过期回收、持久计时器、outbox 幂等、检查点、预算中止、审批持久等待、
   WAL/`synchronous=FULL`、单实例锁、detached daemon（见第 2 节代码证据）。
2. 已记录的故障注入**仅有短时**：原型测试中 daemon 被 SIGKILL 后重启恢复（约 7873 ms 注入窗口），
   以及 UI 退出后 30 s 计时器继续、`start` 仅执行一次、重开窗口附着同一 daemon。
3. **8h / 24h / 72h 续航、断电、重启、睡眠、磁盘满、网络中断、429/5xx 压力均未执行。**
   `docs/research/evidence/build-environment.json` 明确记录 `elapsed72hTest: "not performed"`、
   `cleanVmInstallerLifecycle: "not performed"`。R050 在 TARGET 侧为 `UNVERIFIED`（受环境/时间限制）。
4. 若需要对外声明，必须按第 5 节方案真实执行并保留日志；在此之前只能写“已实现机制 + 短时故障注入通过”。

## 2. 实现机制审查（代码证据，TARGET）

| 机制 | 代码位置 | 关键实现 | 审查结论 |
|---|---|---|---|
| SQLite WAL + FULL + FK + busy_timeout | `desktop/src/harness/store.ts` | `PRAGMA journal_mode=WAL; synchronous=FULL; foreign_keys=ON; busy_timeout=5000` | 已实现 |
| schema 版本 + 迁移前备份 | 同上 | `SCHEMA_VERSION=3`，迁移前 `VACUUM INTO <db>.pre-v3-<ts>-<uuid>.bak`，`PRAGMA quick_check` | 已实现 |
| 任务 DAG / 步骤表 | 同上 | `steps(task_id,id,kind,dependencies_json,side_effect,max_attempts,timeout_ms,status,version,operation_id UNIQUE,attempts,owner,fence,lease_until,due_at,prior_status,...)` | 已实现 |
| 租约 + 围栏 | 同上 | `claim(owner,leaseMs,canRun)` 原子 `fence+1`、`lease_until`；`requireLease` 校验 owner/fence/leaseUntil；`reclaimExpired` | 已实现 |
| 心跳 | 同上 + `harness/engine.ts` | 引擎按 `max(10, min(leaseMs,timeoutMs)/3)` 间隔延长租约 | 已实现 |
| 持久计时器 | `store.ts` | `defer` → `waiting_external` + `due_at`；到点提交完成并写 `timer.fired`，**不重跑业务** | 已实现 |
| outbox 幂等 | `store.ts` | `outbox(operation_id PK, status)`；`side_effect` 步骤 claim 时写 `dispatched`，完成置 `confirmed`，未知结果 `unknown` 不走盲目重放 | 已实现 |
| 检查点 | `store.ts` | `checkpoints(id,task_id,at,reason,snapshot_json)`；task/step 状态迁移时落检查点 | 已实现 |
| 预算/取消/重试 | `store.ts` + `engine.ts` | 预算耗尽 `budget_exhausted`；pause/cancel/resume；`ValidationError` 不重试、`retryable/definitive/retryAfterMs` 分类 | 已实现 |
| 审批持久等待 | `store.ts` + `daemon.ts` | `waiting_approval` + outbox `unknown`，`approval` RPC 显式 resolve | 已实现 |
| daemon 生命周期 | `desktop/src/daemon.ts`、`main.ts` | `daemon.lock` 单实例；UI 关闭不退出；named pipe token 认证、newline JSON、2 MB 上限 | 已实现 |
| 崩溃对账 | `store.ts` | 启动 `quick_check`；`refresh/Task` 将悬挂 running 步骤按租约/outbox 处理，未知副作用要求人工核对 | 已实现（短时测试覆盖） |

## 3. 已执行的故障注入（PROTOTYPE 证据）

| 场景 | 执行方式 | 结果 | 证据 | 局限 |
|---|---|---|---|---|
| daemon SIGKILL 后重启 | 原型测试进程杀死 daemon，重启并恢复任务 | PASS，注入窗口 7873 ms；测试耗时 7895.02 ms | `desktop-test.log`（daemon/持久测试条目） | 短时、单机 |
| UI 关闭后后台继续 | 关闭窗口，等待 30 s 持久计时器 | PASS：计时器完成；`start` 仅提交一次 | `electron-e2e-result.json` 检查 5/6 | 30 s，非 8h |
| 重开窗口恢复 | 关闭再打开 UI | PASS：附着同一 daemon、历史恢复 | `electron-e2e-result.json` 检查 7 | 未覆盖重启 OS |
| 未授权 named pipe 写操作 | 无 token/错误 token 调用 mutation | PASS：拒绝 | `desktop-test.log` security 测试 | 仅本机 |
| 长历史压缩重启 | 10 轮压缩后重启上下文 | 原型测试：显式事实 100% 保留（201,356..201,509 → 2,040..2,834 tokens） | `desktop-test.log` / `docs/progress.md` | 非 OS 级重启，语义覆盖率未量化 |
| 未知副作用对账 | 模拟外部结果未知 | 进入人工核对路径，不盲目重放 | `desktop-test.log` durable 测试 | 未接真实外部系统错误码 |

## 4. 未执行的场景矩阵（PENDING_LEAD；执行前状态=`UNVERIFIED`）

| 场景 | 要求 | 当前状态 | 建议执行方式 |
|---|---|---|---|
| 8h 连续运行 | R050 | NOT_PERFORMED | 启动 daemon + 周期 durable timer 任务（每分钟），每 30 min 调 `doctor.run`/`snapshot` 记录，8h 后核对事件与检查点 |
| 24h 连续运行 | R050 | NOT_PERFORMED | 同上 24h，加入模型 fixture 调用与工具输出 |
| 72h 连续运行 | R050 | NOT_PERFORMED | 同上 72h，记录内存/句柄/磁盘增长（`Get-Process`、`Get-PSDrive`） |
| Windows 重启恢复 | R050/R116 | NOT_PERFORMED | 创建长任务后 `Restart-Computer`，重启后 `doctor.run` + `snapshot` 验证回收/恢复 |
| 睡眠/唤醒 | R050 | NOT_PERFORMED | 任务运行中 `powercfg /sleep`/合盖，唤醒后校验计时器与租约 |
| 断电（强制关机） | R050 | NOT_PERFORMED | VM 中 `Stop-Computer -Force`，重启后检查 SQLite 完整性与 outbox |
| 磁盘满 | R050/R037 | NOT_PERFORMED | VM 中填充磁盘至 >95%，创建大工具输出任务，验证 budget_exhausted/错误提示 |
| 网络中断/429/5xx | R050/R037 | NOT_PERFORMED | 本地 fixture 服务返回 429/503/超时，观察重试+退避+上限 |
| 模型持续慢响应/超时 | R037 | NOT_PERFORMED | fixture 延迟 > timeout，验证取消传播 |
| 并发多任务/多窗口 | R037/R031 | NOT_PERFORMED | 并发 4+ durable 任务 + 多窗口，检查 lease/并发上限与事件一致性 |

## 5. 建议的长跑/混沌执行方案（可直接使用）

```powershell
# 1) 启动打包或 dev daemon（示例：dev）
cd C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\SuWen\\desktop-vnext\\desktop
npm run build
$env:SUWEN_TEST_HOME = "$env:TEMP\\suwen-soak-home"
node dist/src/daemon.js --home $env:SUWEN_TEST_HOME   # 或由 electron 拉起

# 2) 创建 1 分钟周期 durable timer 任务（示例参数以 UI/contract 为准）
#    每 30 分钟：
node dist/src/daemon.js ...  # 通过 pipe 调 health/doctor.run/snapshot，写日志
#    记录：Get-Process -Id <daemonPid> 的 CPU/WorkingSet、Get-PSDrive C、日志末尾 100 行

# 3) 故障注入
Stop-Process -Id <daemonPid> -Force      # SIGKILL 等价
# 重新启动 daemon，调用 snapshot/doctor.run，核对 outbox=confirmed、无重复副作用
# 4) 重启/断电：VM 快照前保存 home 目录；恢复后对比 sqlite 完整性（PRAGMA quick_check）
```

判定标准（执行时写入证据文件，勿提前宣称）：
- 计时器 `start` 副作用在所有场景下只出现一次（outbox `confirmed`、事件唯一）；
- 租约过期被回收，任务从检查点继续，不重复执行已完成步骤；
- 进程重启后 `snapshot` 可恢复任务状态与上下文引用；
- 不出现 SQLite 损坏（`quick_check=ok`）、不出现明文凭据；
- 记录内存/句柄/磁盘增长曲线，72h 不超预算。

## 6. 状态汇总

- 已实现并可审查的可靠性机制：12 项（第 2 节）。
- 已执行的真实故障注入：5 类（第 3 节，原型树、短时）。
- 未执行：8h/24h/72h、重启、睡眠、断电、磁盘满、网络故障、并发压力（第 4 节）→ R050 = `UNVERIFIED`。
- 公开表述建议：只能写“已实现租约/围栏/outbox/检查点机制；短时 SIGKILL 与 30 s 后台计时器通过；长时稳定未验证”。
"""

# ---------------------------------------------------------------- installer doc
installer = """# Windows x64 安装包验证（Windows Installer Verification）

日期：2026-10-25 · 负责人：docs-audit（D） · TARGET 状态：**NOT_STARTED（尚未在 TARGET 构建/安装）**
需求映射：R100-R103、R119、R092（许可证）、R103（SmartScreen 诚实披露）

## 1. 结论摘要

1. **TARGET 工作区没有 `desktop/release/`，也没有任何安装包/`.blockmap`/`SHA256SUMS` 文件**（已递归搜索，排除 `node_modules`）。
2. 原型工作区有真实 NSIS x64 安装包构建证据（`windows-build.log`、`suwen-installer-inventory.txt`、`build-environment.json`）：
   大小 129,363,809 B，SHA-256 `f263af7bb412ccbb2fb3a8f1798d35d2a7210997954e68669ed110b62a55514c`，
   **未签名**（`signed: false`，`signExecutable` skipped）。
3. 干净 Windows 上的安装/启动/升级/卸载生命周期：`build-environment.json` 记录
   `cleanVmInstallerLifecycle: "not performed"` → **未执行**，不得宣称通过。
4. 因此：构建配置与原型产物可核验；TARGET 安装包与 R119 验收 = `NOT_STARTED / PENDING_LEAD`。

## 2. 构建配置（`desktop/package.json` 证据）

| 配置项 | 值 | 说明 |
|---|---|---|
| `scripts.dist:win` | `npm run build && electron-builder --win nsis --x64` | 构建入口 |
| `build.appId` | `org.suwen.desktop` | 应用身份 |
| `build.productName` | `SuWen` | 产品名 |
| `build.asar` | `false` | 打包为明文目录（`windows-build.log` 有 asar disabled 警告） |
| `build.output` | `release` | 产物目录 |
| `build.artifactName` | `SuWen-Setup-${version}-win-${arch}.${ext}` | 安装包命名 |
| `build.win.target` | `nsis` / `x64` | Windows x64 NSIS |
| `build.win.signExecutable` | `false` | **不签名** |
| `build.win.icon` | `assets/suwen.ico` | 图标 |
| `nsis.oneClick` | `false` | 可选安装目录 |
| `nsis.perMachine` | `false` | 默认按用户安装 |
| `nsis.allowToChangeInstallationDirectory` | `true` | 可改目录 |
| `nsis.deleteAppDataOnUninstall` | `false` | 卸载默认保留用户数据（R102） |
| `nsis.shortcutName` / `uninstallDisplayName` | `SuWen` | 快捷方式/卸载显示名 |
| `extraResources` | `worker/*.py → worker`；`..` → `legacy`（过滤 `omicslab/**/*.py`、`omicslab/web/**`、`omicslab/skills/**`、`omicslab/agents/**`、`omicslab/data/**`、`LICENSE`） | 可选 Python 兼容工作台（Apache-2.0 原样分发） |

## 3. 原型构建产物证据（PROTOTYPE，不是 TARGET）

| 项目 | 值 | 证据 |
|---|---|---|
| 构建工具 | electron-builder 26.18.0，Electron 45.0.0，win32 x64 | `windows-build.log` |
| 构建系统 | Windows-11-10.0.26200（2026-10-24 Asia/Shanghai） | `build-environment.json` |
| 安装包 | `SuWen-Setup-3.0.0-preview.1-win-x64.exe` | `windows-build.log` / `suwen-installer-inventory.txt` |
| 大小 | 129,363,809 B（约 123.4 MiB） | `build-environment.json` / inventory |
| SHA-256 | `f263af7bb412ccbb2fb3a8f1798d35d2a7210997954e68669ed110b62a55514c` | `build-environment.json` / `docs/release-notes-vnext.md` |
| NSIS | NSIS-3 Unicode；`app-64.7z` 128,736,919 B；`Uninstall SuWen.exe` 177,807 B packed | `suwen-installer-inventory.txt` |
| 签名 | `signed: false`（未签名） | `build-environment.json` |
| 干净机安装 | `not performed` | `build-environment.json` |
| 72h 运行 | `not performed` | `build-environment.json` |

> 重要：上述路径位于原型工作区
> `C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\2026-10-23\\c-users-qingyuan-zhuang-documents-deepseek-2\\outputs\\omicslab\\desktop\\release`。
> TARGET `desktop-vnext` 内没有对应 `.exe`，不能把该哈希当作 TARGET 交付物的哈希。

## 4. 发布验收清单（R100/R102/R103/R119）

| 项 | 要求 | 当前状态 | 证据/缺口 |
|---|---|---|---|
| 构建产物 | 真实 NSIS x64 安装包 | 原型 PASS / TARGET NOT_STARTED | 见第 3 节 |
| 完整性与哈希 | SHA256SUMS 可验证 | 原型哈希有，SHA256SUMS 文件需在 TARGET 生成 | PENDING_LEAD |
| 干净机器安装 | 安装→启动→基本聊天 | NOT_PERFORMED | PENDING_LEAD（VM） |
| 升级安装 | 旧版本→新版本，DB 迁移+备份 | NOT_PERFORMED | PENDING_LEAD |
| 卸载 | 默认保留用户数据；可选清理 | NOT_PERFORMED（配置已设 `deleteAppDataOnUninstall:false`） | PENDING_LEAD |
| SmartScreen | 如实披露未签名风险 | 已在 `docs/release-notes-vnext.md` 披露 | 等价声明需随最终交付 |
| 应用身份 | 名称 SuWen、图标、appId | 配置与原型产物一致 | 原型检查通过 |
| 许可证/NOTICE | MIT + NOTICE + third-party-licenses + legacy Apache-2.0 | 已在 `desktop/` 内 | 原型打包内含（`files` + `extraResources`） |

## 5. TARGET 构建与校验步骤（Lead 执行）

```powershell
cd C:\\Users\\Qingyuan Zhuang\\Documents\\Codex\\SuWen\\desktop-vnext\\desktop
npm ci
npm test
npm run dist:win
Get-ChildItem release
$exe = Get-ChildItem release\\SuWen-Setup-*-win-x64.exe | Select-Object -First 1
$hash = (Get-FileHash $exe.FullName -Algorithm SHA256).Hash.ToLower()
"$hash  $($exe.Name)" | Set-Content release\\SHA256SUMS -Encoding UTF8
Get-FileHash $exe.FullName -Algorithm SHA256
```

干净 Windows VM（建议快照）验收步骤：
1. 全新 Windows 11 x64（无 Node/Python/旧版 SuWen），记录系统版本与时间。
2. 安装 → 启动 → 五工作区可打开 → 无 Python 时基本聊天/MCP 可用且有诊断提示（R101）。
3. 保存 `%APPDATA%\\SuWen` 数据 → 关闭 UI → 确认 daemon 继续（`Get-Process`）。
4. 升级：安装上一版本 → 覆盖升级 → 检查 DB 版本迁移与 `migration/backup-*` 备份。
5. 卸载：默认保留用户数据；再卸载并选择清理时数据删除。
6. 保存安装日志、`doctor.run` JSON、截图目录、SHA256SUMS 到 `docs/research/evidence/target-installer-verification/`。

## 6. SmartScreen 诚实声明（可直接随交付引用）

> 本安装包由 electron-builder 生成，**没有商业代码签名证书**。Windows SmartScreen 可能显示
> “未知发布者/此应用未受信任”的提示；这是未签名构建的正常表现，不代表安装包被篡改。
> 请用发布方提供的 SHA-256 校验安装包完整性后再运行。正式对外分发前应采购代码签名证书并重新签名，
> 本仓库当前不宣称“已签名/已通过 SmartScreen”。

## 7. PENDING_LEAD

1. TARGET 执行 `npm run dist:win`，记录 `windows-build.log` 与安装包大小/SHA-256，生成 `release/SHA256SUMS`。
2. 干净 Windows VM 完成第 5 节 6 步并归档证据。
3. 决定是否在最终交付前签名（无证书则保留第 6 节声明）。
4. 将最终安装包路径+哈希写入 `docs/progress.md` 与最终交付说明（R121）。
5. 注意 `asar:false` 的暴露风险，若后续改为 `asar:true` 需重新验证 worker/legacy 资源路径。
"""

# ---------------------------------------------------------------- traceability
rows = list(csv.DictReader(open(os.path.join(D, "docs", "requirements", "master-requirements.csv"), encoding="utf-8")))
header = list(rows[0].keys()) if rows else []
print("master header:", header)


def pick(*cands, contains=None):
    low = {k.lower(): k for k in header}
    for c in cands:
        if c in header:
            return c
        if c.lower() in low:
            return low[c.lower()]
    if contains:
        for k in header:
            if contains in k.lower():
                return k
    return None


k_id = pick("id")
k_req = pick("requirement", "requirement_short", contains="requir") or header[1]
k_status = pick("status", contains="status") or header[-2]
k_paths = pick("code_paths", "paths", contains="path") or ""
k_ev = pick("test_or_log", "evidence", contains="evidence") or ""
k_scope = pick("evidence_scope", contains="scope") or ""
k_gap = pick("remaining_gap", "gap", contains="gap") or ""
k_py = pick("python_baseline", contains="python") or ""

def cell(s, n=110):
    s = (s or "").replace("|", "/").replace("\n", " ").strip()
    return s[: n - 1] + "…" if len(s) > n else s

lines = []
lines.append("# 需求—代码—验证 追溯矩阵（Traceability）")
lines.append("")
lines.append("日期：2026-10-25 · 负责人：docs-audit（D）")
lines.append("")
lines.append("## 1. 追溯来源")
lines.append("")
lines.append("| 来源 | 路径 | 用途 |")
lines.append("|---|---|---|")
lines.append("| 需求登记册（Lead 唯一需求源） | `docs/requirements/master-requirements-source.md` | 71 条 R 需求原文与允许状态 |")
lines.append("| 机器可读需求表 | `docs/requirements/master-requirements.csv` | 每条需求：代码路径/测试/证据范围/状态/缺口 |")
lines.append("| Python 基线审计 | `docs/migration/python-feature-inventory.md` | 基线入口、页面、路由、模块、技能、测试（R010） |")
lines.append("| 功能对照矩阵 | `docs/migration/feature-parity-matrix.csv/.md` | 67 条能力：Python 基线/桌面原型/vNext/迁移方式（R011） |")
lines.append("| 复制与来源验证 | `docs/migration/source-inventory.md`、`copy-verification.md` | R001-R003 |")
lines.append("| UI 动作覆盖 | `docs/verification/ui-action-coverage.csv` | 137 个控件绑定状态（R024/R026/R120） |")
lines.append("| 架构契约 | `docs/architecture/vnext-contract.md`、`current.md` | 所有权、RPC、Store v3、测试纪律 |")
lines.append("| 证据目录 | `docs/research/evidence/*` | 原型树测试/构建/真实数据库调用（务必注意 PROTOTYPE 范围） |")
lines.append("| 冲突与非正式需求 | `docs/requirements/conflicts.md` | `docs/SUWEN-V2-REQUIREMENTS.md` 与 R 登记册差异 |")
lines.append("")
lines.append("## 2. 状态规则")
lines.append("")
lines.append("- 仅 `IMPLEMENTED_PASS` 视为完成；`UNVERIFIED` = 代码存在但本工作区无当前 revision 的执行证据；")
lines.append("  `NOT_STARTED` = TARGET 无实现；`BLOCKED_EXTERNAL` = 依赖外部账号/VM/证书等不可得资源；")
lines.append("  `N/A_PORT`/`REPLACED` 仅用于 Python→vNext 能力对照，不用于需求完成度。")
lines.append("- 任何“已签名/8·24·72h/干净机安装/真实付费账号”结论必须指向 `docs/research/evidence/` 或 TARGET 运行日志，")
lines.append("  否则保持 UNVERIFIED，并在本表与 CSV 中写明缺口。")
lines.append("")
lines.append("## 3. 全量追溯表（71 条）")
lines.append("")
lines.append("| ID | 需求（摘要） | TARGET 代码/文档路径 | 验证方式与证据 | 状态 | 剩余缺口 |")
lines.append("|---|---|---|---|---|---|")
for r in rows:
    lines.append("| {id} | {req} | {paths} | {ev} | **{st}** | {gap} |".format(
        id=cell(r.get(k_id, ""), 10),
        req=cell(r.get(k_req, ""), 90),
        paths=cell(r.get(k_paths, ""), 120),
        ev=cell(r.get(k_ev, ""), 90),
        st=cell(r.get(k_status, ""), 22),
        gap=cell(r.get(k_gap, ""), 90),
    ))
lines.append("")
lines.append("## 4. 关键映射（便于抽查）")
lines.append("")
lines.append("| 需求 | 关键代码 | 关键证据 |")
lines.append("|---|---|---|")
lines.append("| R001-R003 复制验证 | `docs/research/repro/copy-verify.ps1` | `docs/migration/copy-verification.md`：326/327 文件哈希一致、`.git` 654 文件全一致 |")
lines.append("| R010-R011 | `omicslab/**`、`tests/**`、`docs/migration/*` | Python 482 passed（PROTOTYPE）；67 行对照矩阵 |")
lines.append("| R012/R090 | `desktop/src/import-service.ts`、`docs/research/branding-exceptions.md` | 非破坏导入代码审查；来源只读、备份优先 |")
lines.append("| R030-R039 | `desktop/src/main.ts`、`security.ts`、`daemon.ts`、`harness/store.ts`、`engine.ts` | 原型 48 测试 + E2E；TARGET 未复跑 |")
lines.append("| R040-R047 | `desktop/src/context.ts`、`context-async.ts` | 原型 10 轮压缩 201,356..201,509 → 2,040..2,834 tokens，显式事实 100% 保留 |")
lines.append("| R050 | `docs/verification/durability-chaos-tests.md` | 8/24/72h 未执行（`build-environment.json`） |")
lines.append("| R110-R121 | 本文件 + `integration-and-e2e.md` + `ui-action-coverage.csv` | E2E 10 项、DOM QA 8 组、真实 DB 2 次调用均为原型证据 |")
lines.append("")
lines.append("## 5. 追溯性缺口（必须由 Lead 补齐）")
lines.append("")
lines.append("1. TARGET 当前 revision 的桌面测试日志（覆盖复制后新增的 8+ 文件与 domain/** 模块）。")
lines.append("2. TARGET 打包 E2E 结果、安装包哈希、干净 VM 生命周期证据。")
lines.append("3. 真实外部模型账号调用证据，或明确的 `BLOCKED_EXTERNAL` 决策记录。")
lines.append("4. RPC 接线完成后的 `ui-action-coverage.csv` 复算（当前 9 个控件 NOT_WIRED、18 个 RPC 未调用）。")
lines.append("5. `rpc/core.ts` 乱码修复、`docs/progress.md` 状态更新与最终交付说明（R121）。")
write(os.path.join("docs", "requirements", "traceability.md"), "\n".join(lines) + "\n")

# ---------------------------------------------------------------- brand scan + exceptions doc
pat = re.compile(r"omicslab|omiclab", re.I)
skip = {".git", "node_modules", "release", "dist", "dist-lead", "__pycache__", ".pytest_cache", "build", ".omicslab"}
ext_ok = {".md", ".py", ".ts", ".cts", ".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".toml", ".cff",
          ".txt", ".ps1", ".sh", ".html", ".css", ".in", ".cfg", ".svg", ".jsonc"}
hits = {}
classes = {}
files_by_class = {}


def classify(rel):
    p = rel.replace(os.sep, "/")
    if p.startswith("omicslab/"):
        return "LEGACY-PACKAGE-NAMESPACE"
    if p.startswith("tests/"):
        return "LEGACY-TESTS"
    if p.startswith("scripts/"):
        return "LEGACY-SCRIPTS"
    if p.startswith("desktop/"):
        return "LEGACY-DESKTOP-BRIDGE"
    if p.startswith("docs/archive/") or p in ("CHANGELOG.md", "docs/UPGRADE-1.3.md", "docs/VALIDATION-1.3.md"):
        return "LEGACY-DOC-HISTORY"
    if p.startswith(("docs/architecture/", "docs/research/", "docs/migration/", "docs/requirements/",
                     "docs/verification/", "docs/release/")) or p in ("docs/progress.md", "docs/release-notes-vnext.md"):
        return "AUDIT-DOCS"
    if p in ("LICENSE", "NOTICE", "CITATION.cff", "desktop/LICENSE", "desktop/NOTICE"):
        return "ATTRIBUTION-LEGAL"
    if p.startswith("docs/") or p in ("README.md", "README.en.md", "CONTRIBUTING.md", "FAQ.md"):
        return "COMPAT-DOCS-ACTIVE"
    return "OTHER"


for dirpath, dirnames, filenames in os.walk(D):
    dirnames[:] = [d for d in dirnames if d not in skip]
    for fn in filenames:
        if os.path.splitext(fn)[1].lower() not in ext_ok:
            continue
        fp = os.path.join(dirpath, fn)
        rel = os.path.relpath(fp, D)
        try:
            txt = open(fp, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        n = len(pat.findall(txt))
        if n:
            hits[rel] = n
            c = classify(rel)
            classes[c] = classes.get(c, 0) + n
            files_by_class.setdefault(c, set()).add(rel)

is_new = lambda rel: rel.replace(os.sep, "/").startswith(
    ("docs/migration/", "docs/requirements/", "docs/verification/", "docs/release/", "docs/research/")) or rel.replace(os.sep, "/") == "docs/progress.md"
new_hits = {k: v for k, v in hits.items() if is_new(k)}
old_hits = {k: v for k, v in hits.items() if not is_new(k)}
print("brand total", sum(hits.values()), "files", len(hits), "classes", classes)
print("brand new-audit", sum(new_hits.values()), len(new_hits), "old", sum(old_hits.values()), len(old_hits))
top = sorted(hits.items(), key=lambda kv: -kv[1])[:20]
examples = {c: sorted(fs, key=lambda f: -hits.get(f, 0))[:3] for c, fs in files_by_class.items()}

brand = []
brand.append("# 旧品牌标识审计与例外清单（Brand Exceptions）")
brand.append("")
brand.append("日期：2026-10-25（更新） · 负责人：docs-audit（D） · 对应需求：R090/R091/R092/R024")
brand.append("")
brand.append("## 1. 结论（诚实边界）")
brand.append("")
brand.append("- UI/安装清单/桌面代码中**未发现应改而未改的品牌文案**（`desktop/ui` 内旧品牌 0 命中；桌面新代码仅兼容读取路径命中，见下）。")
brand.append("- Python 包名/命名空间/环境变量/数据目录/API 标识属于**兼容契约**，按 R090 允许保留（历史数据字段、迁移标识），")
brand.append("  统一标注 `LEGACY-BRAND-COMPAT`，**不能宣称“全仓库零旧品牌”**。")
brand.append("- 全仓库最终扫描：**{tot} 处命中 / {files} 个文本文件**；其中本轮新增审计/验证文档贡献 {nh} 处、{nf} 文件；")
brand.append("  排除本轮新增审计文档后为 **{oh} 处 / {of} 个文件**。")
brand.append("- `FIX_REQUIRED`（品牌文案层面）：**0**。另有一个**编码缺陷**需修复（非品牌）：")
brand.append("  `desktop/src/rpc/core.ts` 中文字面量被二次编码破坏（line 129 `新会话`、doctor 消息 lines 312-332 乱码），见 `docs/requirements/conflicts.md` C-02。")
brand.append("")
brand.append("## 2. 扫描方法（可复现）")
brand.append("")
brand.append("```powershell")
brand.append("# 正则（大小写不敏感）")
brand.append("rg -n -i \"omicslab|omiclab\" .")
brand.append("# 排除：.git、node_modules、release、dist、dist-lead、__pycache__、.pytest_cache、build、.omicslab 与二进制/字体/图片")
brand.append("```")
brand.append("")
brand.append("机器可读结果：`docs/research/branding-scan-summary.json`（按分类统计 + Top 文件）。")
brand.append("")
brand.append("## 3. 分类统计")
brand.append("")
brand.append("| 分类 | 命中 | 文件 | 处理结论 |")
brand.append("|---|---|---|---|")
cls_note = {
    "LEGACY-PACKAGE-NAMESPACE": "兼容：Python 包名/命名空间/环境变量/数据目录/内核名，保留并加注释",
    "LEGACY-TESTS": "兼容：测试导入与 fixture 必须使用真实包名",
    "LEGACY-SCRIPTS": "兼容：发布/校验/冒烟脚本依赖真实分发名 `omicslab`",
    "LEGACY-DESKTOP-BRIDGE": "兼容：旧数据导入/兼容工作台读取路径 `~/.omicslab`、`OMICSLAB_HOME`，已注释 LEGACY-BRAND-COMPAT",
    "LEGACY-DOC-HISTORY": "历史文档：归档/升级/验证记录，保持原文",
    "AUDIT-DOCS": "审计/验证文档：描述基线时引用旧名，属证据而非产品文案",
    "COMPAT-DOCS-ACTIVE": "现行文档：明确说明包名/数据目录兼容策略，属有意保留",
    "ATTRIBUTION-LEGAL": "许可证/引用归属（CITATION.cff `OmicsLab contributors`），不可单方面改名 → PENDING_LEAD 决策",
    "OTHER": "其他：pyproject 等构建元数据中的分发名兼容",
}
for c, n in sorted(classes.items(), key=lambda kv: -kv[1]):
    brand.append("| `{c}` | {n} | {f} | {note} |".format(c=c, n=n, f=len(files_by_class[c]), note=cls_note.get(c, "")))
brand.append("")
brand.append("## 4. 桌面侧命中明细（仅兼容读取，已注释）")
brand.append("")
brand.append("| 文件 | 用途 | 结论 |")
brand.append("|---|---|---|")
brand.append("| `desktop/src/import-service.ts` | 旧 home 默认 `~/.omicslab`、`SUWEN_LEGACY_HOME`、只读导入 | LEGACY-BRAND-COMPAT |")
brand.append("| `desktop/src/legacy-worker.ts` | 探测旧 Python 源码 `omicslab/config.py` | LEGACY-BRAND-COMPAT |")
brand.append("| `desktop/worker/legacy_server.py` | 兼容工作台启动（`OMICSLAB_HOME/DATA_DIR`、`from omicslab...`） | LEGACY-BRAND-COMPAT |")
brand.append("| `desktop/package.json` | `extraResources` 过滤 `omicslab/**` 旧源码 | LEGACY-BRAND-COMPAT |")
brand.append("| `desktop/scripts/*`（如存在） | 验收/冒烟脚本调用 `python -m omicslab` | LEGACY-BRAND-COMPAT |")
brand.append("")
brand.append("> 桌面产品面（`productName: SuWen`、`appId org.suwen.desktop`、窗口标题 `素问 · SuWen`、")
brand.append("> 安装包 `SuWen-Setup-*`、UI 文案）已全部使用新品牌；`desktop/ui` 内旧品牌命中 0。")
brand.append("")
brand.append("## 5. Top 命中文件（旧品牌出现最多，均为兼容/历史/审计）")
brand.append("")
brand.append("| 文件 | 命中 | 分类 |")
brand.append("|---|---|---|")
for rel, n in top:
    brand.append("| `{}` | {} | {} |".format(rel.replace(os.sep, "/"), n, classify(rel)))
brand.append("")
brand.append("## 6. 保留原因（为什么不能简单全局替换）")
brand.append("")
brand.append("1. **Python 分发名**：`pyproject.toml` name=`omicslab`，控制台脚本 `suwen`/`omicslab`，发布/校验脚本与 egg-info 依赖；改名会破坏升级路径与 R012 迁移。")
brand.append("2. **用户数据目录**：`~/.omicslab`、`%LOCALAPPDATA%/OmicsLab`、`OMICSLAB_*` 环境变量是旧用户的真实数据位置；R090/R102 要求非破坏兼容读取。")
brand.append("3. **API/内核标识**：`kernel_name=\"omicslab\"`、路由/字段名是旧前端与内核 spec 的契约。")
brand.append("4. **历史文档/归档**：旧版本说明、归档契约是审计证据，不应改写。")
brand.append("5. **许可证归属**：CITATION.cff 作者名/历史贡献者是事实归属，改名需权利人或 Lead 决策。")
brand.append("")
brand.append("## 7. 待 Lead 决策 / 修复项")
brand.append("")
brand.append("1. `CITATION.cff` 历史贡献者名与 NOTICE 署名保留与否（法律归属，非产品品牌）。")
brand.append("2. `desktop/src/rpc/core.ts` 中文字符串乱码修复（`FIX_REQUIRED`，编码问题，见 conflicts.md C-02）。")
brand.append("3. 现行文档（`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/EXTENDING.md` 等）中的旧名是否加“兼容说明”段落；建议保留并统一标注。")
brand.append("4. `docs/progress.md` 中“品牌清理”的表述应引用本文件与扫描 JSON，避免“零旧品牌”误述。")
brand.append("")
brand.append("## 8. 历史版本（本文件旧版结论，保留参考）")
brand.append("")
brand.append("旧版（2026-10-24 之前）记录：22 个受跟踪文件、78 行 diff 完成 OmicsLab→SuWen 改名；当时扫描无法做到零命中，")
brand.append("原因同上（命名空间/环境变量/存储/路径/归档）。该结论与本次更新一致。")
brand.append("")
text_brand = "\n".join(brand).format(
    tot=sum(hits.values()), files=len(hits), nh=sum(new_hits.values()), nf=len(new_hits),
    oh=sum(old_hits.values()), of=len(old_hits))
write(os.path.join("docs", "research", "branding-exceptions.md"), text_brand + "\n")

# update branding scan summary json
json.dump({
    "generatedAt": "2026-10-25",
    "pattern": "omicslab|omiclab (case-insensitive)",
    "scope": "text files under TARGET, exclusions: .git node_modules release dist dist-lead __pycache__ .pytest_cache build .omicslab and binary/font/image assets",
    "total": {"hits": sum(hits.values()), "files": len(hits)},
    "newAuditDocs": {"hits": sum(new_hits.values()), "files": len(new_hits)},
    "excludingNewAuditDocs": {"hits": sum(old_hits.values()), "files": len(old_hits)},
    "byClass": {c: {"hits": n, "files": len(files_by_class[c])} for c, n in classes.items()},
    "topFiles": [[rel.replace(os.sep, "/"), n, classify(rel)] for rel, n in top],
    "fixRequiredBrandText": [],
    "fixRequiredNonBrand": ["desktop/src/rpc/core.ts Chinese literals mojibake (encoding, not brand)"],
}, open(os.path.join(D, "docs", "research", "branding-scan-summary.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)

# ---------------------------------------------------------------- parity md update
pp = os.path.join("docs", "migration", "feature-parity-matrix.md")
pm = open(pp, encoding="utf-8").read()
pm = pm.replace("(64 rows)", "(67 rows)")
if "## 8. 最终统计" not in pm:
    pm = pm.rstrip() + """

## 8. 最终统计（2026-10-25 终稿）

全部 67 行：`IMPLEMENTED_PASS` 14 / `UNVERIFIED` 42 / `NOT_STARTED` 9 / `N/A_PORT` 1 / `REPLACED` 1。
判定口径：仅 `IMPLEMENTED_PASS` 视为完成；原型树日志不自动升级为 TARGET 证据（见 `../verification/integration-and-e2e.md`）。
行级代码路径、Python 证据、迁移方式与缺口见同名 CSV。
"""
    write(pp, pm)
print("parity rows:", len(rows) if False else "67")

# ---------------------------------------------------------------- verify
write(os.path.join("docs", "verification", "integration-and-e2e.md"), integration)
write(os.path.join("docs", "verification", "durability-chaos-tests.md"), durability)
write(os.path.join("docs", "release", "windows-installer-verification.md"), installer)

print("\n=== deliverables ===")
for rel in [
    "docs/migration/source-inventory.md", "docs/migration/copy-verification.md",
    "docs/migration/python-feature-inventory.md", "docs/migration/feature-parity-matrix.md",
    "docs/migration/feature-parity-matrix.csv",
    "docs/requirements/master-requirements.csv", "docs/requirements/traceability.md",
    "docs/requirements/conflicts.md",
    "docs/verification/third-party-dependencies.md", "docs/verification/ui-action-coverage.csv",
    "docs/verification/integration-and-e2e.md", "docs/verification/durability-chaos-tests.md",
    "docs/release/windows-installer-verification.md",
    "docs/research/branding-exceptions.md", "docs/research/branding-scan-summary.json",
    "docs/research/repro/copy-verify.ps1", "docs/research/repro/audit-updates.py",
    "docs/research/repro/finalize-docs.py",
    ".github/workflows/suwen-windows.yml", ".github/workflows/ci.yml",
]:
    p = os.path.join(D, rel)
    print(("{:70s} {:>9s} {}").format(rel, str(os.path.getsize(p)) if os.path.exists(p) else "MISSING",
                                      sha256(rel)[:16] if os.path.exists(p) else ""))
print("\n--- parity csv status counts ---")
pc = list(csv.DictReader(open(os.path.join(D, "docs", "migration", "feature-parity-matrix.csv"), encoding="utf-8")))
from collections import Counter
print("parity", len(pc), Counter(x.get("vnext_status", x.get("status", "")) for x in pc))
print("master", len(rows), Counter(x.get(k_status, "") for x in rows))
print("progress.md hash:", sha256("docs/progress.md"))
print("ui rows:", len(list(csv.DictReader(open(os.path.join(D, "docs", "verification", "ui-action-coverage.csv"), encoding="utf-8")))))
