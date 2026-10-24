---
name: single-cell-downstream
description: "单细胞下游分析：差异表达、GO/KEGG/GSVA 富集、细胞比例、拟时序与轨迹、细胞通讯、CNV 推断，以及结果可视化的统计与呈现规范。"
when_to_use: "已有带注释的单细胞对象（或已聚类矩阵），需要比较组间差异、解释功能、推断分化顺序、估计细胞互作或识别恶性细胞时使用。"
version: "1.0"
---

# 单细胞下游分析（single-cell-downstream）

## 适用场景
- 病例 vs 对照、处理 vs 未处理、不同时间点的细胞类型组成与表达差异。
- 需要把差异基因变成通路解释（富集分析）。
- 想推断分化轨迹、细胞状态转换或恶性/正常细胞判别。
- 需要评估细胞类型间配体-受体互作。

## 前置检查
1. 注释是否稳定：cluster → cell type 的映射有 marker 证据；关键结论不要建立在 `low confidence` 的簇上。
2. 样本量与重复：每个比较组至少 2–3 个生物学重复，否则个体效应与组效应无法区分，差异分析只能按细胞做（需明确声明为伪重复）。
3. 是否已整合：比较组间差异时，整合使用的批次列不能与分组共线；若共线，差异结论一律降级。
4. 数据层级：`adata.raw` 是 log 归一化表达，`adata.layers["counts"]` 是原始计数；做 pseudobulk 必须用 counts。
5. 物种与基因组注释版本，决定富集数据库与基因 ID 格式（symbol vs Ensembl）。

## 步骤
1. **确定比较单元**：优先 `pseudobulk`（按 sample × cell_type 求和 counts）后用 DESeq2/limma 类方法，避免把细胞当独立样本；只有单样本数据才退回细胞级 Wilcoxon 并声明局限。
2. **差异表达**：`sc.tl.rank_genes_groups(..., method="wilcoxon")` 用于探索；pseudobulk 用 `pydeseq2`（见 `bulk-transcriptomics` skill）。输出 `log2FC`、`pval`、`padj`、两组表达比例。
3. **过滤与排序**：`padj < 0.05 & |log2FC| > 0.5` 作为候选集；排序用 `-log10(padj) * sign(log2FC)` 或 `log2FC`，不用单一 p 值。
4. **富集分析**：GO/KEGG 用 `gseapy.enrichr`（需网络）或本地 GMT + `gp.prerank`；通路活性用 `decoupler` 的 GSVA/AUCell；结果按 FDR 过滤并报告基因集版本与背景基因数。
5. **细胞比例**：按 `sample × cell_type` 建计数表，用 CLR 变换 + 线性模型、Beta 回归或 Dirichlet 回归（`sccoda`）检验；不要对百分比直接做 t 检验。
6. **拟时序/轨迹**：先决定用哪种—DPT（基于扩散图，稳健、只给顺序）、PAGA（簇间连接图）、scVelo（需要未剪接 reads）、Monocle（R，需要专门对象）。没有 spliced/unspliced 层就不要承诺 RNA velocity。
7. **轨迹基因**：沿伪时序做 GAM/滑动窗口拟合找趋势基因，报告转折点与置信带；不要用「伪时序相关」直接推断调控。
8. **细胞通讯**：`liana` 的 `rank_aggregate` 聚合多个方法（CellPhoneDB、NATMI 等），或单用 CellPhoneDB/CellChat 口径；置换检验得到 p 值，结果必须标为预测。
9. **CNV 推断（可选）**：`infercnvpy` 以免疫/基质细胞为参考，检测上皮/肿瘤细胞的拷贝数变异；结果受参考选择与窗口大小影响，需多参数复核。
10. **可视化**：UMAP 上色、dotplot、stacked violin、热图、比例堆叠图；每张图标 n、统计方法与校正方式。

## 关键代码片段
```python
import scanpy as sc
import numpy as np
import pandas as pd

# 1) 细胞级差异（探索用）
sc.tl.rank_genes_groups(adata, groupby="cell_type", reference="rest",
                        method="wilcoxon", pts=True)
deg = sc.get.rank_genes_groups_df(adata, group="CD8 T")
deg = deg[(deg.pvals_adj < 0.05) & (deg.logfoldchanges.abs() > 0.5)]

# 2) pseudobulk：sample × cell_type 求和（必须用原始 counts）
counts = adata.layers["counts"]
rows = []
for ct in adata.obs["cell_type"].cat.categories:
    sub = adata[adata.obs.cell_type == ct]
    for s in sub.obs["sample"].unique():
        m = sub[sub.obs["sample"] == s].X
        rows.append(pd.Series(np.asarray(m.sum(axis=0)).ravel(),
                              index=adata.var_names, name=f"{ct}|{s}"))
pb = pd.DataFrame(rows).T.astype(int)

# 3) 富集（需网络；离线时换本地 GMT + gp.prerank）
import gseapy as gp
enr = gp.enrichr(gene_list=deg.gene.head(300).tolist(),
                 gene_sets=["GO_Biological_Process_2023", "KEGG_2021_Human"],
                 organism="human", outdir=None)
print(enr.results.sort_values("Adjusted P-value").head(10))

# 4) 通路活性（decoupler >= 1.6 返回 (estimate, pvals)）
import decoupler as dc
est, pv = dc.mt.gsva(adata, net=hallmark_net)   # hallmark_net: DataFrame[sources, genes]

# 5) 细胞比例
comp = (adata.obs.groupby(["sample", "cell_type"], observed=True).size()
        .unstack(fill_value=0))
frac = comp.div(comp.sum(axis=1), axis=0)
clr = np.log(frac.replace(0, np.nan) + 1e-6)
clr = clr.sub(clr.mean(axis=1), axis=0)

# 6) DPT 拟时序（需要根细胞）
sc.tl.diffmap(adata)
adata.uns["iroot"] = int(np.flatnonzero(adata.obs_names == root_cell)[0])
sc.tl.dpt(adata)
sc.tl.paga(adata, groups="cell_type")

# 7) 通讯（LIANA 聚合多方法）
import liana as li
li.mt.rank_aggregate(adata, groupby="cell_type", use_raw=False, n_perms=100)
li.pl.dotplot(adata, colour="lr_means", size="cellphone_pvals",
              liana_res=adata.uns["liana_res"],
              source_labels=["CD8 T"], target_labels=["Macrophage"],
              inverse_size=True, figsize=(6, 4))

# 8) CNV（参考细胞必须选正常二倍体）
import infercnvpy as cnv
cnv.tl.infercnv(adata, reference_key="cell_type",
                reference_cat=["T cell", "B cell", "Macrophage"], window_size=100)
cnv.tl.cnv_score(adata)
```

## 参数建议
| 分析 | 关键参数 | 建议 |
|---|---|---|
| 差异表达 | `method` | 细胞级探索用 wilcoxon；正式结论用 pseudobulk + DESeq2 |
| 差异阈值 | `padj`, `log2FC` | 0.05 / 0.5；单细胞稀疏数据可放宽 log2FC 到 0.25 但需说明 |
| 富集 | 背景基因集 | 用表达检出基因（`adata.var_names` 过滤后）而非全基因组 |
| 拟时序 | 根细胞 | 选生物学明确的起始类型，报告多根细胞敏感性 |
| 通讯 | `n_perms` | ≥ 100（小数据 1000 更稳），置换零模型要写清 |
| CNV | `window_size` | 100 基因窗口为起点，与 50/200 对比稳定性 |

## 常见陷阱
1. **把细胞当重复**：同一供体的 5000 个细胞不是 5000 次独立观测，p 值会小到离谱。
2. **组间比较忽略个体效应**：病例组来自 2 个供体、对照组来自 6 个，差异可能全是供体差异。
3. **富集用全基因组背景**：会系统性高估与表达丰度相关的通路，背景应限于检出基因。
4. **RNA velocity 没有未剪接层**：`scv` 需要 `spliced/unspliced`，只有 counts 矩阵时必须说明无法做，别硬跑。
5. **轨迹方向当因果**：DPT 依赖根细胞选择，换根细胞可能反向；多根细胞验证后再下结论。
6. **通讯结果全表当真**：`liana` 输出成百上千对，必须按表达量、p 值、数据库支持度筛选并做通路层面归纳。
7. **CNV 参考细胞含恶性细胞**：参考集被污染会导致正常细胞出现「CNV」，用正常免疫/基质细胞并检查参考的表达谱纯度。
8. **比例分析与差异分析结论混写**：比例变化与表达变化是两类证据，不能互证。

## 自检清单
- [ ] 比较组有 ≥2 个生物学重复，或已明确声明伪重复局限。
- [ ] 差异表含效应量、p 值、校正后 p 值与表达比例。
- [ ] 富集分析记录了数据库版本、背景基因集与 FDR。
- [ ] 拟时序/velocity 的前提数据（根细胞、spliced/unspliced）已核实。
- [ ] 通讯结果标为预测，列出方法与置换次数。
- [ ] 所有图能追溯到 `results/` 下的表，图注写了 n 与统计方法。

## 输出产物
- `results/degs_<comparison>.csv`、`results/pseudobulk_counts.csv`
- `results/enrichment_<comparison>.csv`、`results/pathway_activity.csv`
- `results/celltype_proportions.csv`、`results/ccc_liana.csv`
- `results/pseudotime.csv`、`results/cnv_scores.csv`（如适用）
- `figures/umap_groups.png`、`figures/de_dotplot.png`、`figures/ccc_dotplot.png`、`figures/paga.png`
