---
name: experimental-design
description: "为可检验假设设计预注册实验/观察验证方案：对照与随机化、区组与批次平衡、样本量与功效、混杂控制、主要终点与分析计划，产出执行前冻结的设计卡。"
when_to_use: "假设已明确、准备投入真实样本/批次/算力前；需要判断现有数据能否回答该问题；或要为一个已有队列设计验证性分析时。"
version: "1.0"
---

# 实验设计（experimental-design）

## 何时用
- RSI 循环步骤④之前：把假设转成「怎么做、做多少、怎么算成功」。
- 用户说「再做一批样本验证一下」：先确认样本量、批次、终点是否支持结论。
- 审阅他人的「验证实验」：检查是否缺少对照/随机化/预注册。

## 设计五问（先答完再动手）
1. **比较什么**：处理 vs 对照？剂量梯度？分层关联？明确唯一主要终点。
2. **单位是什么**：患者/样本/批次/孔/细胞；统计自由度由独立单位决定，细胞不是独立重复。
3. **怎样避免偏倚**：随机化、区组、盲法（至少分析盲）、批次交叉。
4. **做多少**：基于最小有意义效应（MID）算样本量，而不是「有多少用多少」。
5. **失败怎么办**：无效/毒性/数据缺失的停止规则与降级分析方案。

## 设计类型选择
| 设计 | 适用 | 关键要求 | 常见误用 |
|---|---|---|---|
| 平行对照 | 处理 vs 对照 | 随机化 + 基线均衡 | 按方便分组导致混杂 |
| 区组随机 | 已知批次/中心 | 每区组内随机，分析含区组项 | 忽略区组只看总体 |
| 析因设计 | 两个因素及交互 | 2×2，检验交互项 | 样本量不足以测交互 |
| 剂量-反应 | 找阈值/单调性 | ≥3 个剂量 + 趋势检验 | 只比较最高 vs 最低 |
| 交叉设计 | 个体内比较 | 洗脱期 + 顺序随机 | 携带效应未处理 |
| 观察验证 | 不能干预时 | 预注册混杂集合 + 敏感性分析 | 把调整后关联当因果 |

## 样本量（执行前必须写）
- 两类错误：α（通常 0.05，双侧）、power（通常 0.8）。
- 用 MID 而非「文献里的效应」：MID 由领域意义决定，过小的 MID 需要不现实的样本量。
- 多重终点：按比较族校正后重新估算 α，或指定唯一主要终点。
- 失访/质控损耗：计划样本量 ÷（1−预计损耗率）。

```python
# 纯 stdlib 样本量估算（无需 scipy）
from statistics import NormalDist
import math

def n_per_group_t(d: float, alpha=0.05, power=0.8) -> int:
    z_a = NormalDist().inv_cdf(1 - alpha / 2)
    z_b = NormalDist().inv_cdf(power)
    return math.ceil(2 * (z_a + z_b) ** 2 / d ** 2)

def n_per_group_prop(p1: float, p2: float, alpha=0.05, power=0.8) -> int:
    pbar = (p1 + p2) / 2
    z_a = NormalDist().inv_cdf(1 - alpha / 2)
    z_b = NormalDist().inv_cdf(power)
    num = (z_a * math.sqrt(2 * pbar * (1 - pbar)) +
           z_b * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2
    return math.ceil(num / (p1 - p2) ** 2)

print("d=0.8 ->", n_per_group_t(0.8), "每组")          # ≈26
print("ORR 20%→40% ->", n_per_group_prop(0.2, 0.4))   # ≈82 每组
print("含 15% 损耗 ->", math.ceil(n_per_group_t(0.8) / 0.85))
```
> 更精确的 t 检验/比例检验功效可用 `registry_lookup("power analysis")` 查可用实现；若环境无 statsmodels/scipy，用上式近似并在方案中注明。

## 随机化与区组平衡（代码可直接跑）
```python
import numpy as np

def block_randomize(n: int, arms=("ctrl", "treat"), block=4, seed=0):
    """按区组随机分配，保证每个区组内两组人数接近"""
    rng = np.random.default_rng(seed)
    out, remaining = [], n
    while remaining > 0:
        k = min(block, remaining)
        units = [arms[i % len(arms)] for i in range(k)]
        rng.shuffle(units)
        out.extend(units); remaining -= k
    return out

alloc = block_randomize(20, seed=7)
print("".join("C" if a == "ctrl" else "T" for a in alloc))

# 批次平衡自检：处理组在各批次的人数是否近似均匀（Cramér's V，越接近 0 越好）
import numpy as np
def cramers_v(table: np.ndarray) -> float:
    table = np.asarray(table, float)
    n = table.sum(); exp = table.sum(1, keepdims=True) @ table.sum(0, keepdims=True) / n
    chi2 = ((table - exp) ** 2 / exp).sum()
    return float(np.sqrt(chi2 / (n * (min(table.shape) - 1))))

# 行=批次，列=处理组；模拟计数
print("Cramér's V =", round(cramers_v(np.array([[6, 4], [3, 7], [5, 5]])), 3))
```

## 混杂控制清单
- **设计阶段**：随机化、区组、配对、限制入组（同分期/同年龄层）。
- **测量阶段**：记录候选混杂（年龄、性别、分期、批次、测序深度、细胞组成），不知道是否重要也要记。
- **分析阶段**：预注册主要模型 + 协变量集合；敏感性分析（增删协变量、分层、E-value 思路）。
- **禁止**：看到结果后再挑协变量「调到显著」；这属于 p-hacking。

## 预注册设计卡（冻结后不可改）
```json
{"question": "CD8 浸润是否预测免疫治疗 ORR",
 "design": "回顾性队列验证 + 预注册分析计划",
 "primary_endpoint": "ORR（RECIST）",
 "comparison": "CD8 三分位最高 vs 最低",
 "model": "logistic response ~ CD8_tertile + stage + age + batch",
 "covariates_fixed": ["stage", "age", "batch"],
 "sample_size": {"planned": 120, "power_at_MID": 0.8, "MID_OR": 1.8},
 "exclusions": ["样本量<1e6 reads", "缺分期"],
 "multiplicity": "3 个次要终点 BH-FDR",
 "stopping": "样本不足 80 或事件数<20 时只做描述性分析",
 "analysis_plan_frozen_at": "2026-10-23T00:00:00+08:00"}
```

## 检查清单
- [ ] 主要终点唯一、可测量、有明确时间窗。
- [ ] 独立统计单位写清楚；细胞/孔位数不等于 n。
- [ ] 样本量由 MID + α + power 算出，并计入损耗。
- [ ] 随机化/区组方案与种子已记录，分配可复现。
- [ ] 混杂变量在测量阶段已收集，分析计划预先固定。
- [ ] 多重比较族与校正方法已写明。
- [ ] 排除规则在见结果前固定。
- [ ] 停止规则与阴性结果的报告方式已约定。
- [ ] 预注册时间戳早于任何分组揭盲。

## 常见陷阱
1. **事后算功效**：用观测效应反推 power 没有意义；只报告 CI 与精度。
2. **把重复测量当独立样本**：同一患者多时间点需混合模型/配对分析。
3. **批次与处理共线**：所有处理样本在同一批次 = 批次效应无法分离。
4. **终点漂移**：主要终点不显著就换次要终点并宣称成功。
5. **随机化后破坏**：排除「不理想」样本需事先规则，否则破坏随机性。
6. **盲法缺失**：至少分析阶段对分组编码盲；手工分组易受期望影响。
7. **样本量拍脑袋**：n=3 的组间比较只能提示方向，不能支撑强证据。
8. **忽略损耗**：计划 30 例、实际可用 18 例，功效直接崩。

## 验证方法
- **设计审计**：让 `evidence-critic` 按本 skill 清单逐项检查设计卡。
- **模拟运行**：用 `run_python_code` 按设计参数生成零假设数据，确认假阳性率≈α。
- **敏感性预演**：对最担心的混杂做一次「假设它存在」的模拟，看结论是否翻转。
- **可复现性**：同一设计卡 + 同一种子应得到同一随机分配。

## 交接
- 设计卡 → `rsi-discovery-loop` 步骤④预注册；统计细节 → `statistical-rigor`。
- 因果设计/准实验 → `causal-inference`；大样本计算 → `remote-compute-ssh`。
- 设计被否证/不可行 → `research-strategist` 调整研究策略。
