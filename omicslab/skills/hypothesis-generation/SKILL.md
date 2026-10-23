---
name: hypothesis-generation
description: "把观察/文献/历史洞察转化为可证伪、有机制、有明确预测的科研假设：五要素假设卡、预测操作化、竞争假设、Jaccard 去重与可检验性校验，产出可直接写入 discovery 账本的假设。"
when_to_use: "已有数据观察或文献线索但还没有明确假设时；需要把模糊想法（如「免疫微环境影响疗效」）改写成可检验陈述；或审查一组假设是否可证伪、是否值得投入一轮实验时。"
version: "1.0"
---

# 假设生成（hypothesis-generation）

## 何时用
- RSI 循环的步骤②：观察卡已就绪，需要产出 2–4 条候选假设。
- 用户/导师给了一句宽泛判断，需要拆成可检验命题。
- 审阅他人假设：判断它是否可证伪、判据是否可机器执行。

## 一条合格假设 = 五个部分
| 要素 | 要求 | 反例（不合格） |
|---|---|---|
| statement 陈述 | 一句话、可判真假、含对象/条件/方向 | 「免疫很重要」 |
| mechanism 机制 | 因果链：A→B→C，每步有已知依据或明确假说 | 「因为生物学规律」 |
| prediction 预测 | 在什么数据上应看到什么方向/幅度 | 「会有差异」 |
| test_plan 检验方案 | 具体到统计模型、比较族、样本单位 | 「做个分析看看」 |
| success_criteria 判据 | 数值阈值 + 多重校正 + 排除规则 | 「p<0.05 即可」 |

> 判据必须是**执行前**就能写出的，且不依赖结果。写不出判据 = 还不该做实验。

## 生成流程
### 1. 锚定观察（Assumption → Observation）
从观察卡中挑 2–3 个**稳定且可重复**的现象：组间差异、剂量趋势、分层异质性、已知通路富集。每个假设必须能追溯到某个观察或文献依据（`observation_ref` 字段），避免凭空想。

### 2. 补机制链（Mechanism）
机制链至少两步，并标注每一步的证据来源等级：`established`（领域共识）/`plausible`（有间接证据）/`speculative`（纯推测）。整条链全是 speculative 时，降低 `feasibility` 并把第一个可检验环节作为本轮假设。

### 3. 操作化变量（Operationalize）
把抽象概念映射到数据中的具体列/指标：
- 「免疫浸润」→ 某基因集评分（如 ssGSEA/AddModuleScore 的均值）
- 「响应」→ RECIST/临床终点/连续评分变化
- 明确样本单位：患者、样本、批次还是细胞（单细胞必须先聚合到样本层）。
- 写清排除规则（低质量细胞、缺失协变量）。

### 4. 写预测与判据（Prediction & Criteria）
预测要含**方向 + 幅度 + 条件**；判据要含**阈值 + 检验 + 校正 + 样本量要求**。判据与预测不能是同一句话：预测是「应该看到什么」，判据是「看到多少算支持」。

### 5. 写竞争假设（Rival Explanations）
每条主假设配 1–2 条替代解释，至少覆盖：批次/技术效应、细胞组成变化、选择效应（如只测活细胞）、混杂变量（年龄/分期）。竞争假设要么被设计排除，要么在分析中作为协变量/分层因素处理。

### 6. 去重、打分、落盘
用 token Jaccard 与账本已有假设（`discovery_status` 读回）去重；按新颖性/可行性/影响打分；通过校验后写入假设卡文件 `reports/discovery/<project_id>/hypotheses.md` 并交 `discovery-lead` 评审。账本里的假设由 `discovery_run` 引擎自动生成，聊天工具没有手工 `add_hypothesis` 接口。

## 可执行片段
### 假设卡与校验（纯 Python，可直接跑）
```python
import re, json

REQUIRED = ["statement", "rationale", "prediction", "test_plan", "success_criteria"]

def validate_hypothesis(h: dict) -> list[str]:
    errs = [f"missing:{k}" for k in REQUIRED if not str(h.get(k, "")).strip()]
    sc = str(h.get("success_criteria", ""))
    # 判据必须含数值阈值与比较符，否则无法机器判定
    if not re.search(r"(<|<=|>|>=|≤|≥)\s*0?\.\d+", sc):
        errs.append("success_criteria 缺少数值阈值（如 p<0.05 / d>=0.8）")
    if not re.search(r"(FDR|BH|Bonferroni|permutation|置换|校正)", sc, re.I):
        errs.append("success_criteria 未说明多重比较处理")
    if len(str(h.get("prediction", ""))) < 15:
        errs.append("prediction 过于笼统（需含方向与条件）")
    for k in ("novelty", "feasibility", "impact"):
        v = h.get(k)
        if not isinstance(v, (int, float)) or not 0 <= v <= 1:
            errs.append(f"{k} 必须是 0–1 数值")
    return errs

card = {
  "statement": "高 TMB 肿瘤中 CD8 T 细胞浸润越高，免疫治疗客观缓解率越高，且该关联在调整分期后仍存在",
  "rationale": "高 TMB → 新抗原增多（established）→ CD8 识别杀伤增强（plausible）→ 缓解率上升",
  "prediction": "按 CD8 评分三分位分组，OR 从低到高单调上升；调整分期/年龄后 OR 仍 >1",
  "test_plan": "logistic 回归 response ~ CD8_tertile + stage + age；报告 OR 与 95%CI；3 个终点做 BH 校正",
  "success_criteria": "最高 vs 最低三分位 OR>1.5 且 95%CI 不含 1；BH-FDR<0.05；n≥80 且事件数≥20",
  "novelty": 0.5, "feasibility": 0.8, "impact": 0.8,
  "rivals": ["CD8 高可能只是总免疫浸润的代理（需调整总免疫评分）",
             "分期与 CD8 共线（需分层敏感性分析）"],
  "observation_ref": "obs: cohort_tmb_immune 中 CD8 与 response 的初步分层差异"
}
print(validate_hypothesis(card))   # [] = 可提交
```

### 与账本去重
```python
import re
def tokens(s: str) -> set[str]:
    s = re.sub(r"[^\w\u4e00-\u9fff]+", " ", s.lower())
    return set(t for t in s.split() if len(t) > 1)

def jaccard(a: str, b: str) -> float:
    ta, tb = tokens(a), tokens(b)
    return len(ta & tb) / max(len(ta | tb), 1)

existing = ["高 TMB 与免疫治疗响应相关", "CD8 浸润预测疗效"]
print([round(jaccard(card["statement"], e), 3) for e in existing])  # >0.7 需改角度
```

### 假设卡落盘（配合发现项目）
```text
discovery_status(project_id="dp_xxxx")      # 先读引擎已生成的假设与判据，避免重复
# 校验通过的假设卡写入项目文件，交 discovery-lead 评审与决策
write_file(path="reports/discovery/dp_xxxx/hypotheses.md", content="...")
```
> `discovery_run` 的「假设生成」步会产出 2–4 条假设并自动补齐打分与预注册字段；本技能负责在跑引擎前后**审阅与打磨**这些假设卡：字段是否齐全、判据是否数值化、竞争解释是否覆盖。需要新增假设时写成卡片交 lead，由 lead 调整 objective / data_hints 后重跑，而不是假设引擎会接受任意注入文本。

### 需要查函数时
```text
registry_lookup("logistic regression odds ratio", limit=5)
registry_lookup("multiple testing fdr", limit=5)
```
用返回的 `qualname/signature` 决定 `run_python_code` 里怎么调；不要凭记忆写不存在的参数。

## 假设卡模板（JSON）
```json
{"statement": "……", "rationale": "A→B→C（含证据等级）", "prediction": "方向+幅度+条件",
 "test_plan": "模型/比较族/样本单位/排除规则", "success_criteria": "阈值+校正+n 要求",
 "novelty": 0.0, "feasibility": 0.0, "impact": 0.0,
 "rivals": ["替代解释1", "替代解释2"], "observation_ref": "obs:..."}
```

## 检查清单
- [ ] statement 含对象、条件、方向，读一遍能判真假。
- [ ] 机制链每步标了证据等级，没有「因为众所周知」。
- [ ] prediction 与 success_criteria 分离：一个描述期望，一个定义阈值。
- [ ] 判据在执行前可写出，且包含效应量/方向/校正/样本量。
- [ ] 至少一条竞争假设，并说明如何排除。
- [ ] 变量已映射到真实列名，样本单位明确（细胞≠样本）。
- [ ] 与账本已有假设 Jaccard<0.7，无重复。
- [ ] 打分三项均为 0–1，novelty 不是自评「很新」而是对比已知文献。

## 常见陷阱
1. **不可证伪**：「某通路可能参与调控」——没有方向与判据，永远无法否证。
2. **复合假设**：「A 和 B 都影响 C」无法区分哪个被否证；拆成独立假设。
3. **预测=判据**：「预测 p<0.05」不是预测，是把统计阈值当科学预期。
4. **只写机制不写预测**：机制解释力强但不可观测，等于没检验。
5. **事后加条件**：结果不显著就加「只在某亚组」——这是新假设，必须单独预注册。
6. **忽略竞争解释**：批次、组成、选择效应是最常见的「假机制」。
7. **把相关写成因果**：预测里出现「导致」时，必须有随机化/干预或准实验设计支撑。
8. **假设过多**：一轮 3 条以上会导致每条都做不深，且多重比较负担上升。

## 验证方法
- **可证伪性测试**：假想一个观测结果，问「它能否否证这条假设」；不能则重写。
- **盲评**：把 statement 给 `evidence-critic`，不看数据判断是否可检验。
- **反向检验**：写出「若假设为假，最可能看到什么」，与预测对照。
- **可执行性**：把判据交给 `run_python_code` 的思路是否能落地（列是否存在、n 是否够）。
- **去重新鲜度**：Jaccard 与账本对比；若重复则要求新增角度或放弃。

## 交接
- 假设进入检验 → `rsi-discovery-loop` / `experiment-designer` 设计预注册方案。
- 需要统计把关 → `statistical-rigor`；需要因果设计 → `causal-inference`。
- 需要从文献补机制 → 先用 `read_file` 读本地文献；无检索工具时明确标注证据受限。
