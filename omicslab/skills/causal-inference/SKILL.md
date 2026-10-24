---
name: causal-inference
description: "从观察数据谨慎逼近因果：明确因果问题与估计目标、用 DAG 选择调整集（后门准则）、识别混杂/选择/中介、选用准实验设计与敏感性分析（E-value、负对照、安慰剂），避免把相关写成因果。"
when_to_use: "用户用「导致/影响/疗效」等因果措辞描述观察数据结论；需要决定调整哪些协变量；评估一个关联能否作为干预依据；或设计观察性验证时。"
version: "1.0"
---

# 因果推断（causal-inference）

## 何时用
- 观察数据中出现组间差异，想判断「处理是否有因果效应」。
- 决定回归里该放哪些协变量（放错会引入偏倚）。
- 审阅报告：把「相关」误写成「导致/改善/降低风险」。
- 设计无法随机化的验证（真实世界数据、回顾性队列）。

## 先分清三类问题
| 问题 | 表现 | 危险 |
|---|---|---|
| 混杂（confounding） | 第三变量同时影响处理与结局 | 高估/低估效应，甚至反转（Simpson） |
| 选择（selection） | 入组/失访/检测与暴露和结局都相关 | 碰撞变量（collider）偏倚 |
| 测量（measurement） | 暴露/结局测量误差与分组相关 | 差异错分导致方向不确定 |

## 因果问题四要素
1. **处理/暴露**（treatment）：明确定义、时间点、剂量。
2. **结局**（outcome）：时间窗、测量方式。
3. **人群**（population）：纳排标准。
4. **估计目标**（estimand）：ATE（全体平均）、ATT（处理组平均）、CATE（条件效应）——不同目标对应不同方法。

> 把问题写成一句话：「在人群 P 中，处理 T 对结局 Y 的 ATE 是多少？」缺任一项，结论无法解释。

## DAG 与调整集（后门准则）
- 画 DAG：节点=变量，边=「可能直接影响」。必须包含未观测混杂（用虚线/标注），否则会高估结论。
- 后门路径：从 T 到 Y 且以指向 T 的箭头开始。阻断所有后门路径的最小变量集合 = 调整集。
- **不要调整**：中介（T→M→Y 的 M，除非做中介分析）、碰撞变量（T→C←Y 或 C 是 T、Y 共同结果）、处理后的变量（会引入偏倚）。
- 无法阻断的后门（未测混杂）→ 必须做敏感性分析，并降低证据等级。

## 设计层级（证据强度从高到低）
1. **随机对照试验（RCT）**：唯一直接支持因果的设计；注意依从性/盲法/损耗。
2. **准实验**：自然实验、工具变量（IV）、断点回归（RDD）、双重差分（DID）、中断时间序列。
3. **观察 + 强设计**：新用户设计、活性对照、倾向评分匹配/加权、负对照结局。
4. **普通观察关联**：只能称「关联」，除非有明确假设与敏感性分析支撑。

## 可执行片段
### 分层标准化（g-computation 简化版，纯 numpy/pandas）
```python
import numpy as np, pandas as pd

def stratified_ate(df, treat="t", outcome="y", confounders=("age_grp", "stage")):
    """按混杂分层，用层内加权差估计 ATE（可视为非参数 g-computation 的离散版）"""
    rows, weights = [], []
    for key, g in df.groupby(list(confounders)):
        if g[treat].nunique() < 2:      # 层内只有一种处理，无法比较
            continue
        diff = g.loc[g[treat] == 1, outcome].mean() - g.loc[g[treat] == 0, outcome].mean()
        rows.append(diff); weights.append(len(g))
    if not rows:
        raise ValueError("没有同时含处理/对照的分层，无法估计")
    return float(np.average(rows, weights=weights))

df = pd.DataFrame({
    "t": [1, 1, 0, 0, 1, 0, 1, 0, 1, 0],
    "y": [5.2, 4.8, 4.1, 4.3, 6.1, 5.0, 5.5, 4.6, 6.0, 4.9],
    "age_grp": ["<60", "<60", "<60", "<60", ">=60", ">=60", ">=60", ">=60", "<60", "<60"],
    "stage": ["I", "I", "I", "I", "II", "II", "II", "II", "II", "II"],
})
print("stratified ATE =", round(stratified_ate(df), 3))
```
> 分层变量必须来自 DAG 的调整集；连续混杂先合理分箱。协变量多时改用倾向评分/回归，但调整集仍由 DAG 决定。

### 双重差分（DID）点估计 + bootstrap CI
```python
import numpy as np
def did_estimate(df, unit="group", time="post", y="score"):
    treated = df[df[unit] == 1]
    control = df[df[unit] == 0]
    return ((treated.loc[treated[time] == 1, y].mean() - treated.loc[treated[time] == 0, y].mean())
            - (control.loc[control[time] == 1, y].mean() - control.loc[control[time] == 0, y].mean()))

def did_boot_ci(df, n_boot=5000, seed=0, alpha=0.05):
    rng = np.random.default_rng(seed); est = []
    n = len(df)
    for _ in range(n_boot):
        est.append(did_estimate(df.iloc[rng.integers(0, n, n)]))
    return np.quantile(est, [alpha/2, 1-alpha/2])

# df 需含 group(0/1), post(0/1), score；此处用随机数据演示
rng = np.random.default_rng(3)
demo = __import__("pandas").DataFrame({"group": rng.integers(0, 2, 60), "post": rng.integers(0, 2, 60)})
demo["score"] = rng.normal(5, 1, 60) + 0.8 * demo["group"] * demo["post"]
print("DID =", round(did_estimate(demo), 3), "CI =", np.round(did_boot_ci(demo), 3))
```
> DID 的关键假设是**平行趋势**：没有处理时两组趋势相同。必须用处理前多期数据画趋势图验证，否则 DID 不成立。

### 未测混杂敏感性：E-value
```python
import math
def e_value_rr(rr: float) -> float:
    """把观测 RR 转成「需要多强的未测混杂才能解释掉它」的 E-value"""
    if rr < 1: rr = 1 / rr
    return rr + math.sqrt(rr * (rr - 1))
for rr in (1.2, 1.5, 2.0):
    print(f"RR={rr}: E-value={e_value_rr(rr):.2f}")
```
- E-value 越大结论越稳健；若 E-value 小于已知混杂的强度，结论可被轻易解释掉。
- 二分类结局近似 `RR ≈ OR^0.5`（常见结局）时可直接换算后再算。

## 敏感性分析清单
- **负对照结局**：找一个理论上不受处理影响的结局，若也「显著」，提示偏倚。
- **负对照暴露**：找一个不应有效应的暴露，检查分析管线是否产生假阳性。
- **安慰剂检验**：把处理标签随机置换，确认估计分布以 0 为中心。
- **改变调整集**：增删可疑协变量（预注册范围内）看方向是否稳定。
- **不同估计目标/方法**：分层 vs 回归 vs 匹配，结论应一致或可解释差异。

## 检查清单
- [ ] 因果问题写成「人群+处理+结局+估计目标」一句话。
- [ ] DAG 明确，调整集由后门准则得到，而非「显著变量都放进去」。
- [ ] 没有调整中介/碰撞/处理后变量。
- [ ] 未测混杂被列出并做了 E-value/敏感性分析。
- [ ] 时间顺序清楚（暴露在结局之前），无永生时间偏倚。
- [ ] 结论措辞与设计强度匹配：RCT 用「导致」，观察用「关联」。
- [ ] 平行趋势/重叠性/工具变量有效性等关键假设被检验或讨论。
- [ ] 报告了效应量 + CI + 目标人群，而非只给 p。

## 常见陷阱
1. **「调整越多越严谨」**：调整中介或碰撞变量反而引入偏倚。
2. **把回归系数直接叫因果效应**：除非设计支持，只能叫关联。
3. **碰撞变量偏倚**：按结局或处理后的变量筛选样本（如只纳入住院患者）。
4. **永生时间偏倚**：处理组在开始处理前的时间被错误计入。
5. **忽略时间顺序**：用结局之后的协变量「调整」。
6. **过度外推**：CATE 在亚组间不同，ATE 不能直接套到个体。
7. **平行趋势未验证**：DID 结果好看但假设不成立。
8. **弱工具变量**：IV 与处理相关性弱时估计方差爆炸且偏倚大。

## 验证方法
- **DAG 复核**：让 `evidence-critic` 独立画一遍 DAG，对比调整集差异并解释。
- **负对照/安慰剂**：见上；假阳性率应接近名义 α。
- **E-value**：报告结论需要多强混杂才能被推翻。
- **多重估计目标**：ATT/ATE 分别估计，看结论是否依赖目标选择。
- **复现**：固定数据、协变量集合、种子后重跑，结果一致。

## 交接
- 设计阶段 → `experimental-design`；统计实施 → `statistical-rigor`。
- 因果结论的证据分级 → `rsi-discovery-loop`（观察性设计最高只能到 moderate，除非有强准实验+敏感性分析）。
- 争议结论 → `evidence-critic` 专审。
