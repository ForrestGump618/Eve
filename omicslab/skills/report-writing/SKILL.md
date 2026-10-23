---
name: report-writing
description: "结构化实验报告写作：摘要/数据概览/方法/结果/图表/局限/结论，数字一致性校验、可复现性声明、引用规范与审稿自查。"
when_to_use: "需要把分析结果整理成报告或论文 Results 章节、撰写方法学描述、检查正文数字与表格是否一致、补可复现性声明时使用。"
version: "1.0"
---

# 实验报告写作（report-writing）

## 适用场景
- 分析完成后输出结构化报告（Markdown/HTML/DOCX）。
- 把多步分析写成论文 Methods/Results。
- 交付前校验正文、表格、图注中的数字是否一致。
- 需要声明环境、参数、随机种子与数据版本。

## 前置检查
1. 所有分析产物已落盘（`results/` 表、`figures/` 图、`params.json`），报告只引用产物，不凭记忆写数字。
2. 明确读者与体裁：内部报告、论文正文、基金申请——详略与语气不同。
3. 明确结论强度：描述性 vs 推断性；没有统计检验就不写「显著」。
4. 数据与隐私边界：能否写出样本来源、批次、临床信息；受控数据只给汇总。
5. 引用来源：方法出处（原文/工具论文）与数据 accession 必须可查。

## 依赖与环境
核心流程只需 Markdown + `pandas`（`pip install pandas`）做数字核对；导出 DOCX/PDF 用 `pip install python-docx` 或调用 `pandoc`。不依赖任何在线服务，所有数字必须来自本地 `results/` 产物。

## 步骤
1. **写摘要（150–250 字）**：问题 → 数据与方法（一句话）→ 最关键的 2–3 个结果（带数字）→ 结论与局限。
2. **数据概览**：样本/细胞数、分组、批次、质控通过率、丢失了什么；给一张概览表。
3. **方法**：按可复现顺序写——数据获取（accession、版本、日期）→ 预处理（工具、版本、参数、阈值）→ 统计（检验、模型、多重比较校正、效应量）→ 软件环境。
4. **结果**：每段一个论点，段首给结论句，后接证据（数字、图号）；数字保留有效位数（百分比 1 位小数，p 值用 `p < 0.001` 或三位有效数字）。
5. **图表**：每个图有独立图注，包含 n、统计方法、误差类型（SD/SEM/CI）、显著性标记含义；正文按图号顺序引用。
6. **局限**：写具体（批次与分组共线、样本量、技术噪声、单细胞比例估计的组成偏差），不要写「本研究存在不足」这种空话。
7. **结论**：只回应摘要提出的问题；区分「观察到」与「推断」；给下一步建议。
8. **一致性校验**：写脚本从 `results/` 表里重算关键数字，扫描正文中的数字并比对，报告差异。
9. **可复现性声明**：软件版本、参数文件、随机种子、代码路径、数据 accession、运行日期。

## 关键代码片段
```python
import json
import re
from pathlib import Path

import pandas as pd

# 1) 从产物重算关键数字（不要在正文里手写）
de = pd.read_csv("results/de_results.csv")
n_sig = int(((de["padj"] < 0.05) & (de["log2FoldChange"].abs() > 1)).sum())
n_tested = len(de)
summary = {"n_genes_tested": n_tested, "n_sig": n_sig,
           "pct_sig": round(100 * n_sig / n_tested, 1)}

# 2) 扫描报告正文中的数字，与 summary 比对
text = Path("results/report_draft.md").read_text(encoding="utf-8")
claims = {"n_genes_tested": r"检测到\s*([\d,]+)\s*个基因",
          "n_sig": r"显著差异基因\s*([\d,]+)\s*个"}
problems = []
for key, pattern in claims.items():
    for m in re.finditer(pattern, text):
        found = int(m.group(1).replace(",", ""))
        if found != summary[key]:
            problems.append({"claim": key, "text_value": found, "computed": summary[key]})
print("不一致项:", json.dumps(problems, ensure_ascii=False, indent=2))

# 3) 生成可复现性声明
params = json.loads(Path("results/params.json").read_text(encoding="utf-8"))
statement = (
    f"分析于 {params['date']} 使用 素问 Suwen {params.get('omicslab_version', 'n/a')} 完成；"
    f"Python {params.get('python', 'n/a')}，scanpy {params.get('scanpy', 'n/a')}。"
    f"数据来自 {params.get('accession', 'n/a')}（下载日期 {params.get('download_date', 'n/a')}）。"
    f"随机种子 {params.get('seed', 'n/a')}，参数文件 results/params.json，代码见 analysis/。"
)
Path("results/reproducibility_statement.txt").write_text(statement, encoding="utf-8")

# 4) 报告骨架（只保留有内容的小节）
sections = ["摘要", "数据概览", "方法", "结果", "图表", "局限", "结论", "可复现性"]
report = ["# 分析报告", ""]
for sec in sections:
    report += [f"## {sec}", "", "（待填）", ""]
Path("results/report_draft.md").write_text("\n".join(report), encoding="utf-8")
```

## 参数建议
| 项目 | 建议 | 说明 |
|---|---|---|
| 摘要长度 | 150–250 字 | 超过 300 字读者抓不住重点 |
| 数字精度 | 百分比 1 位小数 | p 值 `< 0.001`；统计量 2–3 位 |
| 图注 | 每图 1 段，含 n 与统计方法 | 图应能脱离正文单独读懂 |
| 引用 | 工具原始论文 + 数据 accession | 不只写「使用 Seurat」 |
| 局限 | 3–5 条具体问题 | 避免模板化空话 |
| 一致性校验 | 交付前必跑 | 正文/表/图注三角比对 |

## 常见陷阱
1. **手写数字**：正文与最终表格不同步；所有数字从产物脚本重算。
2. **把相关性写成因果**：横断面数据只能写关联；干预/扰动设计才谈因果。
3. **「显著」不写检验方法**：必须写检验名、校正方法与效应量方向。
4. **p 值滥用**：大样本下微小差异也显著，需同时给效应量与置信区间。
5. **图注缺 n 与误差定义**：审稿人第一问就是 n 是多少、误差棒是 SD 还是 SEM。
6. **方法不可复现**：只写「默认参数」，没写版本；工具版本变动会改结果。
7. **过度解读通路富集**：富集结果受基因集与背景影响，写成「提示相关」而非「证明」。
8. **忽略阴性结果**：没找到差异也是结果，需要报告检验力与可能原因。

## 自检清单
- [ ] 摘要中的每个数字都能在结果小节找到出处。
- [ ] 正文数字与 `results/` 表、图注一致（脚本校验通过）。
- [ ] 每个结论都有对应图/表编号。
- [ ] 统计方法、校正、效应量、n 齐全。
- [ ] 局限性具体且不回避关键弱点。
- [ ] 可复现性声明含版本、参数、种子、数据 accession。
- [ ] 引用格式统一，工具与数据出处可查。
- [ ] 未经分析支持的推断已删除或标注为假设。

## 输出产物
- `results/report.md`（或 `.docx`/`.html`，由模板生成）
- `results/report_tables.xlsx`（正文引用的所有表）
- `results/reproducibility_statement.txt`
- `results/consistency_check.json`（数字一致性校验结果）
- `figures/`（报告引用的最终图）
