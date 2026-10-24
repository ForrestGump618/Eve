# 旧品牌标识审计与例外清单（Brand Exceptions）

日期：2026-10-25（更新） · 负责人：docs-audit（D） · 对应需求：R090/R091/R092/R024

## 1. 结论（诚实边界）

- UI/安装清单/桌面代码中**未发现应改而未改的品牌文案**（`desktop/ui` 内旧品牌 0 命中；桌面新代码仅兼容读取路径命中，见下）。
- Python 包名/命名空间/环境变量/数据目录/API 标识属于**兼容契约**，按 R090 允许保留（历史数据字段、迁移标识），
  统一标注 `LEGACY-BRAND-COMPAT`，**不能宣称“全仓库零旧品牌”**。
- 全仓库最终扫描：**1017 处命中 / 146 个文本文件**；其中本轮新增审计/验证文档贡献 138 处、12 文件；
  排除本轮新增审计文档后为 **879 处 / 134 个文件**。
- `FIX_REQUIRED`（品牌文案层面）：**0**。此前提到的非品牌**编码缺陷**已于 2026-10-25 修复并复验：
  39 个 `desktop/src` + `desktop/ui` 文件中 **0 处乱码/U+FFFD**（含 `desktop/src/rpc/core.ts`），
  详见 `docs/requirements/conflicts.md` C-08；当前无遗留 `FIX_REQUIRED`。

## 2. 扫描方法（可复现）

```powershell
# 正则（大小写不敏感）
rg -n -i "omicslab|omiclab" .
# 排除：.git、node_modules、release、dist、dist-lead、__pycache__、.pytest_cache、build、.omicslab 与二进制/字体/图片
```

机器可读结果：`docs/research/branding-scan-summary.json`（按分类统计 + Top 文件）。

## 3. 分类统计

| 分类 | 命中 | 文件 | 处理结论 |
|---|---|---|---|
| `COMPAT-DOCS-ACTIVE` | 207 | 14 | 现行文档：明确说明包名/数据目录兼容策略，属有意保留 |
| `LEGACY-PACKAGE-NAMESPACE` | 201 | 58 | 兼容：Python 包名/命名空间/环境变量/数据目录/内核名，保留并加注释 |
| `LEGACY-DOC-HISTORY` | 189 | 8 | 历史文档：归档/升级/验证记录，保持原文 |
| `AUDIT-DOCS` | 160 | 16 | 审计/验证文档：描述基线时引用旧名，属证据而非产品文案 |
| `LEGACY-TESTS` | 156 | 17 | 兼容：测试导入与 fixture 必须使用真实包名 |
| `LEGACY-SCRIPTS` | 44 | 10 | 兼容：发布/校验/冒烟脚本依赖真实分发名 `omicslab` |
| `LEGACY-DESKTOP-BRIDGE` | 34 | 14 | 兼容：旧数据导入/兼容工作台读取路径 `~/.omicslab`、`OMICSLAB_HOME`，已注释 LEGACY-BRAND-COMPAT |
| `OTHER` | 25 | 8 | 其他：pyproject 等构建元数据中的分发名兼容 |
| `ATTRIBUTION-LEGAL` | 1 | 1 | 许可证/引用归属（CITATION.cff `OmicsLab contributors`），不可单方面改名 → PENDING_LEAD 决策 |

## 4. 桌面侧命中明细（仅兼容读取，已注释）

| 文件 | 用途 | 结论 |
|---|---|---|
| `desktop/src/import-service.ts` | 旧 home 默认 `~/.omicslab`、`SUWEN_LEGACY_HOME`、只读导入 | LEGACY-BRAND-COMPAT |
| `desktop/src/legacy-worker.ts` | 探测旧 Python 源码 `omicslab/config.py` | LEGACY-BRAND-COMPAT |
| `desktop/worker/legacy_server.py` | 兼容工作台启动（`OMICSLAB_HOME/DATA_DIR`、`from omicslab...`） | LEGACY-BRAND-COMPAT |
| `desktop/package.json` | `extraResources` 过滤 `omicslab/**` 旧源码 | LEGACY-BRAND-COMPAT |
| `desktop/scripts/*`（如存在） | 验收/冒烟脚本调用 `python -m omicslab` | LEGACY-BRAND-COMPAT |

> 桌面产品面（`productName: SuWen`、`appId org.suwen.desktop`、窗口标题 `素问 · SuWen`、
> 安装包 `SuWen-Setup-*`、UI 文案）已全部使用新品牌；`desktop/ui` 内旧品牌命中 0。

## 5. Top 命中文件（旧品牌出现最多，均为兼容/历史/审计）

| 文件 | 命中 | 分类 |
|---|---|---|
| `docs/archive/LEGACY-README.md` | 66 | LEGACY-DOC-HISTORY |
| `docs/EXTENDING.md` | 44 | COMPAT-DOCS-ACTIVE |
| `docs/archive/CONTRACTS.md` | 43 | LEGACY-DOC-HISTORY |
| `docs/research/repro/finalize-docs.py` | 36 | AUDIT-DOCS |
| `docs/ARCHITECTURE.md` | 34 | COMPAT-DOCS-ACTIVE |
| `docs/migration/python-feature-inventory.md` | 34 | AUDIT-DOCS |
| `docs/archive/CONTRACTS-2.md` | 33 | LEGACY-DOC-HISTORY |
| `docs/API.md` | 31 | COMPAT-DOCS-ACTIVE |
| `omicslab/kernel/manager.py` | 31 | LEGACY-PACKAGE-NAMESPACE |
| `tests/test_suwen_platform.py` | 28 | LEGACY-TESTS |
| `docs/INSTALL.md` | 23 | COMPAT-DOCS-ACTIVE |
| `docs/research/branding-exceptions.md` | 23 | AUDIT-DOCS |
| `omicslab/config.py` | 21 | LEGACY-PACKAGE-NAMESPACE |
| `docs/archive/CONTRACTS-3.md` | 20 | LEGACY-DOC-HISTORY |
| `omicslab/agent/tools.py` | 19 | LEGACY-PACKAGE-NAMESPACE |
| `docs/architecture/current.md` | 18 | AUDIT-DOCS |
| `scripts/check_dist.py` | 18 | LEGACY-SCRIPTS |
| `CHANGELOG.md` | 16 | LEGACY-DOC-HISTORY |
| `tests/test_remote_workspace.py` | 16 | LEGACY-TESTS |
| `README.en.md` | 15 | COMPAT-DOCS-ACTIVE |

## 6. 保留原因（为什么不能简单全局替换）

1. **Python 分发名**：`pyproject.toml` name=`omicslab`，控制台脚本 `suwen`/`omicslab`，发布/校验脚本与 egg-info 依赖；改名会破坏升级路径与 R012 迁移。
2. **用户数据目录**：`~/.omicslab`、`%LOCALAPPDATA%/OmicsLab`、`OMICSLAB_*` 环境变量是旧用户的真实数据位置；R090/R102 要求非破坏兼容读取。
3. **API/内核标识**：`kernel_name="omicslab"`、路由/字段名是旧前端与内核 spec 的契约。
4. **历史文档/归档**：旧版本说明、归档契约是审计证据，不应改写。
5. **许可证归属**：CITATION.cff 作者名/历史贡献者是事实归属，改名需权利人或 Lead 决策。

## 7. 待 Lead 决策 / 修复项

1. `CITATION.cff` 历史贡献者名与 NOTICE 署名保留与否（法律归属，非产品品牌）。
2. ~~`desktop/src/rpc/core.ts` 中文字符串乱码~~ 已于 2026-10-25 修复并复验（编码问题，见 conflicts.md C-08；0 乱码/U+FFFD）。
3. 现行文档（`docs/API.md`、`docs/ARCHITECTURE.md`、`docs/EXTENDING.md` 等）中的旧名是否加“兼容说明”段落；建议保留并统一标注。
4. `docs/progress.md` 中“品牌清理”的表述应引用本文件与扫描 JSON，避免“零旧品牌”误述。

## 8. 历史版本（本文件旧版结论，保留参考）

旧版（2026-10-24 之前）记录：22 个受跟踪文件、78 行 diff 完成 OmicsLab→SuWen 改名；当时扫描无法做到零命中，
原因同上（命名空间/环境变量/存储/路径/归档）。该结论与本次更新一致。

