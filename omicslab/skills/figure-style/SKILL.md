---
name: figure-style
description: "出版级图表规范：色盲友好配色、字体与字号、物理尺寸（单栏 85 mm/双栏 170 mm）、DPI 与导出格式、多面板排版、常见审稿人要求。"
when_to_use: "需要出论文/汇报级图、统一多图风格、调整面板尺寸与字号、选配色与导出格式，或应对审稿人对图的要求时使用。"
version: "1.0"
---

# 出版级图表规范（figure-style）

## 适用场景
- 单细胞 UMAP、空间切片、流式散点/直方图需要统一风格与尺寸。
- 多面板 Figure 1/2/3 拼版，面板字母、对齐、共享图例。
- 期刊投稿要求：单栏/双栏宽度、最小字号、矢量格式、嵌入字体。
- 让「图能被审稿人一眼读懂」：减少装饰、突出数据、标注统计量。

## 前置检查
1. 目标期刊的作者指南：栏宽（Nature 单栏 89 mm、双栏 183 mm；Cell 单栏 85 mm、双栏 170 mm；通用按投稿要求）、最小字号（通常 5–7 pt）、格式（PDF/EPS 矢量，或 ≥300 dpi TIFF）。
2. 图里最终出现的字体：Arial/Helvetica 最通用；中文期刊用宋体/黑体，需确认期刊是否接受。
3. 数据规模：散点过密会糊成一片，需要抽稀/密度图/六边形分箱。
4. 颜色语义：分组色在整个 manuscript 里保持一致，不要一张图一套色。
5. 无障碍：约 8% 男性有红绿色觉异常，红绿对比不可作为唯一区分。

## 依赖与环境
`pip install matplotlib`（≥3.7 支持 `layout="constrained"`）；本 skill 附 `assets/omicslab.mplstyle`，用 `plt.style.use(...)` 或 `matplotlib.style.context(...)` 加载。期刊要求字体缺失时用内置 DejaVu Sans，并在图注或投稿信中说明。

## 步骤
1. **定尺寸**：先按目标栏宽画，不要画完再缩——缩放会改字号。单栏 85 mm ≈ 3.35 in，双栏 170 mm ≈ 6.69 in；高度按内容定，全高一般 ≤ 225 mm。
2. **统一 rcParams**：字号（标题 8 pt、轴标签 7 pt、刻度 6 pt）、线宽（0.8–1.0 pt）、字体族、去上/右边框、刻度朝内。
3. **选配色**：定性用 Okabe–Ito（色盲友好）；连续用 viridis/cividis（不用 jet）；发散用 RdBu 的柔和版；类别多时用色相 + 标记形状双编码。
4. **建面板**：`fig, axes = plt.subplots(nrows, ncols, figsize=(w, h), constrained_layout=True)`；每个面板 `ax.set_xlabel/ylabel`；面板字母用 `ax.text(-0.12, 1.05, "A", transform=ax.transAxes, fontweight="bold")`。
5. **精简**：去掉网格或只留浅色虚线网格；去图例框；轴范围贴数据；统计标注（n、p、检验方法）放图上或图注。
6. **颜色映射要带 colorbar**：标注变量名与单位；类群图例按大小排序，避免 30 个图例项——用「其余」合并。
7. **导出**：矢量 PDF/SVG（文字保持可编辑），同时存 300–600 dpi PNG 用于预览；`bbox_inches="tight"`、`pad_inches=0.02`。
8. **检查**：打印到 A4 实际大小看字号；灰度打印看是否仍可区分；用取色器确认相邻色 ΔE 足够。

## 关键代码片段
```python
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

# 1) 全局 rcParams（可存为 .mplstyle 复用）
plt.rcParams.update({
    "font.family": "sans-serif",
    "font.sans-serif": ["Arial", "Helvetica", "DejaVu Sans"],
    "font.size": 7,
    "axes.titlesize": 8,
    "axes.labelsize": 7,
    "xtick.labelsize": 6,
    "ytick.labelsize": 6,
    "legend.fontsize": 6,
    "axes.linewidth": 0.8,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "xtick.direction": "in",
    "ytick.direction": "in",
    "lines.linewidth": 0.9,
    "legend.frameon": False,
    "pdf.fonttype": 42,      # 嵌入 TrueType，避免投稿时字体丢失
    "ps.fonttype": 42,
    "savefig.dpi": 300,
})

# 2) 色盲友好定性配色（Okabe–Ito）
OKABE_ITO = ["#0072B2", "#D55E00", "#009E73", "#CC79A7",
             "#E69F00", "#56B4E9", "#F0E442", "#000000"]

# 3) 单栏 / 双栏画布（单位 mm 转 inch）
MM = 1 / 25.4
fig, axes = plt.subplots(1, 3, figsize=(170 * MM, 55 * MM), constrained_layout=True)
for i, ax in enumerate(axes):
    x = np.linspace(0, 1, 50)
    ax.plot(x, x ** (i + 1), color=OKABE_ITO[i], label=f"series {i + 1}")
    ax.set_xlabel("Time (h)")
    ax.set_ylabel("Signal (a.u.)")
    ax.text(-0.15, 1.06, "ABC"[i], transform=ax.transAxes,
            fontsize=8, fontweight="bold", va="top")
axes[0].legend(loc="upper left")

# 4) 连续色标 + 颜色条
fig2, ax2 = plt.subplots(figsize=(85 * MM, 70 * MM), constrained_layout=True)
sc = ax2.scatter(np.random.rand(500), np.random.rand(500),
                 c=np.random.rand(500), s=3, cmap="viridis", rasterized=True)
cb = fig2.colorbar(sc, ax=ax2, fraction=0.046, pad=0.02)
cb.set_label("Expression (log1p)", fontsize=6)
cb.ax.tick_params(labelsize=5)

# 5) 导出：矢量 + 位图预览
fig.savefig("figures/fig1_panels.pdf", bbox_inches="tight", pad_inches=0.02)
fig.savefig("figures/fig1_panels.png", dpi=300, bbox_inches="tight", pad_inches=0.02)
```

## 参数建议
| 项目 | 单栏 | 双栏 | 说明 |
|---|---|---|---|
| 宽度 | 85 mm（3.35 in） | 170 mm（6.69 in） | Nature/Cell 略有差异，按投稿指南 |
| 最大高度 | ≤ 100 mm | ≤ 225 mm | 含图注空间 |
| 字号 | 6–7 pt | 7–8 pt | 任何文字不小于 5 pt |
| 线宽 | 0.6–0.8 pt | 0.8–1.0 pt | 缩放后仍可见 |
| 位图 | 300 dpi | 300–600 dpi | 显微图建议 300 dpi 起 |
| 矢量 | PDF/SVG/EPS | 同左 | 字体嵌入（fonttype 42） |

## 常见陷阱
1. **先画大图再缩到栏宽**：字号跟着缩小，最终 3 pt 不可读；正确做法是按目标宽度生成画布。
2. **PDF 字体没嵌入**：投稿系统提示字体缺失，加 `pdf.fonttype = 42`。
3. **jet 色图**：感知不均匀、有伪边界，且红绿色觉异常者难读；用 viridis/cividis/magma。
4. **红绿二值编码**：色盲不可区分；用蓝-橙或加标记形状。
5. **图例比数据还大**：30 类以上用「高亮 + 其余灰色」或直接标在图上。
6. **散点过密**：单细胞 UMAP 几万个点会糊；降低点大小、设 alpha、或按密度上色。
7. **栅格化整图**：导致文字模糊；只对散点层 `rasterized=True`，文字与线保持矢量。
8. **多面板字号不一**：拼图时用同一 rcParams，且拼完后检查每张子图的坐标轴字号。

## 自检清单
- [ ] 图宽 = 目标栏宽，打印后最小字号 ≥ 5 pt。
- [ ] 字体嵌入（PDF），且与正文一致。
- [ ] 配色色盲友好、灰度打印仍可区分。
- [ ] 每个面板有轴标签与单位，面板字母齐全且顺序正确。
- [ ] 颜色条、图例语义清晰，类别排序合理。
- [ ] 统计标注（n、检验、p 值）与图注一致。
- [ ] 导出 PDF 与 300 dpi PNG，文件名与 Figure 编号对应。
- [ ] 原图（未拼版）保留在 `figures/panels/` 便于返修。

## 输出产物
- `figures/fig<N>_<topic>.pdf`、`figures/fig<N>_<topic>.png`
- `figures/panels/`（单面板原图，便于单独返修）
- `assets/omicslab.mplstyle`（可复用的全局样式）
- `results/params.json` 中记录画布尺寸、字号、配色与导出参数
