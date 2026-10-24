---
name: bulk-transcriptomics
description: "Bulk RNA-seq/芯片分析：counts 到差异表达（pydeseq2/limma 等价）、TPM/FPKM 换算、批次校正（ComBat）、富集分析、WGCNA 共表达与生存分析。"
when_to_use: "处理有生物学重复的 bulk 转录组或芯片数据，需要差异表达、通路富集、批次校正、共表达模块或预后分析时使用。"
version: "1.0"
---

# Bulk 转录组分析（bulk-transcriptomics）

## 适用场景
- RNA-seq counts 的差异表达（两组或多组、含协变量）。
- 芯片数据（已归一化或原始强度）的差异与富集。
- 需要把 counts 换算成 TPM/FPKM 做跨样本展示。
- 多批次数据整合、WGCNA 模块识别、生存/预后关联。

## 前置检查
1. **数据类型**：RNA-seq 必须是原始整数 counts（`pydeseq2` 会拒绝非整数）；芯片数据用 limma 类方法而不是负二项模型。
2. **样本表**：`metadata` 行名与 counts 列名严格一致；分组列、批次列、协变量列齐全且无缺失。
3. **重复数**：每组 ≥3 才有基本功效；每组 2 例只能做探索性分析并明确声明。
4. **混杂**：检查分组 × 批次交叉表，若处理组全部在 batch2，任何校正都无法救回。
5. **基因注释**：Ensembl ID → symbol 的映射版本；重复 symbol 需聚合（保留最高表达或 sum，规则要写清）。
6. **低表达过滤**：先过滤（如至少在最小分组样本数中 count ≥ 10），否则离散度估计不稳。

## 依赖与环境
`pip install pydeseq2 gseapy inmoose lifelines`；WGCNA 需 R 侧 `WGCNA` 包（或 `PyWGCNA`）。`inmoose` 缺失时批次校正改用 `scanpy.pp.combat`；`gseapy` 离线时只做本地基因集的超几何/排序检验，并在报告中说明未做在线富集。

## 步骤
1. **构建对象**：读 counts（行=基因，列=样本）与 metadata，转置 counts 为样本×基因供 `pydeseq2` 使用；检查对齐。
2. **过滤**：去掉在所有样本中几乎不表达的基因；记录过滤前后基因数。
3. **差异模型**：两组用 `design="~condition"`，含批次用 `design="~batch + condition"`；参考水平显式设置（`ref_level` 或 factorize 顺序）。
4. **离散度与检验**：`dds.deseq2()` 拟合；`DeseqStats(dds, contrast=[...])` 得到 Wald 检验结果；必要时对 LFC 做收缩（`lfc_shrink`）用于排序/可视化。
5. **结果整理**：输出 `baseMean, log2FoldChange, lfcSE, stat, pvalue, padj`；按 `padj < 0.05 & |log2FC| >= 1` 取候选，同时报告效应量分布。
6. **TPM/FPKM（展示用）**：用基因长度（外显子并集长度）换算；不能拿 TPM 做 DESeq2。
7. **批次校正**：需要在表达层面合并时用 ComBat（`inmoose.pycombat` 或 `scanpy.pp.combat`）；差异分析本身把 batch 放设计矩阵优于先 ComBat 再检验（后者会低估方差）。
8. **富集**：GSEA 用排序统计量（`stat` 或 `-log10(p)*sign(log2FC)`）跑 `gseapy.prerank`；ORA 用显著基因 + 表达背景跑 `gseapy.enrichr`（需网络）。报告基因集版本、置换次数、FDR。
9. **WGCNA（可选）**：样本 ≥15 更稳；选方差最大的 3000–8000 基因，软阈值由 scale-free 拟合选；模块与表型做相关，注意相关不等于因果。
10. **生存分析（可选）**：`lifelines` 做 KM 与 Cox；检查比例风险假设（Schoenfeld 残差），多因素模型报告 HR 与 95% CI，避免连续变量随意二分。

## 关键代码片段
```python
import pandas as pd
import numpy as np
from pydeseq2.dds import DeseqDataSet
from pydeseq2.ds import DeseqStats

# counts: 行=基因, 列=样本；meta: 行=样本
counts = pd.read_csv("data/demo_counts.csv", index_col=0)
meta = pd.read_csv("data/demo_metadata.csv", index_col=0)
counts_t = counts.T.loc[meta.index]                     # 样本 × 基因

# 低表达过滤
keep = counts[counts >= 10].shape[0] >= meta["group"].value_counts().min()
counts_f = counts.loc[keep]

dds = DeseqDataSet(counts=counts_f.T, metadata=meta,
                   design="~batch + group", refit_cooks=True, n_cpus=4)
dds.deseq2()
stat = DeseqStats(dds, contrast=["group", "treated", "control"], n_cpus=4)
stat.summary()
res = stat.results_df.sort_values("padj")
res.to_csv("results/deseq2_results.csv")
sig = res[(res.padj < 0.05) & (res.log2FoldChange.abs() >= 1)]

# counts → TPM（展示用）
lengths = pd.read_csv("data/gene_lengths.csv", index_col=0)["length"]   # bp
rpk = counts.div(lengths / 1000, axis=0)
tpm = rpk.div(rpk.sum(axis=0), axis=1) * 1e6

# 批次校正（inmoose 提供的 ComBat 实现）
from inmoose.pycombat import pycombat
corrected = pycombat(np.log2(tpm + 1), meta["batch"])

# GSEA（本地 GMT，离线可用）
import gseapy as gp
ranking = res.reset_index()[["gene", "stat"]].dropna()
pre = gp.prerank(rnk=ranking, gene_sets="data/genesets/hallmark.gmt",
                 permutation_num=1000, outdir=None, seed=0, threads=4)
print(pre.res2d.sort_values("FDR q-val").head(10))

# 生存分析
from lifelines import KaplanMeierFitter, CoxPHFitter
from lifelines.statistics import logrank_test
kmf = KaplanMeierFitter().fit(surv["OS_time"], surv["OS_event"], label="high")
cph = CoxPHFitter(penalizer=0.1)
cph.fit(surv, duration_col="OS_time", event_col="OS_event")
print(cph.summary[["exp(coef)", "exp(coef) lower 95%", "exp(coef) upper 95%", "p"]])
```

## 参数建议
| 项目 | 建议 | 说明 |
|---|---|---|
| 低表达过滤 | 最小分组 n 中 count ≥ 10 | 或 CPM ≥ 1 在 ≥ 20% 样本 |
| 差异阈值 | padj < 0.05, |log2FC| ≥ 1 | 探索可放宽至 0.58（1.5 倍），需声明 |
| 设计矩阵 | `~batch + group` | 协变量与分组共线时不要硬加 |
| ComBat | 仅用于可视化/聚类 | 不要用校正后数据做差异检验 |
| GSEA 置换 | 1000 | 样本 < 7 时用 gene-set 置换 |
| WGCNA 软阈值 | R² > 0.8 的最小 β | 样本少时降低要求并做敏感性 |
| Cox | 事件数 ≥ 10×协变量数 | 否则过拟合，用惩罚项或减少变量 |

## 常见陷阱
1. **把 TPM/FPKM 喂给 DESeq2**：负二项模型假定原始计数，归一化数据会给出错误 p 值。
2. **批次先 ComBat 再检验**：把批次方差抹掉后检验会低估标准误、抬高假阳性；正确做法是把 batch 放进设计矩阵。
3. **分组与批次共线**：如处理组全在 batch2，报告必须直言「无法区分处理与批次」。
4. **p 值排序不看效应量**：大样本下微小变化也显著，候选基因要同时看 log2FC 与表达丰度。
5. **重复 symbol 随意去重**：不同规则（max mean、sum、首条）会改变结果，需固定并记录。
6. **生存分析连续变量最优切点**：用数据选切点会引入选择偏倚，需校正或预先定义。
7. **WGCNA 用全部基因**：低表达/高噪声基因会主导模块，先按方差与表达过滤。
8. **富集分析背景错误**：ORA 的背景应是「检出基因」而不是全基因组。

## 自检清单
- [ ] counts 为整数且样本顺序与 metadata 对齐。
- [ ] 设计矩阵包含所有关键协变量，参考水平明确。
- [ ] 结果表含效应量、标准误、p 与 padj，过滤规则已记录。
- [ ] 批次处理方式在方法中写清（设计矩阵 vs ComBat），未混用。
- [ ] 富集分析的基因集版本、背景、置换次数已记录。
- [ ] 生存分析检查了比例风险假设与事件数是否足够。

## 输出产物
- `results/deseq2_results.csv`、`results/tpm_matrix.csv`
- `results/enrichment_gsea.csv`、`results/enrichment_ora.csv`
- `results/wgcna_modules.csv`、`results/cox_summary.csv`（如适用）
- `figures/volcano.png`、`figures/pca_batch.png`、`figures/gsea_plot.png`、`figures/km_curve.png`
- `results/params.json`
