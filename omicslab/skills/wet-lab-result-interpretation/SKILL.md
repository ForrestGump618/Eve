---
name: wet-lab-result-interpretation
description: "湿实验结果的 QC 与分层解读：细胞活力、qPCR ΔΔCt、Western blot 归一化、ELISA 标准曲线；区分技术误差、描述性差异、设计支持的比较和机制推测，不自动宣称显著或因果。"
when_to_use: "拿到细胞活力、qPCR、Western blot、ELISA 或其他湿实验原始/汇总读数后；需要先做质量控制、归一化、计算效应量并与方案对照解释时。"
version: "1.0"
depends_on: [wet-lab-experiment-design, classic-cell-and-molecular-assays, statistical-rigor]
---

# 湿实验结果解读

## 证据顺序

必须按以下顺序处理，不能跳步：

1. **采集完整性**：原始文件、样本 ID、板位/反应孔、单位、仪器、阈值、批次和哈希是否存在。
2. **技术 QC**：空白、对照、标准曲线、复孔离散度、饱和、污染、门控和缺失值是否符合预先定义的 SOP。
3. **描述统计**：保留原始读数，按样本计算技术均值和离散度，再由独立样本进入组间比较。
4. **设计支持的比较**：只有独立生物学重复、预注册模型和合理 QC 才能进入推断统计；效应量和置信区间优先于单独的 p 值。
5. **生物学解释**：区分“观察到差异”“与哪个假设一致”“是否建立了机制”；最后写出仍需的验证实验。

如果缺少原始读数、样本映射、单位、对照或独立重复，只能报告数据缺口，不能把图像或汇总值解释成处理效应。

## 确定性脚本

桌面 Skill 运行时提供 `run.py`，输入一个 JSON 对象，支持：

- `cell_viability`：技术复孔 → 样本均值 → 相对对照归一化；可选 `cv_limit_percent`。只有一个技术读数时，CV 无法评估，QC 返回 `not_assessed`，不能当作通过。
- `qpcr_ddct`：目标/参考基因 Ct → ΔCt、ΔΔCt、相对表达；要求原始 Ct 和技术复孔。
- `western_blot`：目标信号/加载量 → 样本比值 → 对照归一化；要求原始强度。
- `elisa_standard_curve`：线性或对数线性标准曲线；默认不外推，报告超出标准范围的样本。

脚本做确定性算术和质量提示；它**不**替用户选择 α、power、统计模型或因果结论。

### `cell_viability`

```json
{
  "assay": "cell_viability",
  "control": "vehicle",
  "groups": {
    "vehicle": [
      {"sample_id": "V1", "values": [1.01, 0.98, 1.02]},
      {"sample_id": "V2", "values": [0.97, 1.00, 1.01]}
    ],
    "drug": [
      {"sample_id": "D1", "values": [0.61, 0.58, 0.60]},
      {"sample_id": "D2", "values": [0.66, 0.63, 0.65]}
    ]
  },
  "cv_limit_percent": 15
}
```

输出包含每个样本的技术均值/标准差/CV、组内生物学重复的均值/标准差、相对对照百分比，以及未评估或未达门槛的 QC 提示。`n` 是样本对象数量，不是复孔数量。

### `qpcr_ddct`

```json
{
  "assay": "qpcr_ddct",
  "control": "control",
  "target_gene": "IL6",
  "reference_gene": "GAPDH",
  "efficiency": 2.0,
  "groups": {
    "control": [
      {"sample_id": "C1", "target_ct": [24.1, 24.3], "reference_ct": [18.2, 18.1]}
    ],
    "treated": [
      {"sample_id": "T1", "target_ct": [22.0, 22.2], "reference_ct": [18.0, 18.1]}
    ]
  }
}
```

`efficiency` 是用户/验证实验提供的底数；没有提供时脚本会使用 2.0 并明确标记该假设。目标或参考基因效率不等时，应使用 Pfaffl 效率校正，不得直接套用 2^-ΔΔCt。`null`、`undetermined` 等缺失 Ct 只作为排除/警告记录，不填补。

### `western_blot`

```json
{
  "assay": "western_blot",
  "control": "control",
  "groups": {
    "control": [
      {"sample_id": "C1", "target": [1200, 1180], "loading": [900, 910]}
    ],
    "treated": [
      {"sample_id": "T1", "target": [2100, 2050], "loading": [890, 900]}
    ]
  },
  "cv_limit_percent": 15
}
```

脚本使用同一技术孔索引计算 `target/loading`，再对独立样本的比值做对照归一化。曝光饱和、病理性裁剪和不同膜/批次的信号不能合并；先回到原始图像检查。

### `elisa_standard_curve`

```json
{
  "assay": "elisa_standard_curve",
  "model": "linear",
  "blank_subtract": true,
  "standards": [
    {"concentration": 0, "signal": 0.05},
    {"concentration": 10, "signal": 0.32},
    {"concentration": 20, "signal": 0.61}
  ],
  "samples": [
    {"sample_id": "S1", "signal": [0.44, 0.45], "dilution_factor": 2}
  ]
}
```

`model` 只接受 `linear` 或 `log_linear`。标准曲线必须有至少 2 个不同浓度，`r2_min` 只有在至少 3 个可用标准点时才会被评估为通过。样本回算值超出标准范围时标记 `in_standard_range=false`，`concentration` 和 `reported_concentration` 返回 `null`，不做外推。若检测是明显 S 形，使用经验证的 4PL/5PL 软件，不要用线性脚本硬拟合。

## 解释分级

| 分级 | 允许的表述 | 不允许的表述 |
|---|---|---|
| 数据缺失 | 缺原始值/对照/独立重复 | “趋势已经证明” |
| QC 未通过 | 本次读数不可用于主结论 | 删除失败孔后重新宣称显著 |
| 描述性 | 样本均值、SD、CV、效应方向 | “显著”“因果” |
| 设计支持的比较 | 预注册模型、效应量、CI、独立重复 | 事后换终点或挑协变量 |
| 生物学解释 | 与假设一致，提出机制候选 | 仅凭相关性宣称机制成立 |
| 下一步 | 明确验证 assay、样本量和判据 | 把计划写成已完成 |

## 结果输出模板

```json
{
  "assay": "",
  "data_completeness": {"raw": false, "sample_map": false, "controls": false, "independent_replicates": 0},
  "qc": {"status": "not_assessed", "thresholds": [], "failures": [], "not_assessed": []},
  "descriptive": {},
  "comparison": {"status": "not_run", "reason": "缺少可分析设计"},
  "interpretation": {"level": "descriptive", "supported": [], "unsupported": [], "next_validation": []},
  "provenance": {"raw_files": [], "analysis_script": "", "hashes": []}
}
```

脚本输出中存在数值不等于实验结论成立。最终回答应先写 QC 和数据边界，再写描述性结果，最后写仍需的独立重复、统计和湿实验验证。

## 报告标准映射

- 细胞活力、qPCR、Western 与 ELISA 的样本映射、原始读数、对照、技术重复和排除理由必须可追溯；不能只保留归一化结果。
- qPCR 报告按 MIQE 2.0 对齐的关键字段包括 RNA 质量、逆转录、引物效率、参考基因、扩增特异性、技术重复、缺失值和统计方法。https://doi.org/10.1093/clinchem/hvaf043
- 流式结果按 MIFlowCyt 2.0/ISAC 要求保留 panel、补偿、门控、事件数、仪器设置和原始 FCS。https://isac-net.org/miflowcyt-2/
- 涉及精密度、重复性、线性和检出范围的验证时，可参考 CLSI EP05 与 CLSI EP06 的实验结构；这些标准主要面向临床实验室方法，本项目仍以预先写明的研究分析计划为准。https://clsi.org/shop/standards/ep05-plus/ 和 https://clsi.org/shop/standards/ep06/
- 动物来源结果按 ARRIVE 2.0 报告随机化、盲法、样本量、排除、福利和统计。https://arriveguidelines.org/arrive-guidelines
- 细胞系与关键试剂记录 Cellosaurus/RRID、供应商、货号和批号，避免身份不明或批次漂移被误当作处理效应。https://www.cellosaurus.org/faq 和 https://www.rrids.org/rrid-system

若输入没有标准所需字段，输出 `not_assessed` 或明确缺失项；标准全文、仪器说明或机构 SOP 不可获得时标为“待核对”；不得用默认值、外推或模型知识补齐原始记录。
