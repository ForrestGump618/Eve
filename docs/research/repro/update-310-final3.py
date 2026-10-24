# -*- coding: utf-8 -*-
"""Final task-6 pass: CSVs + conflicts C-14 + regenerated traceability with final artifacts."""
import csv
import hashlib
import os
from collections import Counter

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def p(rel):
    return os.path.join(D, rel.replace("/", os.sep))


# ------------------------------------------------------------ parity csv
pp = p("docs/migration/feature-parity-matrix.csv")
rows = list(csv.DictReader(open(pp, encoding="utf-8-sig", newline="")))
fields = list(rows[0].keys())
for r in rows:
    cap = r["capability"]
    if cap.startswith("Windows NSIS installer"):
        r["gaps"] = (
            "SHA256SUMS not generated; clean-VM lifecycle and code signing pending; final-artifact host "
            "lifecycle 14/14 and upgrade 8/8 passed (host probes, not clean machine)"
        )
    elif cap == "Clean-VM install/upgrade/uninstall":
        r["gaps"] = (
            "clean-VM install/start/upgrade/uninstall not executed; host lifecycle 14/14 + cross-version "
            "upgrade 8/8 passed on the final artifact; SHA256SUMS pending (PENDING_LEAD)"
        )
    elif cap == "Windows app packaging metadata":
        r["gaps"] = "installer host lifecycle 14/14 + upgrade 8/8 passed; clean-VM, SHA256SUMS and code signing pending"
w = csv.DictWriter(open(pp, "w", encoding="utf-8-sig", newline=""), fieldnames=fields, lineterminator="\n")
w.writeheader()
for r in rows:
    w.writerow({k: r.get(k, "") for k in fields})
print("parity rows", len(rows), dict(Counter(r["vnext_status"] for r in rows)))

# ------------------------------------------------------------ master csv
mp = p("docs/requirements/master-requirements.csv")
mrows = list(csv.DictReader(open(mp, encoding="utf-8-sig", newline="")))
mfields = list(mrows[0].keys())
LIFE = (
    "final-artifact host lifecycle 14/14 passed (docs/verification/artifacts/installer-lifecycle.json, "
    "2026-10-24T17:45:22Z: install 18s, exe 249,801,728 B, HKCU SuWen 3.1.0, FileVersion 3.1.0, "
    "running app, authenticated daemon health 3.1.0 mode user-background, daemon survives UI close, "
    "reinstall 24s, uninstall 11s, data preserved)"
)
UPG = (
    "cross-version upgrade 3.0.0-preview.1 -> 3.1.0 8/8 passed (docs/verification/artifacts/"
    "upgrade-path.json: old install, upgrade, registry/FileVersion 3.1.0, upgraded app+daemon health, "
    "uninstall, dir removed)"
)
UPD = {
    "R100": dict(
        test_or_log=LIFE + "; " + UPG + "; packaged smoke 8/8 on final build; SHA256SUMS absent",
        remaining_gap="SHA256SUMS artefact, clean-VM lifecycle and code signing PENDING_LEAD; host probes are not a clean machine",
    ),
    "R102": dict(
        vnext_evidence=(
            "harness/store.ts VACUUM INTO pre-v3 backup; nsis deleteAppDataOnUninstall false; "
            "installer uninstall keeps user data; upgrade path 3.0.0-preview.1 -> 3.1.0 tested at "
            "installer level (upgrade-path.json); harness DB migration-under-upgrade not separately "
            "measured"
        ),
        test_or_log="installer lifecycle: uninstall preserves user data; upgrade-path.json 8/8 (host); no DB schema-migration evidence under upgrade",
        remaining_gap="Clean-VM upgrade/uninstall retention and harness DB migration-with-backup under upgrade not executed",
    ),
    "R119": dict(
        test_or_log=LIFE + "; " + UPG + "; both are HOST probes; no clean-VM run, no SHA256SUMS",
        evidence_scope="PENDING_LEAD",
        remaining_gap="clean Windows VM install/start/upgrade/uninstall NOT RUN; SHA256SUMS and code signing pending; host probe is not a clean machine",
    ),
    "R120": dict(
        test_or_log="all eight reports present and current to 3.1.0 final artifact (master CSV 71 rows/59 PASS, parity 70 rows/56 PASS, UI coverage 142 actions, integration/durability/installer/third-party/traceability + lifecycle/upgrade artifacts), CI workflow authored never run",
        remaining_gap="clean-VM/upgrade sections still host-only; CI not executed; durability section short-window only",
    ),
    "R121": dict(
        test_or_log="final installer sha256 e1a1062c...; host lifecycle 14/14 + upgrade 8/8; docs/progress.md, feature-parity-matrix.md, windows-installer-verification.md current",
        evidence_scope="PENDING_LEAD",
        remaining_gap="clean-VM lifecycle, SHA256SUMS, code signing and real external-account rows NOT complete (PENDING_LEAD)",
    ),
}
for r in mrows:
    if r["id"] in UPD:
        r.update(UPD[r["id"]])
w = csv.DictWriter(open(mp, "w", encoding="utf-8-sig", newline=""), fieldnames=mfields, lineterminator="\n")
w.writeheader()
for r in mrows:
    w.writerow({k: r.get(k, "") for k in mfields})
print("master rows", len(mrows), dict(Counter(r["status"] for r in mrows)))

# ------------------------------------------------------------ conflicts C-14
cp = p("docs/requirements/conflicts.md")
t = open(cp, encoding="utf-8").read()
start = t.find("## C-14")
end = t.find("\n## ", start + 3)
if end < 0:
    end = t.find("\n\n## 2026-10-25", start + 3)
new_c14 = """## C-14 Installer lifecycle: final artifact passed on host; clean VM still absent

- Where: `docs/verification/artifacts/installer-lifecycle.json` (`2026-10-24T17:45:22Z`,
  `installerSha256` = E1A1062C...) records **14/14 steps passed on the delivered final installer**:
  install 18 s, exe 249,801,728 B, uninstaller, HKCU `SuWen 3.1.0`, FileVersion 3.1.0, installed app
  running, authenticated named-pipe daemon health version 3.1.0 mode `user-background`, daemon survives
  UI close (uptime 13.6 s), reinstall 24 s, uninstall 11 s, install dir removed, user data preserved,
  registry removed. `upgrade-path.json` (`2026-10-24T17:46:42Z`) records **8/8 steps passed** for
  `3.0.0-preview.1 -> 3.1.0`.
- Environment caveat: the developer shell inherits `ELECTRON_RUN_AS_NODE=1`; probes removed it from
  the launching shell only — a test-environment caveat, not a product defect; the shipped app is not
  modified.
- Conflict: R119 asks for a **clean Windows** lifecycle pass; both artifacts are host probes on a
  machine with Node/Python/prior SuWen data.
- Resolution: R100 = PASS (artifact + hashes + host lifecycle/upgrade measured, limits declared);
  R119/R121 stay NOT_STARTED/PENDING_LEAD for the clean-VM run, `SHA256SUMS` and code signing.
  Host probes are not presented as clean-machine results."""
t = t[:start] + new_c14 + "\n" + t[end:]
open(cp, "w", encoding="utf-8", newline="").write(t)
print("conflicts updated", len(t))

# ------------------------------------------------------------ traceability.md
def sha(rel):
    data = open(p(rel), "rb").read()
    return hashlib.sha256(data).hexdigest(), len(data)


def cell(text, limit):
    text = (text or "").replace("|", "\\|").replace("\n", " ").strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


mrows2 = list(csv.DictReader(open(mp, encoding="utf-8-sig", newline="")))
ui_rows = list(csv.DictReader(open(p("docs/verification/ui-action-coverage.csv"), encoding="utf-8-sig", newline="")))
par = list(csv.DictReader(open(pp, encoding="utf-8-sig", newline="")))
pm = Counter(r["status"] for r in mrows2)
actual_docs = [
    ("docs/requirements/master-requirements-source.md", "71 条 R 需求原文与允许状态（Lead 唯一需求源）"),
    ("docs/requirements/master-requirements.csv", "机器可读需求表：代码路径/证据/状态/缺口"),
    ("docs/requirements/conflicts.md", "证据冲突与 Lead 决策项 C-01…C-16"),
    ("docs/migration/python-feature-inventory.md", "Python 基线审计（R010）"),
    ("docs/migration/feature-parity-matrix.csv", "能力对照矩阵（R011，70 行）"),
    ("docs/migration/source-inventory.md", "复制来源清单（R001-R003）"),
    ("docs/migration/copy-verification.md", "复制哈希与 git 一致性验证（R001-R003）"),
    ("docs/verification/third-party-dependencies.md", "依赖/许可证/SBOM/上游审计（R092/R094/R120）"),
    ("docs/verification/integration-and-e2e.md", "TARGET 集成/E2E/安装/混沌证据（R110-R120）"),
    ("docs/verification/durability-chaos-tests.md", "短时故障注入与未执行长跑清单（R050/R116）"),
    ("docs/verification/ui-action-coverage.csv", "142 个 UI 动作绑定与 RPC 桥接（R024/R120）"),
    ("docs/verification/artifacts/installer-lifecycle.json", "最终交付安装包主机生命周期 14/14（R100/R102/R119）"),
    ("docs/verification/artifacts/upgrade-path.json", "跨版本升级 3.0.0-preview.1→3.1.0 8/8（R102/R119）"),
    ("docs/verification/chaos-results.json", "短窗混沌 12/12，52.2 s（R050/R116）"),
    ("docs/release/windows-installer-verification.md", "安装包/哈希/生命周期/未验证项（R100-R103/R119/R120）"),
    ("docs/research/branding-exceptions.md", "品牌残留分类与 LEGACY-BRAND-COMPAT（R090/R091）"),
    ("docs/research/branding-scan.csv", "品牌扫描机器记录（R091）"),
    ("desktop/acceptance-matrix.md", "验收矩阵原型状态（历史）"),
    ("docs/progress.md", "Lead 维护的总进度（Lead-owned）"),
]
hdr = "| 文档 | 字节 | SHA-256 | 用途 |\n|---|---:|---|---|\n"
doc_rows = "".join(
    "| `%s` | %d | `%s` | %s |\n" % (rel, sha(rel)[1], sha(rel)[0], use) for rel, use in actual_docs
)

trace_rows = []
for r in mrows2:
    trace_rows.append(
        "| %s | %s | %s | %s | **%s** | %s |"
        % (
            r["id"],
            cell(r["requirement_summary"], 120),
            cell(r["code_paths"], 150),
            cell(r["test_or_log"], 190),
            r["status"],
            cell(r["remaining_gap"], 150),
        )
    )

trace = f"""# 需求—代码—验证追溯矩阵（Traceability）

日期：2026-10-25（3.1.0 最终证据修订） · 负责人：docs-audit（D）

## 1. 追溯来源

| 来源 | 路径 | 用途 |
|---|---|---|
| 需求登记册（Lead 唯一需求源） | `docs/requirements/master-requirements-source.md` | 71 条 R 需求原文与允许状态 |
| 机器可读需求表 | `docs/requirements/master-requirements.csv` | 每条需求：代码路径/证据/证据范围/状态/缺口（{pm.get('IMPLEMENTED_PASS',0)} PASS / {pm.get('UNVERIFIED',0)} UNVERIFIED / {pm.get('NOT_STARTED',0)} NOT_STARTED） |
| Python 基线审计 | `docs/migration/python-feature-inventory.md` | 基线入口、路由、模块、技能、测试（R010） |
| 功能对照矩阵 | `docs/migration/feature-parity-matrix.csv/.md` | {len(par)} 条能力：Python 基线/桌面 3.1.0/迁移方式（R011） |
| 复制与来源验证 | `docs/migration/source-inventory.md`、`copy-verification.md` | R001-R003 |
| UI 动作覆盖 | `docs/verification/ui-action-coverage.csv` | {len(ui_rows)} 个 UI 动作绑定状态（R024/R026/R120） |
| 架构契约 | `docs/architecture/vnext-contract.md`、`current.md` | 所有权、RPC、Store v3、测试纪律 |
| TARGET 3.1.0 证据 | `docs/verification/*`、`docs/verification/artifacts/*`、`docs/release/*` | 真实测试/构建/安装/混沌/数据库调用（TARGET_RUN） |
| 冲突与非正式需求 | `docs/requirements/conflicts.md` | V2 文档与 R 登记册差异、最终构建取代关系 |

## 2. 状态规则

- 仅 `IMPLEMENTED_PASS` 视为完成；`UNVERIFIED` = 代码/证据存在但未达到需求级验证；
  `NOT_STARTED` = 未实现或未执行；`BLOCKED_EXTERNAL` 仅在明确外部阻塞时使用。
- 证据范围（CSV `evidence_scope`）：`TARGET_RUN` 本次真实执行；`PROTOTYPE_LOG` 原型树日志（仅在代码哈希一致时引用）；
  `CODE_ONLY`/`DOC` 静态审查；`PENDING_LEAD` 等待 Lead 执行/补证；`NONE` 无证据。
- 任何“已签名/8·24·72h/干净机安装/真实付费账号”结论必须指向 TARGET 运行日志或 artifact，
  否则保持未通过并写明缺口。已明确未验证：8/24/72h、干净 VM、代码签名、真实外部模型账号、本机 legacy Python workbench。

## 3. 全量追溯表（{len(mrows2)} 条）

| ID | 需求（摘要） | TARGET 代码/文档路径 | 验证方式与证据 | 状态 | 剩余缺口 |
|---|---|---|---|---|---|
{chr(10).join(trace_rows)}

## 4. 关键映射（抽查路径）

| 需求 | 关键代码 | 关键证据 |
|---|---|---|
| R001-R003 复制验证 | `docs/research/repro/copy-verify.ps1` | 326/327 文件哈希一致、`.git` 654 文件全一致（`copy-verification.md`） |
| R010-R011 | `omicslab/**`、`tests/**`、`docs/migration/*` | Python 基线 482 tests（PROTOTYPE 日志）+ 70 行能力矩阵 |
| R012 导入/回滚 | `desktop/src/import-service.ts`、`rpc/core.ts` | 5/5 rollback 测试；真实 legacy home 只读扫描 9 组 |
| R030-R039 持久化/安全 | `main.ts`、`security.ts`、`daemon.ts`、`harness/store.ts`、`engine.ts` | npm test 150/148（2 skip）；e2e-rpc 42/0；无 Endurance 声明 |
| R040-R047 上下文 | `context.ts`、`context-async.ts`、`daemon.ts` | 10 轮压缩 201,356..201,509 → 2,040..2,834 tokens，显式事实 100% 保留 |
| R050/R116 长跑 | `docs/verification/durability-chaos-tests.md` | 混沌 12/12（52.2 s，短窗）；8/24/72h 未执行 |
| R100-R103/R119 发布 | `desktop/package.json`、`docs/release/windows-installer-verification.md` | 最终安装包 129,425,145 B / SHA256 E1A1062C…；主机生命周期 14/14；升级 8/8；干净 VM 未跑 |
| R110-R121 验收报告 | 本文件 + 8 份机器可读报告 | TARGET 测试/E2E/DB 调用/混沌/安装均指向具体 artifact |

## 5. 追溯性缺口（必须由 Lead 补齐/决策）

1. **干净 Windows VM** install → start → upgrade → uninstall（R119/R121）。主机生命周期 14/14 与升级 8/8 已过，但不是干净机。
2. `SHA256SUMS` 文件生成/发布；Windows CI（`.github/workflows/suwen-windows.yml`）实际运行一次。
3. 代码签名证书（BLOCKED_EXTERNAL）；SmartScreen 风险已如实披露。
4. 8/24/72h、重启、睡眠/断电、磁盘满长跑（R050）——当前仅短窗混沌 12/12。
5. 真实外部模型账号调用证据（当前仅本地 HTTP fixture 协议测试）。
6. R090 活跃文档兼容性表述的 Lead 决策（品牌扫描 0 个 FIX_REQUIRED 文本，但 API/兼容文档仍保留旧标识符）。
7. `desktop/src/rpc/core.ts` 历史上存在的中文 mojibake 是否已修复需复验；`desktop/dist-lead/` 发布前清理。
8. 23 个 legacy 技能是否迁入新注册表的决策（当前仅 `resources/legacy`）。

## 6. 历史/当前文档哈希（可抽查追溯）

{hdr}{doc_rows}
## 7. 2026-10-25 TARGET 3.1.0 证据修订（替代原型证据）

Lead 在 TARGET 实测并记录（见 `docs/verification/integration-and-e2e.md`）：

1. `npx tsc --noEmit` exit 0；`npm run build` exit 0；`npm test` 150 tests / 148 pass / 0 fail / 2 skip / 28.3 s / exit 0。
2. `node scripts/e2e-rpc.mjs --dist dist --live` → 42/0，真实 detached daemon + named pipe；真实 PubMed/Europe PMC（PMID 42878939）与 UniProt（Q9Y2B4，release 2026_03）调用，响应存为 sha256 artifact。
3. 打包 smoke（final build）8/8、106 s；legacy Python workbench 本机不可用（缺 fastapi，不计通过）；liveMcp 由 RPC E2E 覆盖。
4. UI QA：`ui-dom-qa.mjs` 19/0/10 warnings；`node --check desktop/ui/app.js` exit 0；`ui/actions.json` 142 actions 全部绑定（94 daemon-RPC / 5 main-bridge / 43 UI-only）。
5. 最终安装包：`SuWen-Setup-3.1.0-win-x64.exe` 129,425,145 B SHA256 `E1A1062C…`（17:41:52Z，UNSIGNED）；blockmap 135,934 B SHA256 `72DD2D54…`；unpacked exe 249,801,728 B SHA256 `CFE87F2D…`。
6. 最终安装包主机生命周期 14/14（`installer-lifecycle.json`，17:45:22Z）与跨版本升级 8/8（`upgrade-path.json`，17:46:42Z，仅 3.0.0-preview.1→3.1.0）。
7. 短窗混沌 12/12、52.2 s（`chaos-results.json`，17:34:35Z）：worker/daemon SIGKILL 恢复、同 operationId、不重放已提交步骤、取消 0 artifacts、429→500→200 + 2 次人工审批；限制为单 Windows 会话、短时、fixture 注入。
8. `npm audit` 0 漏洞；runtime SBOM（CycloneDX 1.5）与许可证文本；MIT LICENSE/NOTICE；Python 保持 Apache-2.0。
9. 品牌扫描 983 hits / 143 files、0 FIX_REQUIRED 文本；旧标识符按 9 类 LEGACY-BRAND-COMPAT 记录。
10. 需求/对照/UI/追溯/缺失报告全部更新到 3.1.0：master 71 行（59/7/5）、parity 70 行（56/2/10/1/1）、UI 142 行、traceability 即本文件。

**替代关系**：此前的原型证据（48 tests、10 项 E2E、67 行 parity、137 controls、82779B90 预最终安装包）
仅作历史记录，不得再作为交付结论；最终构建为 `E1A1062C…`。
"""
open(p("docs/requirements/traceability.md"), "w", encoding="utf-8", newline="").write(trace)
print("traceability bytes", len(trace))
