---
name: statistical-rigor
description: "统计 rigor 检查与实施：检验选择、前提检查、效应量与 95%CI、多重比较校正（BH/Holm）、置换检验与 bootstrap、样本量/功效与常见统计伪影，确保结论可复现且不被 p-hacking 污染。"
when_to_use: "任何要写进报告/证据账本的统计结论；审阅他人 p 值/显著性声明；需要选检验方法、做多重校正、算效应量或解释 CI 时。"
version: "1.0"
---

# 统计严谨性（statistical-rigor）

## 何时用
- 准备把「显著/不显著」写进结论前。
- 多个终点/亚组/基因集同时检验，需要校正。
- 审阅报告：只有 p 值、没有效应量与 CI 的结论一律退回补全。
- 不确定该用 t 检验、秩和、置换还是混合模型时。

## 报告最低标准（缺一不可）
1. **样本量与单位**：n 是患者/样本，不是细胞数/孔数。
2. **检验名称与单双侧**、模型公式（含协变量）。
3. **效应量 + 95%CI**（不只有 p）。
4. **p 值与校正后 q 值**，注明校正方法与比较族。
5. **前提检查结果**（正态性/方差齐性/独立性）或为何用非参数/置换。
6. **缺失数据与排除规则**。
7. **代码路径 + 随机种子 + 包版本**，保证可重跑。

## 检验选择速查
| 场景 | 首选 | 前提不满足时 |
|---|---|---|
| 两组连续、独立 | Welch t 检验 | Mann-Whitney U / 置换检验 |
| 两组连续、配对 | 配对 t | Wilcoxon 符号秩 / 置换 |
| ≥3 组连续 | 单因素 ANOVA + 事后校正 | Kruskal-Wallis + Dunn |
| 两组比例 | 卡方/Fisher | Fisher 精确（小样本） |
| 计数（泊松/负二项） | 负二项回归 | 泊松 + 稳健标准误 |
| 生存 | Cox / log-rank | 分层 Cox / 限制平均生存时间 |
| 相关 | Pearson | Spearman / 距离相关 |
| 重复测量 | 混合效应模型 | GEE / 聚类稳健标准误 |
| 高维（基因/通路） | 预注册基因集 + 置换 | 不要逐基因 t 检验后挑显著 |

## 前提检查与补救
```python
import numpy as np
def describe(x):
    x = np.asarray(x, float)
    return {"n": x.size, "mean": float(x.mean()), "sd": float(x.std(ddof=1)),
            "median": float(np.median(x)), "iqr": np.percentile(x, [25, 75]).tolist(),
            "skew": float(((x - x.mean()) ** 3).mean() / (x.std() + 1e-12) ** 3)}
print(describe([1.0, 1.2, 0.9, 1.5, 2.0, 0.8]))
```
- 正态性：n<30 时看 QQ 图/偏度；不要只用 Shapiro 的 p 值决定方法。
- 方差齐性：组间 SD 比 >2 时优先 Welch 或置换。
- 独立性：同患者多时间点/同批次样本必须用配对/混合模型/聚类稳健标准误。
- 异常值：预先定义规则（如 |z|>3 且经核查为测量错误），不得因结果不显著而删。

## 多重比较（先定义 family）
- **family** = 同一问题下一起检验的假设集合（如 3 个终点、5 个亚组、20 个基因集）。
- 探索性筛选可用 BH-FDR；确证性主要终点可用 Holm（更严格）。
- 校正是在**报告层面**应用，不是只对显著的做校正。
```python
import numpy as np
def bh_fdr(p):
    p = np.asarray(p, float); n = p.size
    order = np.argsort(p); ranked = p[order]
    q = ranked * n / np.arange(1, n + 1)
    q = np.minimum.accumulate(q[::-1])[::-1]
    out = np.empty(n); out[order] = np.minimum(q, 1.0)
    return out
def holm(p):
    p = np.asarray(p, float); n = p.size; order = np.argsort(p)
    adj = np.minimum(1.0, p[order] * (n - np.arange(n)))
    adj = np.minimum.accumulate(adj)
    out = np.empty(n); out[order] = adj
    return out
p = np.array([0.001, 0.02, 0.04, 0.2])
print("BH  q=", np.round(bh_fdr(p), 4))
print("Holm p=", np.round(holm(p), 4))
```
> 若装了 statsmodels：`from statsmodels.stats.multitest import multipletests`，结果应与上面一致。

## 置换检验与 bootstrap（无 scipy 也能跑）
```python
import numpy as np
def perm_test(a, b, n_perm=10000, seed=0):
    """两组均值差的双侧置换 p 值；样本量小时用精确枚举更佳"""
    a, b = np.asarray(a, float), np.asarray(b, float)
    obs = a.mean() - b.mean()
    rng = np.random.default_rng(seed)
    pool = np.concatenate([a, b]); na = a.size; hits = 0
    for _ in range(n_perm):
        rng.shuffle(pool)
        hits += abs(pool[:na].mean() - pool[na:].mean()) >= abs(obs) - 1e-12
    return float(obs), (hits + 1) / (n_perm + 1)

def boot_ci(x, stat=np.mean, n_boot=10000, alpha=0.05, seed=0):
    x = np.asarray(x, float); rng = np.random.default_rng(seed)
    vals = np.array([stat(rng.choice(x, x.size, replace=True)) for _ in range(n_boot)])
    return np.quantile(vals, [alpha / 2, 1 - alpha / 2])

a = [1.1, 1.3, 0.9, 1.6, 1.2, 1.4]
b = [0.8, 0.7, 1.0, 0.9, 0.6, 0.8]
d, p = perm_test(a, b)
print("diff=", round(d, 3), "p_perm=", round(p, 4), "CI=", np.round(boot_ci(a), 3))
```
> 置换检验回答「若标签可交换，看到这么大差异的概率」；不依赖正态假设，但要求可交换性（配对/区组设计需按区组置换）。

## 效应量（必须与 p 一起报）
```python
import numpy as np
def hedges_g(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    na, nb = a.size, b.size
    sp = np.sqrt(((na - 1) * a.var(ddof=1) + (nb - 1) * b.var(ddof=1)) / (na + nb - 2))
    if sp == 0: return 0.0
    d = (a.mean() - b.mean()) / sp
    return float(d * (1 - 3 / (4 * (na + nb) - 9)))

def cliffs_delta(a, b):
    a, b = np.asarray(a), np.asarray(b)
    gt = sum((x > y) for x in a for y in b)
    lt = sum((x < y) for x in a for y in b)
    return (gt - lt) / (a.size * b.size)     # |δ|: 0.15 小, 0.33 中, 0.47 大

print("g=", round(hedges_g([1.1, 1.3, 0.9], [0.8, 0.7, 0.9]), 3),
      "delta=", round(cliffs_delta([1.1, 1.3, 0.9], [0.8, 0.7, 0.9]), 3))
```
- 二分类：OR/RR + 95%CI；生存：HR + 95%CI；连续：Hedges' g 或 Cliff's δ；解释用**MID**，不要只说「显著」。

## 样本量与功效
样本量必须由 MID 反推（见 `experimental-design` 的纯 stdlib 公式）。事后「观测功效」容易误导：阴性结果应报效应量与 CI，而不是宣称「功效不足所以没事」。

## 常见统计伪影
| 伪影 | 表现 | 对策 |
|---|---|---|
| p-hacking | 换检验/换亚组/换协变量直到显著 | 预注册 + 全部比较入 family + 报告所有尝试 |
| optional stopping | 每加一批样本看一次 p | 固定样本量或序贯设计 + α spending |
| 回归到均值 | 极端组复测变「正常」 | 随机对照 / 重复测量 |
| 幸存者偏倚 | 只分析有完整随访者 | 意向性分析 / 缺失机制讨论 |
| 假重复 | 细胞当 n | 聚合到样本层 / 混合模型 |
| winner's curse | 小样本显著效应复现变小 | 独立复现 + 报告 CI |
| 相关当因果 | 回归系数解释为效应 | 明确关联措辞 + 因果设计 |

## 检查清单
- [ ] 报告 n（独立单位）、效应量、95%CI、p、校正后 q。
- [ ] 检验与设计匹配，前提检查有记录。
- [ ] 多重比较 family 明确且校正方法预先指定。
- [ ] 置换/bootstrap 种子与次数可复现。
- [ ] 阴性结果给出 CI 与 MID 对照，而非只写「不显著」。
- [ ] 所有排除/变换在见结果前定义。
- [ ] 统计代码与数据在同一可重跑路径下。
- [ ] 结论措辞与设计强度匹配（相关≠因果）。

## 常见陷阱
1. **只报 p**：p 不反映效应大小；大 n 下 0.1 SD 也显著。
2. **先做正态检验再选检验**：这会引入选择偏倚；按设计预先选方法。
3. **对显著结果单独校正**：family 必须包含全部检验。
4. **用 SEM 当 SD**：图注必须写清是 SD 还是 SEM。
5. **把技术重复当生物学重复**：n 的定义决定结论能否外推。
6. **方差不齐还用 Student t**：优先 Welch。
7. **协变量事后挑选**：调整集合必须预注册。
8. **忽略聚类**：多中心/多批次数据需混合模型或稳健标准误。

## 验证方法
- **重算**：换一种等价检验（置换 vs 参数）看方向与量级是否一致。
- **敏感性**：增删协变量/异常值/分层，结论是否稳定。
- **模拟零分布**：用设计参数生成零数据，确认假阳性率接近 α。
- **独立复核**：`evidence-critic` 按本 skill 重算关键数字，与报告逐项对照。

## 交接
- 设计阶段 → `experimental-design`；因果推断 → `causal-inference`。
- 结论入账 → `rsi-discovery-loop` 的证据分级；报告成文 → `report-writer`。
