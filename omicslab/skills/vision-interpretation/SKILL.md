---
name: vision-interpretation
description: "用 analyze_image 解读科研图像（UMAP/热图/空间图/显微图/门控图/统计图/界面截图），配合数值重算与图像质检，把读图结果作为观察线索而非定量结论。"
when_to_use: "需要理解用户提供的图片或生成的图；报告前检查图是否被误读；需要从显微/空间/流式图中提取定性观察（形态、分布、门控位置）；或审阅图表是否夸大/误导时。"
version: "1.0"
---

# 图像解读（vision-interpretation）

## 何时用 / 何时不用
- **用**：用户发来图片问「这说明什么」；需要把图转化为文字观察写入报告；图与数据表不一致需要排查。
- **不用**：能从数据直接算出的量（均值、比例、p 值）一律用 `run_python_code` 计算，不要让视觉模型「读数字」。
- 视觉模型负责**描述与定性判断**，数值结论必须由数据计算支撑。

## 工具契约
```text
analyze_image(path: str, question: str = "请详细描述这张图并解读其中的数据含义")
```
- 支持常见位图格式（PNG/JPEG 等），单图 ≤12MB；超大图先缩放到长边 ≤2000px 再上传，但**不要**用缩放图读小字/坐标。
- 视觉 provider 可能是 OpenAI 兼容或 Anthropic；若为 mock/离线 provider，返回是占位结果，**必须标注**，不能当实验证据。
- 一次问一个焦点问题，多轮追问比一次性长问题更准。

## 读图四步法
1. **先客观描述**：图类型、坐标轴、图例、颜色映射、样本/分组、样本量标注、比例尺。不加解释。
2. **再读结构**：趋势、聚类、离群点、分层、空间邻域关系；描述方向与大致幅度，不报精确数值。
3. **对照假设**：这条观察支持/削弱哪个假设？是否存在替代解释（批次、密度、裁剪）？
4. **数值核验**：回到数据重算图上关键统计量（均值差、比例、相关），与图中标注比对；不一致时以数据为准并排查绘图代码。

## 提问模板
```text
# 描述类（先做，不带解释）
analyze_image("figures/umap.png", "客观描述：坐标轴、图例、配色、点密度、是否有明显分群，不要推测生物学含义")

# 解读类（第二轮）
analyze_image("figures/umap.png", "图中处理组与对照组的分布差异在哪里？最可能的三种技术性解释是什么？")

# 审计类
analyze_image("figures/volcano.png", "检查这张火山图是否有误导：坐标轴范围、阈值线、显著点标注、颜色含义是否清楚？")

# 空间/显微图
analyze_image("figures/spatial.png", "描述组织区域、细胞密度梯度与标记物分布；指出缺失的比例尺或图例")
```
> 明确要求「不要推测」比放任模型解释更可靠；第二轮再让它给假设。

## 图像质检（run_python_code，PIL 可用）
```python
from PIL import Image
import pathlib

def image_qc(path: str) -> dict:
    p = pathlib.Path(path); im = Image.open(p)
    w, h = im.size
    dpi = im.info.get("dpi")
    return {"path": str(p), "format": im.format, "mode": im.mode,
            "size": [w, h], "megapixels": round(w * h / 1e6, 3),
            "dpi": list(dpi) if dpi else None, "bytes": p.stat().st_size}

for f in ["figures/umap.png", "figures/spatial.png"]:
    if pathlib.Path(f).exists():
        print(image_qc(f))
```
- 长边 >4000px 或文件 >12MB：生成缩略图用于**整体描述**，另裁小区域看细节；不要把缩略图当证据读坐标数值。
- 截图类图像先确认是否被浏览器缩放、是否含弹窗遮挡。

```python
# 生成缩略图（保持宽高比，长边 1600）
from PIL import Image
im = Image.open("figures/micrograph.png")
im.thumbnail((1600, 1600), Image.LANCZOS)
im.save("figures/micrograph_small.png", optimize=True)
print("saved", im.size)
```

## 数值交叉核验（关键步骤）
```python
import numpy as np, pandas as pd
df = pd.read_csv("results/group_scores.csv")
a = df.loc[df["group"] == "treat", "score"].to_numpy()
b = df.loc[df["group"] == "ctrl", "score"].to_numpy()
print("图中标注差异?", "数据实际均值差=", round(a.mean() - b.mean(), 3),
      "n=", a.size, b.size, "SD=", round(a.std(ddof=1), 3), round(b.std(ddof=1), 3))
```
- 若图像标注的误差线是 SEM，而代码画的是 SD，图注与数据必须统一；这类不一致要在报告里指出。
- 视觉模型说「处理组明显更高」时，用效应量与 CI 确认是否支持「明显」。

## 常见视觉误读
| 误读 | 原因 | 对策 |
|---|---|---|
| 把颜色深浅当绝对量 | 颜色映射未标尺/归一化不同 | 要求色条与数值范围，必要时重算 |
| 截断坐标轴放大差异 | y 轴不从 0 开始且未标注 | 检查轴范围与断轴标记 |
| 过度绘制（overplotting） | 点太密掩盖分布 | 密度图/分位数/抽样重绘 |
| 把批次当生物学 | 批次与分组共线 | 按批次着色重看 |
| 从热图读精确倍数 | 颜色量化为分箱 | 用数据表给 log2FC 与 q |
| 3D/透视误导 | 投影遮挡 | 改 2D/多视角 |
| 显微图缺比例尺 | 无法判断尺度 | 要求比例尺与放大倍数 |
| 压缩伪影 | JPEG 块状/振铃 | 用 PNG/原始图重看 |

## 检查清单
- [ ] 图像路径、尺寸、格式、DPI 已记录。
- [ ] 第一轮只描述，不夹带生物学解释。
- [ ] 图例、坐标轴、色条、比例尺都在描述里被核对。
- [ ] 关键数值（均值差/比例/相关）已用数据重算，与图标注一致。
- [ ] 视觉结论写成「图中可见……」而非「数据证明……」。
- [ ] mock/低分辨率/截断图已在结论中标注局限。
- [ ] 读图结论进入账本前标为观察线索（非强证据）。

## 常见陷阱
1. **让视觉模型读坐标数值**：像素估计误差大；必须回到数据。
2. **单轮长问题**：模型会漏项；拆成描述→解释→审计多轮。
3. **忽略图例与样本量**：不知道点代表什么就解释，必然错。
4. **把图当独立证据**：图是数据的可视化，不能替代统计检验。
5. **缩略图上看小字**：标注/刻度被压缩丢失；裁块放大再看。
6. **mock provider 当真**：固定占位文本不是图像内容。
7. **跨图比较不控色标**：两张图色标范围不同不能直接比深浅。
8. **把视觉「差异明显」写成显著**：显著性是统计判断，不是眼睛判断。

## 验证方法
- **数据回算**：图上每个关键数字都要能由脚本复现。
- **双图对照**：同一数据不同画法（散点/箱线/密度）结论一致才稳。
- **盲读**：不给分组信息让模型描述，再与真实分组对照，检查是否被暗示。
- **重绘**：用 `matplotlib` 重画并记录参数；若重绘图与原图不一致，排查原图代码。
- **像素级检查**：颜色条范围、轴刻度、误差线定义（SD/SEM/CI）逐一确认。

## 交接
- 图形美化/期刊规范 → `figure-style`（若存在）或 `report-writer`。
- 图像揭示的假设 → `hypothesis-generation`；需要统计确认 → `statistical-rigor`。
- 图像来源与可复现性 → 写入 `rsi-discovery-loop` 的可复现清单。
