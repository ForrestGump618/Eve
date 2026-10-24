---
name: cadd-cheminformatics
description: "计算机辅助药物设计：SMILES 标准化、RDKit 描述符、相似性搜索与聚类、靶点预测接口（含离线降级）、类药性与 ADMET 规则、虚拟筛选流程。"
when_to_use: "需要处理化合物库或单个分子、计算理化性质与指纹、做相似性/骨架聚类、筛类药性、预测靶点或搭建虚拟筛选流水线时使用。"
version: "1.0"
---

# 计算机辅助药物设计（cadd-cheminformatics）

## 适用场景
- 化合物库标准化、去重、描述符计算与可视化。
- 基于相似性的虚拟筛选（相似化合物搜索、骨架跃迁）。
- 类药性/ADMET 规则初筛（Lipinski、Veber、Egan 等）。
- 候选靶点推断（在线 ChEMBL/PubChem 接口或离线 SEA 类方法）；QSAR 前的数据准备与骨架划分。

## 前置检查
1. 确认 RDKit 可用：`python -c "import rdkit; print(rdkit.__version__)"`；建议 ≥ 2022.09（`GetMorganGenerator` 新 API），旧版用 `GetMorganFingerprintAsBitVect`。
2. 输入格式：SMILES 表、SDF、CSV 列名；确认是否有盐、溶剂化物、同位素、立体化学标记。
3. 单位与阈值：MW 用 Da、TPSA 用 Å²；不同来源的 logP 计算口径不同（Crippen 近似）。
4. 数据合规：外部服务（ChEMBL/PubChem）有速率限制与使用条款；不要把未公开结构批量上传。
5. 化学空间：先做骨架聚类与理化性质分布，避免库内同系列化合物扎堆。

## 依赖与环境
`pip install rdkit pandas numpy matplotlib requests`；无网络时靶点预测降级为本地活性参考集相似性匹配（结果只能标为假设）。

## 步骤
1. **标准化**：解析 SMILES → 去盐（最大片段）→ 中和电荷 → 规范互变异构（按需）→ 生成 canonical SMILES 作为去重键。
2. **质控**：记录解析失败率、含金属/多组分比例、分子量分布；解析失败的结构单独列出，不要静默丢弃。
3. **描述符**：计算 MW、logP、TPSA、HBD、HBA、可旋转键、环数、芳香环数、FractionCSP3、QED；统一存表。
4. **指纹与相似性**：Morgan（ECFP4 等价：radius=2, 2048 bits）+ Tanimoto；查询分子用 `BulkTanimotoSimilarity` 批量算，取 top-N 命中。
5. **聚类与多样性**：Butina 聚类（距离阈值 0.3–0.4）或骨架（Murcko scaffold）分组；从每个簇选代表分子控制冗余。
6. **规则初筛**：Lipinski（MW≤500, logP≤5, HBD≤5, HBA≤10）、Veber（可旋转键≤10, TPSA≤140）、Egan（logP≤5.88, TPSA≤131.6）；记录命中几条规则，不搞「一票否决」除非任务要求。
7. **靶点预测**：在线用 ChEMBL 相似性/活性接口或 PubChem 邻居；离线用本地活性参考集做 SEA（相似性→靶点富集），结果标为「假设」。无网络时明确告知用户降级。
8. **虚拟筛选**：库标准化 → 描述符/规则过滤 → 指纹相似性或药效团/对接（外部程序）→ 打分排序 → 聚类去冗余 → top-N 人工复核。
9. **交付**：候选表含 SMILES、ID、关键描述符、规则命中、相似性/靶点证据与来源；分子网格图用于快速人工浏览。

## 关键代码片段
```python
import pandas as pd
import numpy as np
from rdkit import Chem
from rdkit.Chem import Descriptors, rdMolDescriptors, AllChem, DataStructs, Draw
from rdkit.Chem.MolStandardize import rdMolStandardize

# 1) 标准化（去盐 + 中和）
lfc = rdMolStandardize.LargestFragmentChooser()
uncharger = rdMolStandardize.Uncharger()

def standardize(smi):
    mol = Chem.MolFromSmiles(smi)
    if mol is None:
        return None
    mol = lfc.choose(mol)
    mol = uncharger.uncharge(mol)
    return mol

df = pd.read_csv("data/compound_library.csv")
df["mol"] = df["smiles"].map(standardize)
df["canonical"] = df["mol"].map(lambda m: Chem.MolToSmiles(m) if m else None)
df = df.dropna(subset=["canonical"]).drop_duplicates("canonical")
# 2) 描述符
def props(m):
    return {
        "MW": Descriptors.MolWt(m),
        "logP": Descriptors.MolLogP(m),
        "TPSA": rdMolDescriptors.CalcTPSA(m),
        "HBD": rdMolDescriptors.CalcNumHBD(m),
        "HBA": rdMolDescriptors.CalcNumHBA(m),
        "RotB": rdMolDescriptors.CalcNumRotatableBonds(m),
        "AromaticRings": rdMolDescriptors.CalcNumAromaticRings(m),
        "FractionCSP3": rdMolDescriptors.CalcFractionCSP3(m),
        "QED": Descriptors.qed(m),
    }
prop_df = pd.DataFrame([props(m) for m in df["mol"]], index=df.index)
# 3) 类药性规则（命中违规项数量）
def lipinski_violations(p):
    return sum([p["MW"] > 500, p["logP"] > 5, p["HBD"] > 5, p["HBA"] > 10])

def veber_violations(p):
    return sum([p["RotB"] > 10, p["TPSA"] > 140])

df = pd.concat([df, prop_df], axis=1)
df["lipinski_viol"] = prop_df.apply(lipinski_violations, axis=1)
df["veber_viol"] = prop_df.apply(veber_violations, axis=1)

# 4) Morgan 指纹 + Tanimoto 检索（RDKit >= 2022.09）
gen = AllChem.GetMorganGenerator(radius=2, fpSize=2048)
fps = [gen.GetFingerprint(m) for m in df["mol"]]
query_fp = gen.GetFingerprint(Chem.MolFromSmiles("CC(=O)Oc1ccccc1C(=O)O"))
sims = DataStructs.BulkTanimotoSimilarity(query_fp, fps)
df["tanimoto_to_query"] = sims
hits = df.sort_values("tanimoto_to_query", ascending=False).head(20)

# 5) Butina 聚类（多样性选择）
from rdkit.ML.Cluster import Butina
dists = []
for i in range(1, len(fps)):
    dists.extend([1 - s for s in DataStructs.BulkTanimotoSimilarity(fps[i], fps[:i])])
clusters = Butina.ClusterData(dists, len(fps), 0.35, isDistData=True)
representatives = [df.index[c[0]] for c in clusters]

# 6) 分子网格图（人工浏览）
img = Draw.MolsToGridImage([df.loc[i, "mol"] for i in representatives[:24]],
                           molsPerRow=6, subImgSize=(220, 180),
                           legends=[f"{i}" for i in representatives[:24]])
img.save("figures/library_representatives.png")

# 7) 靶点预测（在线 ChEMBL 相似性，需网络；失败则走离线降级）
import requests
url = ("https://www.ebi.ac.uk/chembl/api/data/similarity/"
       "CC(=O)Oc1ccccc1C(=O)O/70.json")
try:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    chembl_hits = r.json().get("molecules", [])
except requests.RequestException as exc:
    chembl_hits = []
    print("ChEMBL 不可用，降级为本地参考集相似性匹配:", exc)
```

## 参数建议
| 项目 | 建议 | 说明 |
|---|---|---|
| Morgan 半径/位数 | radius=2, 2048 bits | 等价 ECFP4；大库可用 1024 省内存 |
| 相似性阈值 | 0.7 严格 / 0.4–0.6 探索 | 骨架跃迁场景可低至 0.3 |
| Butina cutoff | 0.3–0.4（Tanimoto 距离） | 阈值越大簇越少，需报告 |
| Lipinski | 违规 ≤ 1 可接受 | 天然产物/PROTAC 例外需说明 |
| 库规模 | 指纹矩阵内存 | 100 万分子 × 2048 bit ≈ 256 MB，可分块 |
| 靶点预测阈值 | 相似性 ≥ 0.4 且 ≥ 3 个参考配体 | 低于此只作假设 |

## 常见陷阱
1. **不标准化直接去重**：同一分子不同盐型/互变异构/立体异构写法会被当成多条记录，导致重复计数。
2. **互变异构枚举爆炸**：`TautomerEnumerator` 对大分子可能产生大量变体，先限定额定数量或跳过。
3. **指纹版本混用**：库用 ECFP4、查询用 MACCS，相似性没有意义；全流程固定指纹类型与位数。
4. **在线接口当离线可用**：ChEMBL/PubChem 超时或限流时脚本会崩；必须 try/except 并给出降级说明。
5. **规则与靶点预测的过度解读**：口服药也有违反 Lipinski 的（天然产物、PROTAC），规则用于排序与提示；相似性命中只说明「结构相似」，不等于活性，报告必须写明证据强度与来源版本。
6. **数据泄漏与立体化学**：QSAR 随机划分会让同骨架分子同时进训练/测试集，应做骨架或时间划分；手性药物对映体活性可能完全不同，SMILES 丢失 `@` 会误导下游。

## 自检清单
- [ ] 解析失败率、去重前后数量、含盐比例已记录。
- [ ] canonical SMILES 为唯一键且重复已合并；指纹类型/位数/相似性阈值全流程一致。
- [ ] 类药性规则的违规项逐条列出，而非只给 pass/fail。
- [ ] 在线服务调用有超时、重试与降级路径，且记录数据源版本。
- [ ] 候选表每条记录能追溯到输入库行 ID；靶点/活性预测标注为「假设」，附参考配体数与相似性分布。

## 输出产物
- `results/library_standardized.csv`（canonical SMILES + 描述符 + 规则标记）
- `results/similarity_hits.csv`、`results/cluster_representatives.csv`
- `results/target_predictions.csv`（含来源与证据强度）
- `figures/library_representatives.png`、`figures/property_distributions.png`；`results/params.json`（RDKit 版本、指纹参数、规则阈值）
