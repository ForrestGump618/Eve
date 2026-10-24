# -*- coding: utf-8 -*-
"""Append historical/current document hashes + requirement mapping to traceability.md."""
import hashlib
import os

D = r"C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext"


def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1048576), b""):
            h.update(c)
    return h.hexdigest()


mapping = {
    "docs/API.md": "R024,R060,R090 (旧 API 标识保留以兼容)",
    "docs/ARCHITECTURE.md": "R010,R030,R031,R080 (基线架构审计)",
    "docs/COMPARISON.md": "R011,R080 (基线对照)",
    "docs/EXTENDING.md": "R053,R060,R061 (技能/MCP 扩展面)",
    "docs/INSTALL.md": "R100,R101,R103 (安装/运行时要求)",
    "docs/SKILLS.md": "R061 (技能生命周期文档)",
    "docs/SUWEN-V2-REQUIREMENTS.md": "CONFLICT-R020..R071 (非正式 V2 产品列表；见 conflicts.md)",
    "docs/SUWEN-V2-CHECKLIST.md": "CONFLICT-R020..R121 (保守 V2 状态清单)",
    "docs/TURN-GOVERNANCE.md": "R034,R035,R037 (基线轮次治理)",
    "docs/BIOMEDICAL-EVIDENCE.md": "R051,R063 (证据/引用规则)",
    "docs/CHANNELS.md": "R070,R071 (渠道)",
    "docs/FAQ.md": "R090,R102 (兼容/数据目录说明)",
    "docs/README.md": "R001,R002,R090 (docs 入口+兼容表述)",
    "docs/archive/ACCEPTANCE.md": "R110-R121 历史验收上下文",
    "docs/archive/CONTRACTS.md": "R010-R121 历史需求/契约来源",
    "docs/archive/CONTRACTS-2.md": "R010-R121 历史需求/契约来源",
    "docs/archive/CONTRACTS-3.md": "R010-R121 历史需求/契约来源",
    "docs/archive/LEGACY-README.md": "历史 README（旧品牌/来源）",
    "docs/architecture/vnext-contract.md": "R020-R039,R060-R064 (冻结 vNext 契约)",
    "docs/architecture/current.md": "R010,R011 (基线审计证据)",
    "docs/architecture/migration-plan.md": "R001-R003,R012,R050,R100-R103 (阶段/回滚)",
    "docs/architecture/reuse-decision.md": "R080,R081 (复用决策)",
    "docs/architecture/feature-provenance-matrix.md": "R011,R080,R081 (来源矩阵)",
    "docs/progress.md": "R110-R121 交付状态（Lead 所有；哈希已记录）",
    "docs/release-notes-vnext.md": "R100-R103,R119 (原型发布说明)",
}
rows = []
for rel, m in mapping.items():
    p = os.path.join(D, *rel.split("/"))
    if os.path.exists(p):
        rows.append((rel, os.path.getsize(p), sha(p), m))

extra = []
for dp, dn, fn in os.walk(os.path.join(D, "docs")):
    dn[:] = [x for x in dn if x not in ("research", "migration", "requirements", "verification", "release",
                                        "assets", "screenshots", "__pycache__")]
    for f in fn:
        if f.lower().endswith(".md"):
            rel = os.path.relpath(os.path.join(dp, f), D).replace(os.sep, "/")
            if rel not in mapping:
                extra.append(rel)

tr = open(os.path.join(D, "docs/requirements/traceability.md"), encoding="utf-8").read()
if "## 6. 历史/现行文档哈希与需求映射" not in tr:
    sec = ["", "## 6. 历史/现行文档哈希与需求映射（抽查用）", "",
           "对 `docs/`（除证据/审计新目录）与归档 MD 逐一计算 SHA-256 并标注其承载的需求组；"
           "用于证明需求来源可追溯、旧文档未被篡改。", "",
           "| 文档 | 大小(B) | SHA-256 | 需求映射 |", "|---|---|---|---|"]
    for rel, size, h, m in rows:
        sec.append("| `{}` | {} | `{}` | {} |".format(rel, size, h, m))
    if extra:
        sec += ["", "未列入上表但存在于 docs/ 的其他 MD（仅登记哈希，必要时再映射）：", "",
                "| 文档 | 大小(B) | SHA-256 |", "|---|---|---|"]
        for rel in sorted(extra):
            p = os.path.join(D, *rel.split("/"))
            sec.append("| `{}` | {} | `{}` |".format(rel, os.path.getsize(p), sha(p)))
    tr = tr.rstrip() + "\n" + "\n".join(sec) + "\n"
    with open(os.path.join(D, "docs/requirements/traceability.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(tr)
    print("appended history section; mapped docs:", len(rows), "extra md:", len(extra))
else:
    print("section already exists; mapped rows:", len(rows))

tp = open(os.path.join(D, "docs/verification/third-party-dependencies.md"), encoding="utf-8").read()
for name in ["deepseek-harness", "DSH", "Kimi", "Biomni", "Paper2Agent", "ERA", "Robin", "Co-Scientist",
             "Kosmos", "pubmed", "lifesciences"]:
    print("third-party doc mentions", name, ":", name.lower() in tp.lower())
print("third-party doc chars", len(tp))
