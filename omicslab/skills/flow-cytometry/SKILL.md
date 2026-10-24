---
name: flow-cytometry
description: "流式细胞术分析：FCS 2.0/3.0/3.1 解析、补偿矩阵、logicle/arcsinh 变换、层级门控、群体频率与 MFI、GatingML/FlowJo 互操作与批量队列质控。"
when_to_use: "需要读取 FCS 文件、应用补偿与变换、建立门控层级、统计免疫表型频率或 MFI、把门控导出到 FlowJo/GatingML、或排查补偿失效与通道不匹配时使用。"
version: "1.0"
---

# 流式细胞术分析（flow-cytometry）

## 适用场景
- 免疫表型分型：CD45/SSC 圈门 → 淋巴细胞/单核/粒细胞 → 亚群频率。
- 多管或队列数据批量质控：事件数、存活率、单细胞率、目标群体计数。
- 与 FlowJo 结果对齐：导出/导入 GatingML、WSP，复现他人口径。
- 补偿与变换问题排查：过补偿、双峰、通道名不匹配导致的空群体。

## 前置检查
1. 确认 FCS 版本与数据类型：`$DATATYPE` 应为 `F`（float）；`I`（整数）数据需按 `$PnB/$PnR` 还原。
2. 打印 `pnn_labels`（检测器名，如 `FL1-A`）与 `pns_labels`（标记名，如 `CD3`）；后续门控一律用**唯一且确定存在**的列名。
3. 检查 `$SPILL` / `$SPILLOVER` 是否存在；flowio 的 `text` 字典键全为小写，取 `text.get("spill")` 或 `text.get("spillover")`。
4. 检查 `$PnR`（range）与 `$PnE`（对数参数）；不同仪器差异很大，不要硬编码 262144。
5. 确认是否有单染对照管或补偿对照 FCS，否则只能沿用文件自带矩阵。
6. 事件数：样本 `event_count < 1000` 或目标群体 `< 20` 事件时，频率结论不稳定。

## 依赖与环境
`pip install flowio flowkit`；只解析元数据/事件矩阵时 `flowio` 已足够，门控、变换与 GatingML/WSP 导出必须 `flowkit`。两者只依赖 numpy/pandas，不需要 Java、FlowJo 或 R。

## 步骤
1. **只读元数据**：`flowio.FlowData(path, only_text=True)` 快速拿到 TEXT 段，输出通道、事件数、采集日期、仪器、补偿矩阵。
2. **加载样本**：`fk.Sample(path, sample_id=...)`；确认 `sample.channel_count`、`sample.event_count`。
3. **补偿**：优先 `sample.apply_compensation(spill)`；没有矩阵时用单染对照计算（FlowKit 提供补偿计算工具，或外部软件算好后传入矩阵）。补偿后立刻检查「过/欠补偿」：正相关通道散点是否仍沿对角线、CD45 与 SSC 是否出现非生物学负相关。
4. **变换**：荧光通道用 logicle（`W=0.5, M=4.5, A=0`，`T` 与 `$PnR` 一致），散射光与时间用线性；或按采集软件用 arcsinh（cofactor 常见 150，但不同面板差异大，需记录）。`fk.generate_transforms(sample)` 按通道类型返回 dict；要连散射通道一起变换必须把整个 dict 传给 `apply_transform`，逐通道传入时默认只变换荧光通道。
5. **门控层级**：时间门（排除液流不稳）→ FSC/SSC 单细胞门（去黏连）→ 活死染料阴性门 → CD45+ 门 → 谱系门。每个门记录坐标空间（变换后）与边界值；单样本用 `gating_strategy.gate_sample(sample)`，多样本用 `fk.Session` 复用同一策略。
6. **运行策略**：把变换与门加入 `fk.GatingStrategy`，用 `fk.Session` 批量分析；同 panel 样本复用同一策略。
7. **统计频率**：分母用父门事件数；输出 `subset_count / parent_count`，同时给绝对事件数与百分比。
8. **统计 MFI**：同一变换空间、同一通道，报告 median（或 geometric mean）与样本间分布；不同仪器/批次只比较相对变化。
9. **导出复核**：`session.export_gml(fh)` 或 `session.export_wsp(fh, group_name=...)`；读回用 `fk.parse_gating_xml` / `fk.Workspace`。
10. **批量报告**：每管一行，含事件数、存活率、单细胞率、目标群体频率、补偿是否应用、变换类型。

## 关键代码片段
```python
import numpy as np
import flowio
import flowkit as fk

PATH = "data/demo.fcs"

# 1) 只读元数据：先拿 PnN/PnS/事件数，命名不确定时不要写门
fd = flowio.FlowData(PATH, only_text=True)
print(fd.version, fd.event_count, fd.channel_count, fd.data_type)
print("PnN:", fd.pnn_labels, "PnS:", fd.pns_labels)

# 2) 补偿 + 变换。apply_transform 传整个 dict 才会连散射通道一起变换；
#    逐通道传入时默认只变换荧光通道（include_scatter=False）
sample = fk.Sample(PATH, sample_id="demo")
spill = sample.metadata.get("spill") or sample.metadata.get("spillover")
sample.apply_compensation(spill)
xforms = fk.generate_transforms(sample)      # dict: PnN -> Transform
sample.apply_transform(xforms)

# 3) 在 xform 空间看分布再定阈值（不要照抄 FlowJo 里显示的 logicle 数字）
df = sample.as_dataframe(source="xform")     # MultiIndex 列: (PnN, PnS)
fsc = df[("FSC-A", "FSC-A")].to_numpy()
ssc = df[("SSC-A", "SSC-A")].to_numpy()
fl1 = df[("FL1-A", "CD3")].to_numpy()

def otsu(v):
    h, e = np.histogram(v, bins=128)
    c = (e[:-1] + e[1:]) / 2
    w0 = np.cumsum(h)
    w1 = w0[-1] - w0
    m0 = np.cumsum(h * c) / np.maximum(w0, 1)
    m1 = (np.sum(h * c) - np.cumsum(h * c)) / np.maximum(w1, 1)
    return float(c[int(np.argmax(w0 * w1 * (m0 - m1) ** 2))])

lym_mask = (fsc > 0.10) & (fsc < 0.17) & (ssc < 0.07)   # 低 SSC 小细胞 = 淋巴细胞
thr_cd3 = otsu(fl1[lym_mask])                            # 双峰谷底作为阳性阈值

# 4) 门控策略：边界是 xform 坐标；compensation_ref="FCS" 用文件自带 $SPILLOVER
gs = fk.GatingStrategy()
for pnn, xf in xforms.items():
    gs.add_transform(pnn, xf)                # 注意签名是 add_transform(id, transform)

def dim(ch, lo=None, hi=None):
    return fk.Dimension(ch, compensation_ref="FCS", transformation_ref=ch,
                        range_min=lo, range_max=hi)

gs.add_gate(fk.gates.RectangleGate("lymph",
             [dim("FSC-A", 0.10, 0.17), dim("SSC-A", 0.0, 0.07)]), gate_path=("root",))
gs.add_gate(fk.gates.RectangleGate("CD3+", [dim("FL1-A", thr_cd3)]),
            gate_path=("root", "lymph"))

# 5) 单样本直接分析；同 panel 多样本用 fk.Session 复用同一策略
res = gs.gate_sample(sample)
n_lym = res.get_gate_count("lymph", ("root",))
n_cd3 = res.get_gate_count("CD3+", ("root", "lymph"))
print(f"CD3+ 占淋巴细胞 {n_cd3}/{n_lym} = {n_cd3 / n_lym:.1%}")

# 6) MFI 与导出（GatingML 可被 FlowJo/Cytobank 读回）
mask = res.get_gate_membership("CD3+", ("root", "lymph"))
print("CD3 MFI (median, xform):", float(np.median(fl1[mask])))
sess = fk.Session(gating_strategy=gs)
sess.add_samples([fk.Sample(PATH, sample_id="batch1")])
sess.analyze_samples(use_mp=False)
with open("results/gating.gml", "wb") as fh:
    sess.export_gml(fh)
```

## 参数建议
| 项目 | 建议值 | 说明 |
|---|---|---|
| logicle | `T=$PnR`, `W=0.5`, `M=4.5`, `A=0` | 与 FlowJo/仪器默认对齐，改动必须记录 |
| arcsinh cofactor | 150（起点） | 不同染色指数差异大，同一批保持一致 |
| 时间门 | 排除前后 5–10% | 看时间-事件密度图，去掉液流不稳段 |
| 单细胞门 | FSC-A vs FSC-H | 去黏连用面积-高度相关性，粘连细胞偏离对角线 |
| 存活门 | 活死染料阴性 | 死细胞比例 > 30% 时需检查染色与处理 |
| 最少事件 | 父门 ≥ 1000，目标群 ≥ 20 | 低于此值报告置信区间或不报频率 |
| 门坐标空间 | 由 `as_dataframe(source="xform")` 分布定阈值 | flowkit 的 xform 值是归一化的：线性通道 = raw/`T`（0–1），logicle 通道 `T→1.0`；与 FlowJo 显示的 logicle 数字不同，不能照抄 |

## 常见陷阱
1. **通道名不匹配**：门控用 `CD3` 但文件里 PnS 为空或叫 `CD3-A`，FlowKit 会静默返回空群体或报错；先列 `pnn_labels/pns_labels` 再写门。
2. **门边界照抄 FlowJo 的 logicle 坐标或原始荧光强度**：FlowKit 的门值在它自己的 xform 空间（归一化后 0–1 附近），用原始 8000 或 FlowJo 的 `10^3` 写进去会得到 0 事件；阈值必须来自当前数据 `as_dataframe(source="xform")` 的分布。
3. **补偿没进到门控里**：`fk.Dimension` 的 `compensation_ref` 默认是 `'uncompensated'`，门控时直接用 raw 事件；要用文件自带矩阵必须写 `compensation_ref="FCS"`（或先 `add_comp_matrix` 再引用该 id），且不要在同一条策略里混用两种引用。
4. **spillover 矩阵来自不同 panel**：通道顺序必须与当前文件一致，否则补偿错位且难察觉。
5. **双峰直接单门切**：CD4 弱阳性、CD8 双峰常由滴度/补偿/染色引起，先排查再决定单门或双门。
6. **`$PnR` 与变换参数不一致**：logicle 的 `T` 不等于 range 会导致坐标压缩/拉伸。
7. **只报告百分比不报告事件数**：1% 的 50 个事件和 1% 的 5000 个事件可信度完全不同。
8. **跨仪器比较 MFI**：不同 PMT 电压/激光功率下 MFI 不可直接比，只能同批同设置。

## 自检清单
- [ ] 已打印 FCS 版本、通道数、事件数与 `$SPILL` 是否存在。
- [ ] 补偿前后同一通道散点对比图已生成，过/欠补偿已检查。
- [ ] 门边界确认在变换空间，且每个门的父门路径正确（`("root", ...)`）。
- [ ] 频率分母是父门而不是总事件，命名字段与定义一致。
- [ ] 低事件数样本已标注，未强行给结论。
- [ ] 门控已导出 GatingML/WSP 并试读回一次。
- [ ] 报告记录了 flowio/flowkit 版本、变换参数与补偿来源。

## 输出产物
- `results/flow_summary.csv`（每管事件数、存活率、单细胞率、各群体频率、MFI）
- `results/gating.gml`、`results/pipeline.wsp`
- `figures/fsc_ssc.png`、`figures/cd45_ssc.png`、`figures/subset_frequencies.png`
- `results/flow_params.json`（变换参数、补偿矩阵、门控版本）
