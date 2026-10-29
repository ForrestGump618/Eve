# 湿实验技能与结果解读

Eve 1.5.0 把实验设计、经典细胞/分子检测和原始读数解释接入现有科研工作台。能力链复用同一个 `SkillRegistry`、工作区、`RunService` 和人工复核门禁，没有新增第二套调度器。

## 来源与安装边界

- 共享技能库固定到 K-Dense-AI/scientific-agent-skills 的提交 `5f2bc0341354fd5590aef76a533ada1e1e5b4e62`，保留 MIT 许可证和来源元数据。
- 该来源收录 175 项技能；共享目录当前共 390 项、11 个来源。技能元数据常驻，正文和资源按需从内容寻址的压缩包读取。
- `desktop/skill-library/index.json` 和 `desktop/skill-library/library.pack` 是发行时使用的索引与内容包；应用不把整库正文注入模型上下文。
- 上游标注不可再分发的 `deepspot-m` 和 `rowan` 未收录。K-Dense 的技能可能需要外部 Python 包、数据库凭据、仪器或实验室系统；技能存在不等于依赖已安装或服务可用。

## 新增的本机湿实验技能

以下技能同时保存在 `omicslab/skills/`（工作台技能）和 `desktop/bundled-skills/`（桌面技能），两份 `SKILL.md` 由测试检查是否漂移：

| 技能 | 作用 | 依赖 |
| --- | --- | --- |
| `wet-lab-experiment-design` | 固定生物学单位、主要终点、对照、随机化、区组、盲法、样本量、QC、停止规则和交付物 | `experimental-design`、`statistical-rigor` |
| `classic-cell-and-molecular-assays` | 选择并检查细胞培养、活力、凋亡、克隆形成、迁移/侵袭、qPCR、Western、ELISA、流式、IF/IHC、转染、CRISPR、类器官和动物实验 | `wet-lab-experiment-design`、`flow-cytometry` |
| `wet-lab-result-interpretation` | 对细胞活力、qPCR ΔΔCt、Western 归一化和 ELISA 标准曲线做确定性计算与证据分级，不自动宣称显著或因果 | 前两项 + `statistical-rigor` |

这三项技能已在科学工作台的 `experiment` 流程、技能检索同义词和 Agent 系统提示中注册。用户说“设计湿实验”“选择 assay”“解读 qPCR/Western/ELISA”或“分析细胞活力”时，智能体会先检索技能，再按需加载正文和脚本。

## 报告标准与来源

技能把以下公开标准作为最低信息检查表，而不是把标准全文或付费表格复制进提示词。实际执行以官方最新版本、仪器/试剂说明和本单位 SOP 为准：

| 范围 | 标准或资源 | 在 Eve 中的用途 |
| --- | --- | --- |
| 动物实验 | [ARRIVE 2.0](https://arriveguidelines.org/arrive-guidelines) | 样本量、纳入/排除、随机化、盲法、福利、结果测量和解释 |
| qPCR | [MIQE 2.0](https://doi.org/10.1093/clinchem/hvaf043), *Clinical Chemistry* 2025 | RNA 质量、逆转录、引物效率、参考基因、技术重复、缺失 Ct 和报告字段 |
| 流式 | [MIFlowCyt 2.0 / ISAC](https://isac-net.org/miflowcyt-2/) | panel、补偿、门控、事件数、仪器设置和原始 FCS |
| 方法精密度/线性 | [CLSI EP05](https://clsi.org/shop/standards/ep05-plus/)、[EP06](https://clsi.org/shop/standards/ep06/) | 重复性、中间精密度和线性评价的结构参考；主要用于临床实验室方法，不能无条件外推到所有研究 assay |
| 细胞系/试剂身份 | [Cellosaurus](https://www.cellosaurus.org/faq)、[RRID](https://www.rrids.org/rrid-system) | 细胞系身份、关键抗体与试剂的供应商、货号、批号和可追踪标识 |

标准正文、付费表格或机构 SOP 不可获得时，相关字段标为“待核对”，不得生成具体条款、阈值或合规结论。技能输出是研究与实验计划支持，不构成伦理、生物安全、临床或法规批准。

## 执行契约

工作流是：

```text
设计卡 → assay/SOP 与对照 → 原始读数与样本映射
      → 技术 QC → 样本级汇总 → 设计支持的比较
      → 生物学解释与下一步验证
```

`wet-lab-result-interpretation/run.py` 接收一个 JSON 对象，支持：

- `cell_viability`：技术复孔 → 样本均值 → 对照归一化；技术重复不足时 QC 为 `not_assessed`。
- `qpcr_ddct`：目标/参考 Ct → ΔCt、ΔΔCt、相对表达；Ct 必须为正，缺失值不填补，重复数不一致会产生 warning。
- `western_blot`：目标信号/加载量 → 样本比值 → 对照归一化；目标与加载量重复数必须一致，加载信号不能为零。
- `elisa_standard_curve`：线性或对数线性标准曲线；默认不外推，至少两个可用标准点，少于三个标准点不评估 R²。

脚本只做确定性算术和质量提示。它不会选择统计模型、推断显著性、替代 4PL/5PL 验证、确认抗体特异性，也不会执行真实湿实验。

## 输出与证据等级

工作区中的建议目录：

```text
data/          原始文件、样本表和板位表
experiments/   SOP、设计卡、偏差、停止规则与下一步
analysis/      脚本、参数、随机种子和中间结果
figures/       图表与图注
reports/       面向人的摘要
provenance/    来源、版本、文件哈希和执行记录
```

结果解释必须按以下顺序表述：

1. 数据是否完整；
2. 技术 QC 是否通过或未评估；
3. 描述性统计和效应量；
4. 是否有设计支持的比较和预注册模型；
5. 生物学解释和仍需的验证实验。

缺少原始值、样本映射、对照或独立重复时，技能只报告缺口；不会把一张截图、一个均值或一个技术孔当作生物学结论。

## 与科研工作台和许愿式科研的连接

- 「科研与证据 → 科学工作台 → 课题与实验」使用同一条 `experiment` 流程，输出设计、读数 QC、解释和人工复核节点。
- 许愿式科研的 `analysis + experiment_design` 阶段可以引用这些技能；产物仍必须写入当前愿望目录并通过哈希登记。
- 文献、公共数据和实验设计技能可以并行被发现；技能图和依赖闭包决定实际加载的技能束。

## 验证与复现

本轮离线回归：

```powershell
python -m pytest tests/test_wet_lab_skills.py tests/test_science_workbench.py -q
# 36 passed

npm --prefix desktop run build
node --test desktop/dist/test/wet-lab-skills.test.js
# 2 passed
```

`scripts/verify_science_skills.py` 的本地包装检查为 40 项通过、0 项失败。它验证技能目录、依赖和脚本边界，不代表真实模型调用或远端数据库已全部可用。

## 未验证边界

- 没有在真实细胞、动物、临床样本或仪器上执行实验。
- 没有替代伦理、生物安全、知情同意、ARRIVE 2.0 全文审查、MIQE 2.0 全文审查、MIFlowCyt 2.0 认证、CLSI 标准购买/培训、SOP 或实验室培训。
- 没有验证所有 K-Dense 技能的第三方依赖、凭据、网络服务和速率限制。
- 没有证明模型能独立完成高质量实验设计、统计选择或机制推断；这些仍需领域专家复核。
- `docs/verification/wet-lab-1.5.0/` 中的截图和测试证明界面与代码路径，不是湿实验有效性证明。
