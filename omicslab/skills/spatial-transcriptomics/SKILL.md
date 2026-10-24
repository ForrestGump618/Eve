---
name: spatial-transcriptomics
description: "空间转录组全流程：Visium/Xenium/CosMx/MERFISH 读取、空间质控、邻域与空间可变基因、去卷积选型、空间通讯、空间梯度与假设生成。"
when_to_use: "处理带空间坐标的表达数据（spot 级或单细胞级），需要做空间聚类、邻域富集、空间可变基因、去卷积、细胞通讯或界面/梯度分析时使用。"
version: "1.0"
---

# 空间转录组分析（spatial-transcriptomics）

## 适用场景
- Visium / Slide-seq / Stereo-seq 等 spot 级数据，每个 spot 混合多个细胞。
- Xenium / CosMx / MERFISH / MERSCOPE 等成像型数据，每个细胞有坐标与靶向 panel。
- 需要把空间结构与单细胞参考结合（去卷积、映射），或发现空间共定位模式。

## 前置检查
1. 平台与分辨率：spot 级（55 µm，5–30 个细胞）还是单细胞级（亚微米到几微米）；这决定能不能谈「细胞接触」。
2. 坐标与单位：检查 `obsm["spatial"]` 的列顺序（x, y）、单位（像素/微米）、是否有 `scalefactors_json.json` 可换算。
3. 面板大小：Visium 全转录组 vs CosMx/Xenium 的几百到几千基因 panel；panel 外的基因与通路不能做结论。
4. 参考数据：去卷积需要匹配组织/平台的 scRNA 参考，先算基因交集。
5. 切片方向与形态：确认组织轮廓、是否有坏死/纤维化区域，避免把组织边缘效应当成生物学信号。

## 依赖与环境
`pip install scanpy squidpy spatialdata spatialdata-io cell2location tangram-sc`；`cell2location` 训练需 GPU，缺失或超时时降级为 Tangram 投影或 R 版 RCTD；无 `squidpy` 时空间邻接可用 `sklearn.neighbors.KDTree` 手工建图，但 Moran's I 等统计需自行补置换检验。

## 步骤
1. **读取**：Visium 用 `sc.read_visium`（自动带图像与 scalefactors）；Xenium 优先 `spatialdata_io.xenium` 或手动 h5 + `cells.csv.gz` 构建；CosMx 用 `exprMat` + `metadata` 两个 csv；MERFISH 用计数 csv/h5ad。统一成 `AnnData` + `obsm["spatial"]`。
2. **空间质控**：每 spot/细胞 counts、genes、`pct_counts_mt`；Visium 检查低 counts spot 是否集中在组织外；Xenium 检查阴性对照探针与 `transcript_counts`。
3. **归一化**：`normalize_total(target_sum=1e4)` + `log1p`；去卷积前另存 counts layer；成像型数据 panel 小，HVG 数量按 panel 比例取。
4. **空间邻接与聚类**：`sq.gr.spatial_neighbors` 建图（Visium 六边形网格，单细胞用 Delaunay/generic），再做表达聚类并用空间平滑校正；比较「纯表达聚类」与「表达+空间」两种结果。
5. **空间可变基因（SVG）**：`sq.gr.spatial_autocorr(mode="moran")` 计算 Moran's I，配合置换 p 值；`mode="geary"` 作为敏感性检查。
6. **邻域分析**：`sq.gr.nhood_enrichment`（细胞类型邻域富集）、`sq.gr.co_occurrence`（共现曲线）；用置换零模型判断显著性，报告邻接图定义。
7. **去卷积（spot 级必做）**：按参考与目标选 cell2location / Tangram / RCTD，输出每种细胞类型的丰度或比例，并检查丰度总和与 counts 的相关性。
8. **空间通讯**：`sq.gr.ligrec` 计算配体-受体在邻域中的共表达与置换显著性；或导出邻域组合给 LIANA。结果必须标为预测并给出阈值。
9. **空间梯度/界面**：定义距离变量（到肿瘤边界、到表皮、皮层深度），用滑动窗口均值、GAM 或样条拟合找趋势与转折点；给出拟合曲线与置信带。
10. **假设生成**：把 SVG、邻域富集、通讯与去卷积结果取交集，输出「哪些细胞在什么位置、通过什么配体受体、可能影响什么」的候选清单与验证实验。

## 关键代码片段
```python
import scanpy as sc
import squidpy as sq
import pandas as pd
import anndata as ad

# --- Visium ---
adata = sc.read_visium("data/visium/S1/", count_file="filtered_feature_bc_matrix.h5",
                       library_id="S1", load_images=True)
adata.var_names_make_unique()
sc.pp.calculate_qc_metrics(adata, qc_vars=[], inplace=True)

# --- Xenium 手动构建（h5 + cells.csv.gz）---
x = sc.read_10x_h5("data/xenium/cell_feature_matrix.h5")
cells = pd.read_csv("data/xenium/cells.csv.gz", index_col=0)  # 含 x_centroid, y_centroid
x = x[cells.index.intersection(x.obs_names)].copy()
x.obsm["spatial"] = cells.loc[x.obs_names, ["x_centroid", "y_centroid"]].to_numpy()
# 若安装 spatialdata-io：from spatialdata_io import xenium; x = xenium("data/xenium")

# --- 前处理 ---
adata.layers["counts"] = adata.X.copy()
sc.pp.normalize_total(adata, target_sum=1e4)
sc.pp.log1p(adata)
sc.pp.highly_variable_genes(adata, n_top_genes=2000)
sc.tl.pca(adata, n_comps=30)
sc.pp.neighbors(adata, n_pcs=20)
sc.tl.leiden(adata, resolution=0.6, key_added="spatial_cluster")

# --- 空间邻接、SVG、邻域 ---
sq.gr.spatial_neighbors(adata, coord_type="grid", n_neighs=6)          # Visium
# sq.gr.spatial_neighbors(adata, coord_type="generic", delaunay=True)  # Xenium
sq.gr.spatial_autocorr(adata, mode="moran", genes=adata.var_names[:500],
                       n_perms=100, n_jobs=4)
sq.gr.nhood_enrichment(adata, cluster_key="spatial_cluster")
sq.gr.co_occurrence(adata, cluster_key="spatial_cluster", interval=50)
sq.pl.spatial_scatter(adata, color="spatial_cluster", shape=None, size=5)
sq.pl.nhood_enrichment(adata, cluster_key="spatial_cluster", figsize=(5, 5))

# --- 空间通讯（配体-受体）---
sq.gr.ligrec(adata, n_perms=100, cluster_key="spatial_cluster", use_raw=False)

# --- 去卷积 A：cell2location ---
import cell2location
cell2location.models.Cell2location.setup_anndata(adata_ref, batch_key="sample")
mod = cell2location.models.RegressionModel(adata_ref)
mod.train(max_epochs=250, batch_size=2500)
adata_ref = mod.export_posterior(adata_ref, sample_kwargs={"num_samples": 1000, "batch_size": 2500})
inf_aver = adata_ref.varm["means_cell_abundance_w_sf"]
cell2location.models.Cell2location.setup_anndata(adata, batch_key="slice")
mod = cell2location.models.Cell2location(adata, cell_state_df=inf_aver,
                                         N_cells_per_location=20, detection_alpha=20)
mod.train(max_epochs=20000, batch_size=None)
adata = mod.export_posterior(adata, sample_kwargs={"num_samples": 1000, "batch_size": adata.n_obs})

# --- 去卷积 B：Tangram（快速映射）---
import tangram as tg
tg.pp_adatas(adata_ref, adata, genes=None)
ad_map = tg.map_cells_to_space(adata_ref, adata, mode="clusters",
                               cluster_label="cell_type", num_epochs=500)
tg.project_cell_annotations(ad_map, adata, annotation="cell_type")
```

## 参数建议
| 任务 | 参数 | 建议 |
|---|---|---|
| Visium 邻接 | `n_neighs=6`（六边形） | 也可用 `coord_type="grid"`；不要用 KNN 半径混合 |
| 单细胞邻接 | `delaunay=True` | 细胞密度差异大时考虑固定半径图 |
| SVG | `n_perms` | ≥100（正式结论 1000），报告 I 值与置换 p |
| 聚类 | `resolution` | 0.4–1.0；空间平滑强度作为敏感性参数 |
| 去卷积 | `N_cells_per_location` | Visium 一般 5–30，按 spot 大小与组织密度估 |
| 通讯 | `n_perms` | 100–1000，配体受体数据库版本要记录 |

## 常见陷阱
1. **把 Visium spot 当细胞**：`n_counts` 高的 spot 可能只是细胞更密，「spot 富集」不等于「细胞富集」。
2. **图像坐标与表达矩阵 barcode 错位**：读入后抽查几个高表达 spot 的坐标是否落在组织内。
3. **panel 基因少还跑 HVG 2000**：CosMx/Xenium 只有 1000 基因时 HVG 选几乎全部，PCA 结构主要由技术噪声驱动。
4. **去卷积参考与本组织不匹配**：用脑参考去卷肺组织会得到看似合理但错误的丰度；先检查 marker 基因交集与相关性。
5. **邻域图定义不同导致结论冲突**：报告邻接方式、半径、`n_neighs`，否则无法比较。
6. **空间自相关受组织形状影响**：边界、空洞会抬高/压低 Moran's I，必要时做组织掩膜后重算。
7. **共定位写成因果**：空间共定位只是候选机制，需配体受体、时间或扰动实验验证。
8. **多切片直接合并**：不同切片坐标不可直接拼接，聚类前按切片分别归一化并加批次键。

## 自检清单
- [ ] 平台/分辨率/panel 已记录，结论未越出 panel 覆盖范围。
- [ ] `obsm["spatial"]` 与图像/组织轮廓对齐，坐标单位明确。
- [ ] SVG 与邻域分析都报告了置换次数、零模型与多重校正。
- [ ] 去卷积报告参考来源、基因交集、丰度与 counts 的一致性检查。
- [ ] 所有空间图有比例尺或坐标单位、样本/切片标识。
- [ ] 通讯结论标注「预测」，并给出表达阈值与数据库版本。

## 输出产物
- `results/spatial_adata.h5ad`、`results/params.json`
- `results/svg_moran.csv`、`results/nhood_enrichment.csv`、`results/ccc_spatial.csv`
- `results/deconvolution_abundance.csv`、`results/gradient_fit.csv`
- `figures/spatial_clusters.png`、`figures/svg_moran.png`、`figures/nhood.png`、`figures/deconvolution.png`
