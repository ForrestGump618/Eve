---
name: rsi-discovery-loop
description: "RSI 科研发现闭环完整 playbook：观察（数据/历史/文献）→ 可证伪假设 → 优先级排序与 UCB1 策略选择 → 预注册检验方案 → 真实代码执行 → 证据分级（效应量/多重校正/置换检验/样本量与混杂）→ 反思与策略演化。"
when_to_use: "需要端到端做科研发现而不是单次分析时使用：用户只给目标/数据/领域而未给假设；要建立 discovery 项目、多轮检验、证据分级与策略库自进化；或审计某条结论是否达到 strong 证据标准时。"
version: "1.0"
---

# RSI 科研发现闭环（rsi-discovery-loop）

## 何时用 / 何时不用
- **用**：目标是从数据里发现新知识——提出假设、设计检验、执行、评估、迭代；需要多轮与账本。
- **不用**：用户已指定一次分析（如画 UMAP、跑 QC），按对应领域 skill 直接做，不要为流程而流程。
- 普通分析回答「数据里有什么」，RSI 循环回答「我们该相信什么、为什么、以及下一步问什么」。

## 0. 红线（优先级最高）
1. **不得虚构数据**：没有的数据不补，失败结果不改成成功，模拟/占位结果必须标注 `mock`，不得进入证据账本充当实验证据。
2. **不得把相关性当因果**：观察数据一律说「相关/关联」；因果结论需要随机化、准实验设计或明确假设下的因果模型（见 `causal-inference`）。
3. **不得先看结果再定判据**：检验方案、成功判据、排除规则必须先写入账本（预注册），之后才执行。
4. **结论必须附可复现清单**：代码路径、参数、随机种子、包版本、样本量、检验方法缺一不可。
5. **负结果也是发现**：假设被否证要如实记 `refuted`，不得为报告好看而弱化。

## 闭环总览
| 步骤 | 关键动作 | 产物 | 通过标准 |
|---|---|---|---|
| ① Observe | 清点数据、读本地文献、看历史账本 | 观察卡 | 数据可读、变量可解释、约束明确 |
| ② Hypothesize | 生成 2–4 条可证伪假设 | proposed 假设 | 每条有预测与数值判据 |
| ③ Prioritize | 打分 + UCB1 选策略 | 选中假设/策略 | 分数可复算 |
| ④ Pre-register | 先写检验方案与成功判据 | round 记录 | 判据可机器判定 |
| ⑤ Execute | 真实代码分析、统计、出图 | 结果+图+参数 | 可从原始数据重跑 |
| ⑥ Evaluate | 统计核验 + 证据分级 | evidence + 状态 | 分级有依据 |
| ⑦ Reflect | 失败模式总结、策略变异 | 洞察+新策略 | 可指导下一轮 |

闭环：①观察 → ②假设 → ③排序/选策略 → ④预注册 → ⑤真实执行 → ⑥证据分级 → ⑦反思/策略变异；策略库经 UCB1 反馈回 ③，构成外层进化循环。

## 步骤 1：观察（Observe）
- 数据：`list_files` 看目录与体积 → `run_python_code` 读形状、列名、缺失率、分组、批次；不要凭文件名假设内容。
- 历史：`discovery_status(project_id)` 读已有假设/证据/洞察/策略成功率；上一轮已否证的假设不要原样重提。
- 文献：只能用工作区真实存在的资料（`data/literature/*` 用 `read_file`）。**没有文献检索工具时**在观察卡里写「文献证据受限」，不得编造引用。
- 输出观察卡：`{数据规模, 变量字典, 已知分组, 批次与混杂, 已有证据, 可检验的空白}`。

```text
discovery_list_projects(limit=20)
discovery_status(project_id="dp_xxxx")
list_files(path="data", depth=2)
```

```python
import pandas as pd, json, pathlib
df = pd.read_csv("data/demo_counts.csv")
obs = {"shape": list(df.shape), "columns": [str(c) for c in df.columns][:20],
       "missing_rate": float(df.isna().mean().mean()),
       "numeric_summary": df.describe().round(3).to_dict()}
pathlib.Path("results").mkdir(exist_ok=True)
pathlib.Path("results/observation.json").write_text(json.dumps(obs, ensure_ascii=False, indent=2))
print(obs["shape"], "missing=", round(obs["missing_rate"], 4))
```

## 步骤 2：假设生成（Hypothesize）
每条假设必须同时给出 6 个字段，缺一即不合格：`statement`（陈述）、`rationale`（机制链）、`prediction`（可观测预测）、`test_plan`（检验方法）、`success_criteria`（数值判据）、`novelty/feasibility/impact`（0–1）。

```json
[{"statement": "处理组 CD8 T 细胞耗竭评分高于对照组且随处理时长增加",
  "rationale": "持续抗原刺激 → TOX/PDCD1 上调 → 效应功能下降",
  "prediction": "处理组耗竭评分中位数高 ≥0.5 SD；6h<24h<48h 单调上升（Spearman ρ>0.6）",
  "test_plan": "按样本计算评分 → OLS score ~ group + duration + C(batch) → 效应量与 95%CI",
  "success_criteria": "FDR<0.05 且 |Cohen's d|≥0.8 且方向一致；时间趋势 ρ>0.6 且 p<0.05",
  "novelty": 0.6, "feasibility": 0.9, "impact": 0.7}]
```

- 去重：`statement` 转小写 token 集合，与账本已有假设算 Jaccard；`>0.7` 视为重复，改角度或丢弃。
- 必须同时写**竞争假设**（批次、细胞组成、测序深度、选择效应至少一个），否则容易把混杂当机制。

## 步骤 3：优先级排序与策略选择（Prioritize）
- 打分（与引擎一致）：`score = 0.35*novelty + 0.25*feasibility + 0.20*impact + 0.20*strategy_prior`。
- UCB1 选策略：`ucb = reward + sqrt(2*ln(total_uses+1)/(uses+1))`；新策略（uses=0）天然获得探索机会。
- 每轮只选 1 条假设执行，其余留 `proposed`；并行的直接代价是每条都做不深。

```python
import math
def priority(h, strategy_prior=0.5):
    return 0.35*h["novelty"] + 0.25*h["feasibility"] + 0.20*h["impact"] + 0.20*strategy_prior
def ucb(reward, uses, total_uses):
    return reward + math.sqrt(2 * math.log(total_uses + 1) / (uses + 1))
ranked = sorted(hypotheses, key=priority, reverse=True)
chosen = max(strategies, key=lambda s: ucb(s["reward"], s["uses"], total_uses))
```

## 步骤 4：预注册（Pre-register，防 p-hacking）
执行任何分析**之前**把以下内容写入 round 记录（引擎在 `discovery_run` 里自动先落 test_plan/prediction/success_criteria 再执行；手工推进时把同样的预注册 JSON 写到 `reports/discovery/<project_id>/prereg-*.json`，并在证据摘要里引用该路径）：主要/次要终点、检验方法与单双侧、显著性阈值、效应量阈值（MID）、多重比较校正族、样本排除规则、停止规则与预算。

```json
{"primary_endpoint": "exhaustion_score",
 "test": "OLS score ~ group + duration + C(batch)",
 "alpha": 0.05, "correction": "BH over 3 gene-set endpoints",
 "effect_threshold": {"metric": "cohens_d", "min_abs": 0.8},
 "exclusion": ["n_genes<200", "pct_mt>20"], "stopping": "max_rounds=4 或预算耗尽"}
```

> 执行中必须改判据时：另起新假设/新一轮并记录原因，**不得**覆盖旧判据后声称「原本就这么设计」。

## 步骤 5：真实执行（Execute）
- 用 `run_python_code` 实跑；禁止手写/编造数字。分析代码、参数、随机种子写入 `results/`。
- 至少输出：样本量、效应量及 95%CI、p 与校正后 q、方法名；图存 `figures/`。
- 最后一行给 `结论:`，只写数据支持的内容；阴性写「未观察到」。

```python
import numpy as np, json, pathlib
def hedges_g(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float); na, nb = a.size, b.size
    sp = np.sqrt(((na-1)*a.var(ddof=1)+(nb-1)*b.var(ddof=1))/max(na+nb-2, 1))
    return 0.0 if sp == 0 else (a.mean()-b.mean())/sp*(1-3/(4*(na+nb)-9))
def bh_fdr(p):
    p = np.asarray(p, float); n = p.size; order = np.argsort(p)
    q = np.minimum.accumulate((p[order]*n/np.arange(1, n+1))[::-1])[::-1]
    out = np.empty(n); out[order] = np.minimum(q, 1.0); return out
def perm_test(a, b, n_perm=5000, seed=0):
    a, b = np.asarray(a, float), np.asarray(b, float); obs = a.mean()-b.mean()
    rng = np.random.default_rng(seed); pool = np.concatenate([a, b]); na, hits = a.size, 0
    for _ in range(n_perm):
        rng.shuffle(pool); hits += abs(pool[:na].mean()-pool[na:].mean()) >= abs(obs)-1e-12
    return obs, (hits+1)/(n_perm+1)
rng = np.random.default_rng(7); a, b = rng.normal(1.2, 0.4, 6), rng.normal(0.8, 0.3, 6)
g, p = perm_test(a, b)
print("n=", a.size, b.size, "d=", round(hedges_g(a, b), 3), "p_perm=", round(p, 4))
pathlib.Path("results").mkdir(exist_ok=True)
pathlib.Path("results/round_stats.json").write_text(json.dumps(
    {"diff": g, "p_perm": p, "seed": 0, "n": [a.size, b.size]}, ensure_ascii=False, indent=2))
```

## 步骤 6：评估与证据分级（Evaluate）
| 等级 | 判定标准（全部满足） |
|---|---|
| **strong** | 预注册判据满足；效应量大且 95%CI 不含 0（OR/HR 不含 1）；FDR<0.05；有正交验证或独立复现；样本量满足先验功效；主要混杂已由设计/敏感性分析处理 |
| **moderate** | 统计显著但效应量中/CI 宽；或仅单数据集/单批次；或分析后假设（未预注册）但与机制一致；置换与参数检验方向一致 |
| **weak** | 探索性/事后分组；n 小功效不足；p 未校正或仅 `p<0.1`；只有相关无机制；结果依赖单一阈值；无法复现 |

状态机：`proposed → testing → supported | refuted | inconclusive`；`refuted` 是合法终点。升级证据等级必须有**新证据**，不能因为结论重要而升级。

```python
import numpy as np
# bh_fdr 同上；装了 statsmodels/scipy 可换用 multipletests，结果应与本实现一致
def boot_ci(x, n_boot=5000, alpha=0.05, seed=0):
    x = np.asarray(x, float); rng = np.random.default_rng(seed)
    means = np.array([rng.choice(x, x.size, replace=True).mean() for _ in range(n_boot)])
    return np.quantile(means, [alpha/2, 1-alpha/2])
pvals = np.array([0.012, 0.041, 0.21])       # 仅在真实计算后填入，不可手写
print("q=", np.round(bh_fdr(pvals), 4), "CI=", np.round(boot_ci([1.0, 1.4, 1.1, 1.5, 0.9]), 3))
```

落账调用：`discovery_record_evidence(project_id="dp_xxxx", hypothesis_id="hy_xxxx", summary="处理组耗竭评分高 0.9 SD（95%CI 0.3–1.5），置换 p=0.004，FDR=0.01，n=6/6", kind="statistics", strength="moderate")`（kind=statistics/data/literature/experiment/critique，strength 按上表）。

## 步骤 7：反思与策略演化（Reflect）
| 失败模式 | 表现 | 下一轮策略变异 |
|---|---|---|
| 假设错误 | 方向相反且 CI 排除 0 | 换机制/变量，保留负结果 |
| 判据不可测 | 数据无对应字段 | 先补数据或改用可观测代理 |
| 功效不足 | CI 极宽、方向一致 | 增样本/配对设计/降噪 |
| 方法不适用 | 前提不满足 | 换检验/模型/非参数 |
| 混杂 | 批次/组成与分组共线 | 分层、配对、纳入协变量 |
| 实现错误 | 重跑不一致 | 修代码并复核历史轮次 |

反思输出（与引擎格式一致）：`{"reflection": "...", "lessons": ["..."], "strategy_mutation": {"name": "...", "description": "...", "prompt_hint": "..."}}`。
策略库维护 `uses/successes/reward(0–1)`；成功后奖励上升、失败下降（指数滑动，如 `reward = 0.7*reward + 0.3*outcome`）；新策略 `lineage=当前策略 id`。UCB1 保证不会永远只用当前最优策略；每轮至多变异 1 个策略，避免策略爆炸。

## discovery 工具与运行方式
- 账本工具（聊天/子智能体直接可用）：`discovery_create_project`、`discovery_list_projects`、`discovery_status`、`discovery_run`、`discovery_record_evidence`、`discovery_report`。
- `discovery_run(project_id, max_rounds?)` 就是完整 7 步引擎：自动观察→生成 2–4 条可证伪假设→排序/选策略（UCB1）→预注册→在真实内核执行→评审分级→反思并变异策略；进度以事件流推送，可能耗时数分钟。跑完用 `discovery_status` 逐项核对账本，再 `discovery_report` 出报告。
- **只有真正调用过 `discovery_run` 并读取了 `discovery_status` 才能声称「跑过引擎」**；不得根据设计稿或想象编造引擎输出。
- 手工推进（不跑引擎）时：先 `discovery_create_project` 建项目，自己用 `run_python_code` 执行，再用 `discovery_record_evidence(project_id, hypothesis_id?, summary, kind, strength, code?, result_excerpt?)` 落账。聊天工具没有手工新增假设的接口（假设由引擎生成）；需要新增假设时，把假设卡写成文件并请 lead 决定是否调整 objective 或新建项目重跑。

## 报告必备结构
1. 目标与约束；2. 假设状态表（statement/status/confidence/证据数）；3. 关键证据（强度+代码路径+图）；4. 统计细节（检验、效应量、CI、校正、n）；5. 可复现清单（代码、种子、包版本、参数）；6. 反证与局限（混杂、样本量、外推边界）；7. 下一步可检验问题。

## 检查清单
- [ ] 观察卡中每个变量都有来源与含义；每条假设都有 prediction 与**数值化** success_criteria。
- [ ] 预注册记录早于执行记录（时间戳可查），排除规则在见组间结果前已固定。
- [ ] 报告了效应量 + 95%CI + 校正后 q + 样本量，而非只有 p。
- [ ] 做过至少一次负对照/置换检验或敏感性分析，并讨论样本量与混杂。
- [ ] 假设状态与证据强度匹配，未事后升级；`refuted/inconclusive` 在报告中可见。
- [ ] 结论没有超出证据的因果措辞；所有图可由脚本重跑，参数与种子已记录；mock/降级结果已标注，未进入强证据。

## 常见陷阱
1. **反复换检验直到 p<0.05**：每次换方法都是隐性比较，必须记录并校正；**HARKing**（看到结果后编假设）同样靠预注册时间戳防。
2. **只报 p 不报效应量**：大样本下微小差异也显著，必须给效应量与 CI。
3. **多重比较不校正**：三个终点、五个亚群、十个基因集都属于比较族。
4. **把细胞当独立样本**：单细胞数据先聚合到样本层再统计，否则假重复（pseudoreplication）。
5. **批次/细胞组成混杂**：分组与批次共线时任何差异都无法归因。
6. **相关当因果**：「X 与 Y 相关」不能写成「X 导致 Y」。
7. **选择性报告**：只报显著轮次、隐藏失败轮次。
8. **视觉模型补数据 / mock provider 当真**：图像只提示观察，固定 JSON 只是流程占位，都不是科研证据。

## 验证方法
- **重跑**：从原始数据+预注册参数重跑，结果在容差内一致（记录种子）。
- **置换/负对照**：打乱标签的零分布应覆盖观测值；用无关变量做安慰剂检验。
- **账本审计**：`discovery_status` 对照每轮 outcome、证据 id、假设状态，检查证据链无断点。
- **统计复核**：请 `evidence-critic` 按 `statistical-rigor` 重算 p/效应量/校正。
- **外部效度**：换数据集/批次方向一致才可外推，否则写清边界。

## 交接
- 证据分级与统计复核 → `evidence-critic`；策略反思与下一轮设计 → `research-strategist`；实验方案 → `experiment-designer`；报告成文 → `report-writer`。
