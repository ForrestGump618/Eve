---
name: single-cell-upstream
description: "单细胞转录组上游流程：10x 及其他格式读取、QC 阈值、双细胞识别、归一化、HVG、PCA、批次整合选型、聚类与注释。"
when_to_use: "拿到原始或初步处理过的单细胞表达矩阵，需要从 QC 一路做到带注释的聚类结果时使用；也用于判断是否该整合、整合方法选型、复核已有上游流程的参数。"
version: "1.0"
---

# 单细胞上游分析（single-cell-upstream）

## 适用场景
- 10x Genomics `filtered_feature_bc_matrix`（mtx 三件套或 `.h5`）、BD Rhapsody、Smart-seq2、CEL-Seq 等平台的数据读入与质控。
- 多个样本/批次需要合并，且怀疑存在批次效应。
- 需要对已有注释结果做上游复核（阈值是否合理、doublet 是否清理、HVG 是否泄漏）。

## 前置检查
1. 确认物种与基因组版本，核对线粒体基因命名（人 `MT-`，小鼠 `mt-`），这决定 QC 指标。
2. 确认矩阵是**原始 counts** 还是已归一化矩阵：`adata.X[:5, :5].toarray()` 中若出现小数则不是 counts，后续 DESeq 类或 `seurat_v3` HVG 会失败。
3. 确认 `var_names` 是基因 symbol 还是 Ensembl ID；`sc.read_10x_mtx(..., var_names="gene_symbols")` 可直接转。
4. 多批次时确认 `adata.obs` 里有批次列，且批次与实验分组不要完全共线（共线则整合后也无法区分）。
5. 确认磁盘与内存：10 万细胞 × 3 万基因的稠密矩阵约 12 GB，必须保持稀疏。

## 依赖与环境
`pip install scanpy anndata harmonypy scrublet leidenalg igraph scikit-misc`；`harmonypy` 缺失时跳过 harmony 整合（改用 BBKNN 或不做整合），`scikit-misc` 缺失时 HVG 降级为 `flavor="seurat"`，`leidenalg` 缺失时改用 `sc.tl.louvain`。

## 步骤
1. **读入数据**：mtx 用 `sc.read_10x_mtx`，h5 用 `sc.read_10x_h5`；多样本 `anndata.concat(..., label="sample", keys=[...], index_unique="-")` 合并，不要手工改 barcode。
2. **基础统计**：`sc.pp.calculate_qc_metrics(adata, qc_vars=["mt", "ribo"], percent_top=None, log1p=False, inplace=True)`。
3. **定 QC 阈值**：先画 `sc.pl.violin` / 直方图，看分布拐点；常用起点是 `n_genes_by_counts` 200–500 下限、5000–6000 上限、`pct_counts_mt < 10–20%`，再按组织调整（心肌、肝、肿瘤可放宽到 30%）。
4. **过滤**：`sc.pp.filter_cells(adata, min_genes=200)`、`sc.pp.filter_genes(adata, min_cells=3)`；过滤前后细胞数写入参数表。
5. **双细胞**：按样本分别运行 `sc.pp.scrublet(adata, batch_key="sample")`，得到 `doublet_score` 与 `predicted_doublet`；先标记不删除，观察预测 doublet 的 marker 是否同时表达两类谱系。
6. **归一化**：保留 `adata.layers["counts"] = adata.X.copy()`，然后 `sc.pp.normalize_total(adata, target_sum=1e4)` + `sc.pp.log1p(adata)`，把结果存 `adata.raw` 供可视化。
7. **HVG**：`sc.pp.highly_variable_genes(adata, n_top_genes=2000, batch_key="sample", flavor="seurat_v3", layer="counts")`；无 `scikit-misc` 时降级 `flavor="seurat"`。取 `adata.var.highly_variable` 子集。
8. **缩放与 PCA**：`sc.pp.scale(adata, max_value=10)` 后 `sc.tl.pca(adata, n_comps=50, svd_solver="arpack")`；用 `sc.pl.pca_variance_ratio` 看肘部选前 30–50 个 PC。
9. **整合（按需）**：同平台同物种优先 Harmony（快、保结构）；跨平台/跨模态用 scVI；探索性可视化可用 BBKNN；Scanorama 适合高异质性但可能过度校正。整合后用「同类型细胞跨批次距离」与「marker 是否被抹平」双向检查。
10. **聚类**：`sc.pp.neighbors(adata, n_neighbors=15, n_pcs=30)` → `sc.tl.leiden(adata, resolution=0.8)`；多分辨率 0.4/0.8/1.2 对比，选生物学可解释且对下采样稳定的。
11. **UMAP**：`sc.tl.umap(adata, min_dist=0.3, spread=1.0)`；UMAP 只用于展示，距离不要做定量结论。
12. **注释准备**：`sc.tl.rank_genes_groups(adata, "leiden", method="wilcoxon", use_raw=True)`，导出每个 cluster 的 top 25 基因供人工判读；自动注释（CellTypist/Azimuth）作为对照而非最终答案。

## 关键代码片段
```python
import scanpy as sc
import anndata as ad

# 1) 读入并合并多样本
adatas = {s: sc.read_10x_mtx(f"data/raw/{s}/", var_names="gene_symbols")
          for s in ["S1", "S2", "S3"]}
adata = ad.concat(adatas, label="sample", keys=list(adatas), index_unique="-")

# 2) QC 指标与线粒体比例
adata.var["mt"] = adata.var_names.str.startswith(("MT-", "mt-"))
adata.var["ribo"] = adata.var_names.str.startswith(("RPS", "RPL"))
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt", "ribo"], inplace=True, percent_top=None)

# 3) 过滤（阈值来自分布观察，此处为示例）
sc.pp.filter_cells(adata, min_genes=200)
sc.pp.filter_genes(adata, min_cells=3)
adata = adata[(adata.obs.pct_counts_mt < 20) & (adata.obs.n_genes_by_counts < 6000)].copy()

# 4) 双细胞（按样本）
adata.layers["counts"] = adata.X.copy()
sc.pp.scrublet(adata, batch_key="sample")
adata = adata[~adata.obs["predicted_doublet"]].copy()   # 建议先看分数再删

# 5) 归一化与 HVG
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
adata.raw = adata
sc.pp.highly_variable_genes(adata, n_top_genes=2000, batch_key="sample",
                            flavor="seurat_v3", layer="counts")
adata = adata[:, adata.var.highly_variable].copy()

# 6) PCA + 整合（Harmony）
sc.pp.scale(adata, max_value=10)
sc.tl.pca(adata, n_comps=50, svd_solver="arpack")
sc.external.pp.harmony_integrate(adata, key="sample", basis="X_pca",
                                 adjusted_basis="X_pca_harmony")
sc.pp.neighbors(adata, n_neighbors=15, use_rep="X_pca_harmony")
sc.tl.leiden(adata, resolution=0.8, key_added="leiden")
sc.tl.umap(adata, min_dist=0.3)

# 7) marker 表
sc.tl.rank_genes_groups(adata, "leiden", method="wilcoxon", use_raw=True)
df = sc.get.rank_genes_groups_df(adata, group=None)
df.to_csv("results/cluster_markers.csv", index=False)
```

## 参数建议
| 参数 | 建议起点 | 何时调整 |
|---|---|---|
| `min_genes` | 200 | 核测序/低深度数据降到 100；Smart-seq 可升到 500 |
| `max_genes` | 5000–6000 | 双细胞多时收紧；大细胞（心肌、肝）放宽 |
| `pct_counts_mt` | 10–20% | 肿瘤、心肌、肝、冻存样本可到 25–30% |
| `n_top_genes` | 2000 | 细胞类型复杂时 3000；小 panel 数据按可用基因比例 |
| `n_pcs` | 30–50 | 细胞数少时 ≤ 20；整合后 PC 含义改变，需重看 |
| `leiden resolution` | 0.6–1.0 | 需要亚群时升到 1.2–2.0，同时检查稳定性 |

## 常见陷阱
1. **用全数据选 HVG 后再算差异基因**：HVG 选择本身使用了所有样本，下游统计会有轻微泄漏，严格场景应只在校正后数据上选或固定基因集。
2. **归一化前就做 `sc.pp.scale`**：`scale` 不处理文库大小，必须在 `normalize_total` 之后。
3. **只看 `pct_counts_mt` 不看出 `n_genes`**：低质量细胞常常同时低基因数，只卡线粒体会漏。
4. **整合把真实差异抹平**：整合后检查已知 marker（如 CD3D、LYZ）是否仍有组间差异，否则说明过度整合。
5. **`flavor="seurat_v3"` 忘传 `layer="counts"`**：当 `adata.X` 已 log1p 时会报错或给出错误 HVG。
6. **过滤后不重建稀疏索引**：用布尔索引后 `adata = adata[...].copy()`，否则 `X` 的索引会残留。
7. **注释时只看 top1 基因**：单个 marker 易受 ambient RNA 影响，至少用 3 个 marker 与 dotplot 交叉验证。

## 自检清单
- [ ] 过滤前后细胞数、基因数、每样本保留比例已记录。
- [ ] `adata.layers["counts"]` 是整数，`adata.raw` 是 log 归一化数据。
- [ ] 整合前后 UMAP 都画了，批次混合度有量化描述（如 kBET、iLISI 或简单按样本熵）。
- [ ] 每个 cluster 有 top marker 表，注释有至少两级证据。
- [ ] 参数写入 `results/params.json`，随机种子固定。
- [ ] 中间对象 `results/adata_annotated.h5ad` 已保存。

## 输出产物
- `results/adata_qc.h5ad`、`results/adata_annotated.h5ad`
- `results/qc_summary.csv`（每样本细胞数、median genes、median counts、doublet 率）
- `results/cluster_markers.csv`、`results/annotation.csv`
- `figures/qc_violin.png`、`figures/umap_leiden.png`、`figures/marker_dotplot.png`
- `results/params.json`
