# -*- coding: utf-8 -*-
"""Final consistency pass for task-6: lifecycle/upgrade into progress/README/matrix, chaos doc final numbers."""
import os
import re

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def p(rel):
    return os.path.join(D, rel.replace("/", os.sep))


def rw(rel, fn):
    path = p(rel)
    t = open(path, encoding="utf-8").read()
    t2 = fn(t)
    if t2 == t:
        print("UNCHANGED", rel)
    else:
        open(path, "w", encoding="utf-8", newline="").write(t2)
        print("UPDATED", rel, len(t), "->", len(t2))


# ---------------------------------------------------------------- progress.md
def progress(t):
    t = t.replace(
        """  Build needed `npmmirror` mirrors after a direct GitHub timeout. Layout inspected
  (`resources/app`, `resources/worker`, `resources/legacy`). **Final-artifact host lifecycle probe
  and cross-version upgrade (`3.0.0-preview.1 → 3.1.0`) are PENDING_LEAD** (being measured now;
  artifacts `docs/verification/artifacts/installer-lifecycle.json` and `upgrade-path.json`).
  A pre-final probe passed 14/14 (install, version metadata, installed app, authenticated daemon
  attach, daemon survives UI close, reinstall, uninstall, user-data preservation); it refers to a
  superseded build and is historical evidence only. Environment caveat: the developer shell inherits
  `ELECTRON_RUN_AS_NODE=1`, so probes remove it from the launching shell only; the shipped app is not
  modified (test-environment caveat, not a product defect). Clean-VM lifecycle remains unverified.""",
        """  Build needed `npmmirror` mirrors after a direct GitHub timeout. Layout inspected
  (`resources/app`, `resources/worker`, `resources/legacy`).
- **Final-artifact host lifecycle passed 14/14** (`docs/verification/artifacts/installer-lifecycle.json`,
  2026-10-24T17:45:22Z, `installerSha256` = E1A1062C…): silent install 18 s, exe 249,801,728 B,
  uninstaller present, HKCU `SuWen 3.1.0` / FileVersion 3.1.0 / ProductVersion 3.1.0.0 / ProductName
  SuWen, installed app running after 12 s, authenticated named-pipe daemon health version 3.1.0
  `mode=user-background`, daemon survives closing the installed UI (same pid, uptime 13.6 s),
  same-version reinstall 24 s, silent uninstall 11 s, install dir removed, user data preserved,
  registry entry removed.
- **Cross-version upgrade `3.0.0-preview.1 → 3.1.0` passed 8/8**
  (`docs/verification/artifacts/upgrade-path.json`, 2026-10-24T17:46:42Z): old install with registry +
  FileVersion 3.0.0-preview.1, upgrade install, registry/exe become 3.1.0, upgraded app starts with
  daemon health 3.1.0, uninstall, install dir removed. Only this upgrade path exists/was tested.
  Both are **host probes**, not clean-VM runs; environment caveat: the developer shell inherits
  `ELECTRON_RUN_AS_NODE=1`, so probes removed it from the launching shell only — the shipped app is
  not modified (test-environment caveat, not a product defect). **Clean-VM lifecycle remains unverified.**""",
    )
    t = t.replace(
        """2. Final-artifact host lifecycle probe and cross-version upgrade `3.0.0-preview.1 → 3.1.0`
   (PENDING_LEAD, being measured now); clean-Windows-VM install/upgrade/uninstall lifecycle still
   not run (pre-final host probe passed but is superseded).""",
        """2. Clean-Windows-VM install/start/upgrade/uninstall lifecycle: **not run**. The final-artifact
   host probe passed 14/14 and the cross-version upgrade 8/8 (see the verified section above), but a
   clean machine without Node/Python/prior SuWen data is still PENDING_LEAD.""",
    )
    return t


rw("docs/progress.md", progress)


# ---------------------------------------------------------------- README / acceptance / integration
def readme(t):
    t = t.replace(
        "| `npm test` | **150 tests / 148 pass / 0 fail / 2 skipped**, ~38 s, exit 0 |",
        "| `npm test` | **150 tests / 148 pass / 0 fail / 2 skipped**, 28.3 s, exit 0 |",
    )
    t = t.replace(
        "| packaged `electron-smoke.mjs` | **8/8 checks**, ~98 s (30 s durable timer completes after UI exit; reopen attaches same daemon) |",
        "| packaged `electron-smoke.mjs` (final build) | **8/8 checks**, 106 s (30 s durable timer completes after UI exit; reopen attaches same daemon) |",
    )
    t = t.replace(
        """- Clean-Windows-VM install/upgrade/uninstall lifecycle and installed-app attach path: **not verified**
  (host probe only); installer is **unsigned** (SmartScreen warning expected); `SHA256SUMS` not yet in
  `release/`; Windows CI workflow exists but was **not executed** here.""",
        """- Clean-Windows-VM install/upgrade/uninstall lifecycle: **not verified**. On this host the final
  artifact passed a 14/14 lifecycle probe (install, metadata, running app, authenticated daemon
  attach, daemon survives UI close, reinstall, uninstall, user data preserved) and the
  `3.0.0-preview.1 → 3.1.0` upgrade path passed 8/8 — but that is **not a clean machine**. Installer
  is **unsigned** (SmartScreen warning expected); `SHA256SUMS` not yet in `release/`; Windows CI
  workflow exists but was **not executed** here.""",
    )
    return t


rw("desktop/README.md", readme)


def acceptance(t):
    t = t.replace(
        "| Typecheck / build / unit+integration suite | **Pass** — `tsc --noEmit` exit 0; `npm test` 150 tests / 148 pass / 0 fail / 2 skipped (~38 s, exit 0) |",
        "| Typecheck / build / unit+integration suite | **Pass** — `tsc --noEmit` exit 0; `npm test` 150 tests / 148 pass / 0 fail / 2 skipped (28.3 s, exit 0) |",
    )
    t = t.replace(
        "| Packaged Electron E2E | **Pass** — 8/8 checks, ~98 s:",
        "| Packaged Electron E2E (final build) | **Pass** — 8/8 checks, 106 s:",
    )
    t = t.replace(
        """| Install/upgrade/uninstall lifecycle | **Host probe 14/14 PASS** — install, version metadata, running app, authenticated daemon attach, daemon survives UI close, reinstall, uninstall, user-data preservation; **clean-VM lifecycle NOT verified** |""",
        """| Install/upgrade/uninstall lifecycle | **Host probe PASS** — final-artifact lifecycle 14/14 (install, version metadata, running app, authenticated daemon attach, daemon survives UI close, reinstall, uninstall, user-data preservation) and cross-version upgrade `3.0.0-preview.1 → 3.1.0` 8/8; **clean-VM lifecycle NOT verified** |""",
    )
    return t


rw("desktop/acceptance-matrix.md", acceptance)


def integration(t):
    t = t.replace("| 3 | `npm test` (build + `node --test dist/test/*.test.js`) | **tests 150, pass 148, fail 0, skipped 2** | ~38 s | 0 |",
                  "| 3 | `npm test` (build + `node --test dist/test/*.test.js`) | **tests 150, pass 148, fail 0, skipped 2** | 28.3 s | 0 |")
    return t


rw("docs/verification/integration-and-e2e.md", integration)

# ---------------------------------------------------------------- chaos doc
CHAOS = """# 长时稳定性与混沌/故障注入验收（Durability & Chaos）

日期：2026-10-25 · 负责人：docs-audit（D） · 结论：**未完成 8h/24h/72h 长跑，不得宣称通过**
需求映射：R033-R039、R050、R116、R025、R038

## 1. 结论摘要

1. 代码层面已实现租约/围栏、心跳、过期回收、持久计时器、outbox 幂等、检查点、预算中止、审批持久等待、
   WAL/`synchronous=FULL`、单实例锁、detached daemon（见第 2 节代码证据）。
2. TARGET 已完成一轮**短窗真实故障注入**：`docs/verification/chaos-results.json`
   （2026-10-24T17:34:35.821Z，`result: passed`）记录 **12/12 场景通过、52.2 s**，包括 python worker
   与 daemon 的 SIGKILL 恢复、同一 operationId、已提交步骤不重放、取消后 0 artifact、以及
   provider 429→500→200 的 3 次请求 + 2 次人工审批后完成。另有打包 smoke 的 UI 退出后 30 s 计时器
   继续且 `start` 只执行一次、重开窗口附着同一 daemon（见第 3 节）。
3. **8h / 24h / 72h 续航、断电、重启、睡眠、磁盘满、真实网络中断均未执行；本文件第 4 节仍为未执行矩阵。**
   所有混沌均为单 Windows 会话、短时，provider 故障由本地 HTTP fixture 注入（非真实厂商账号）。
   R050 在 TARGET 侧为 `UNVERIFIED`/未达需求级验证。
4. 若需要对外声明长时稳定，必须按第 5 节方案真实执行并保留日志；在此之前只能写
   “已实现机制 + 短窗故障注入 12/12 通过”。

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
| 审批持久等待 | `store.ts` + `daemon.ts` | `waiting_approval` + outbox `unknown`，`approval` RPC 显式 resolve | 已实现（12/12 场景含 2 次审批） |
| daemon 生命周期 | `desktop/src/daemon.ts`、`main.ts` | `daemon.lock` 单实例；UI 关闭不退出；named pipe token 认证、newline JSON、2 MB 上限 | 已实现（打包 smoke 验证） |
| 崩溃对账 | `store.ts` | 启动 `quick_check`；`refresh/Task` 将悬挂 running 步骤按租约/outbox 处理，未知副作用要求人工核对 | 已实现（SIGKILL 场景 + 429 计费未知场景覆盖） |

## 3. 已执行的故障注入（TARGET，短窗；`docs/verification/chaos-results.json`）

| # | 场景 | 结果 | 证据细节 |
|---|---|---|---|
| 1 | daemon 从持久状态启动 | PASS | pid 42800 |
| 2 | python worker SIGKILL 后重试恢复 | PASS | attempts 2，15,173 ms |
| 3 | 恢复的 python 步骤只写 1 个 artifact | PASS | 1 artifacts |
| 4 | worker 重启后 daemon 仍可响应 | PASS | — |
| 5 | daemon 在步骤中途 SIGKILL 后按持久租约恢复 | PASS | attempts 2，重启后 26,508 ms 完成 |
| 6 | 恢复保持同一 operationId 且仅 1 个 artifact | PASS | 1 artifacts |
| 7 | 已提交步骤在 daemon SIGKILL 后不重放 | PASS | before attempts 1，timer attempts 1 |
| 8 | cancel 传播到沙箱 worker 步骤 | PASS | cancelled |
| 9 | 已取消步骤不提交 artifact | PASS | 0 artifacts |
| 10 | 取消后 daemon 保持响应 | PASS | — |
| 11 | provider 429/500 故障重试后完成 | PASS | 3 requests、2 human approvals、completed |
| 12 | 计费未知的 429/500 需显式审批并进入持久事件日志 | PASS | `step.reconciliation_required,approval.resolved,step.claimed,step.reconciliation_required,approval.resolved,step.claimed,step.completed,task.completed` |

汇总产物：`result: passed`，`durationMs: 52206`，`finishedAt: 2026-10-24T17:34:35.821Z`；
`limits` 明确记录：单 Windows 会话、无 8/24/72h soak、无睡眠/断电/重启/磁盘满、provider 故障为
本地 HTTP fixture 注入。

历史原型证据（PROTOTYPE 树，已被上述 TARGET 短窗场景取代，仅作来源记录）：短时 daemon SIGKILL
重启恢复（注入窗口约 7,873 ms）、UI 关闭后 30 s 计时器继续、重开窗口附着同一 daemon、未授权
named pipe 写操作被拒绝、10 轮压缩后重启上下文显式事实 100% 保留。

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
| 网络中断/真实 429/5xx | R050/R037 | NOT_PERFORMED | 真实网络故障或代理注入（当前仅为本地 fixture） |
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
#    每 30 分钟：通过 pipe 调 health/doctor.run/snapshot，写日志
#    记录：Get-Process -Id <daemonPid> 的 CPU/WorkingSet、Get-PSDrive C、日志末尾 100 行

# 3) 故障注入
Stop-Process -Id <daemonPid> -Force      # SIGKILL 等价
# 重新启动 daemon，调用 snapshot/doctor.run，核对 outbox=confirmed、无重复副作用
# 4) 重启/断电：VM 快照前保存 home 目录；恢复后对比 sqlite 完整性（PRAGMA quick_check）
# 现有短窗混沌脚本：desktop/scripts/chaos-smoke.mjs
```

判定标准（执行时写入证据文件，勿提前宣称）：
- 计时器 `start` 副作用在所有场景下只出现一次（outbox `confirmed`、事件唯一）；
- 租约过期被回收，任务从检查点继续，不重复执行已完成步骤；
- 进程重启后 `snapshot` 可恢复任务状态与上下文引用；
- 不出现 SQLite 损坏（`quick_check=ok`）、不出现明文凭据；
- 记录内存/句柄/磁盘增长曲线，72h 不超预算。

## 6. 状态汇总

- 已实现并可审查的可靠性机制：12 项（第 2 节）。
- 已执行的真实故障注入（TARGET 短窗）：**12/12 场景、52.2 s 通过**（第 3 节，单会话；含 2 次人工审批）。
- 未执行：8h/24h/72h、重启、睡眠、断电、磁盘满、真实网络故障、并发压力（第 4 节）→ R050 未达
  需求级验证（master CSV 中 R050=`UNVERIFIED`）。
- 公开表述建议：只能写“已实现租约/围栏/outbox/检查点机制；短窗故障注入 12/12 与 30 s 后台计时器
  通过；长时稳定未验证”。
"""

open(p("docs/verification/durability-chaos-tests.md"), "w", encoding="utf-8", newline="").write(CHAOS)
print("UPDATED chaos doc", len(CHAOS))
