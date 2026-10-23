# 内置技能库（SKILLS）

技能（Skill）是 OmicsLab 的「按需操作手册」。默认只把技能目录（`name + description + when_to_use`）注入模型上下文；当模型判断需要时，才用 `skill_view` 读取完整正文与附带脚本。因此技能可以写得很详细，而不会挤占日常对话的上下文。

> **状态说明**：本页的每个技能对应 `omicslab/skills/<name>/SKILL.md`。用途描述已与技能的 frontmatter（`name` / `description` / `when_to_use`）核对；若后续正文调整，请以各 `SKILL.md` 为最终事实来源。

## 1. 技能总览

| 技能 | 领域 | 一句话用途 | 典型触发 |
|---|---|---|---|
| [`single-cell-upstream`](#21-single-cell-upstream) | 单细胞 | 从原始矩阵到聚类 UMAP 的上游流程 | 拿到 h5ad / 10x 矩阵，要做 QC、整合、聚类 |
| [`single-cell-downstream`](#22-single-cell-downstream) | 单细胞 | 聚类之后：注释、差异、富集、轨迹、通讯 | 已有 leiden 聚类，要解释细胞类型与差异 |
| [`spatial-transcriptomics`](#23-spatial-transcriptomics) | 空间组学 | Visium / Xenium / MERFISH 的空间分析 | 空间数据要做域划分、SVG、解卷积、邻域 |
| [`flow-cytometry`](#24-flow-cytometry) | 流式细胞术 | FCS 解析、补偿、门控、频率与 MFI | 免疫表型、细胞亚群比例、panel 质控 |
| [`bulk-transcriptomics`](#25-bulk-transcriptomics) | 转录组 | bulk RNA-seq 差异表达与通路分析 | 计数矩阵 → DE → 富集，或批次校正 |
| [`cadd-cheminformatics`](#26-cadd-cheminformatics) | 化学信息学 | 分子描述符、相似性、类药性筛选 | 处理 SMILES / SDF，做虚拟筛选前的性质过滤 |
| [`geo-public-data`](#27-geo-public-data) | 公共数据 | 检索、解析、整理 GEO 公共数据集 | 复现公共数据集、整理 metadata、批次信息 |
| [`figure-style`](#28-figure-style) | 可视化 | 出版级图表风格与配色、多面板排版 | 要把分析图整理成论文图 / 汇报图 |
| [`report-writing`](#29-report-writing) | 写作 | 把分析结果组织成结构化报告 | 分析收尾、出周报 / 结题报告 / 方法学描述 |
| [`notebook-ops`](#210-notebook-ops) | 工程 | 内核与 notebook 的运维、导出、可复现性 | 导出 ipynb、清理变量、检查可复现性 |
| [`rsi-discovery-loop`](#211-rsi-discovery-loop) | 科研发现 | RSI 闭环完整 playbook：观察→假设→预注册→执行→证据分级→反思 | 端到端科研发现、建 discovery 项目、多轮检验 |
| [`hypothesis-generation`](#212-hypothesis-generation) | 科研发现 | 把观察/文献转成可证伪、有机制、有预测的假设卡 | 想法模糊、需要产出可写进账本的假设 |
| [`experimental-design`](#213-experimental-design) | 科研发现 | 预注册实验/观察方案：对照、随机化、样本量、分析计划 | 假设已明确、准备投入真实样本或算力 |
| [`statistical-rigor`](#214-statistical-rigor) | 统计 | 检验选择、效应量与 CI、多重校正、置换检验 | 要写进报告的任何统计结论；审阅显著性声明 |
| [`causal-inference`](#215-causal-inference) | 统计 | 从观察数据谨慎逼近因果：DAG、调整集、敏感性分析 | 结论用「导致/影响」措辞、决定调整哪些协变量 |
| [`remote-compute-ssh`](#216-remote-compute-ssh) | 工程 | 通过 SSH profile 用远程算力：传数据、提交长任务、取回结果 | 任务超出本机算力，数据已在远程服务器 |
| [`function-registry`](#217-function-registry) | 工程 | 用 `registry_lookup` 查真实签名再写代码 | 不确定 API/参数、遇到 ImportError/TypeError |
| [`vision-interpretation`](#218-vision-interpretation) | 可视化 | 用 `analyze_image` 解读图表、显微图、门控图等 | 需要理解用户给的图、报告前检查图是否被误读 |

**技能与专职 Agent 的搭配**

| Agent | 常配合的技能 |
|---|---|
| `lead` | 全部（按需调度） |
| `single-cell-analyst` | `single-cell-upstream`、`single-cell-downstream`、`figure-style` |
| `spatial-analyst` | `spatial-transcriptomics`、`single-cell-upstream`、`figure-style` |
| `flow-cytometrist` | `flow-cytometry`、`figure-style` |
| `figure-designer` | `figure-style` |
| `report-writer` | `report-writing`、`notebook-ops` |
| `data-critic` | `notebook-ops`、`bulk-transcriptomics`（审阅统计假设） |
| `discovery-lead` | `rsi-discovery-loop`、`hypothesis-generation`、`experimental-design`、`statistical-rigor` |
| `hypothesis-smith` | `hypothesis-generation`、`rsi-discovery-loop` |
| `experiment-designer` | `experimental-design`、`statistical-rigor`、`causal-inference` |
| `evidence-critic` | `statistical-rigor`、`causal-inference` |
| `research-strategist` | `rsi-discovery-loop`、`hypothesis-generation` |
| `remote-compute-engineer` | `remote-compute-ssh`、`function-registry` |

## 2. 技能详情

### 2.1 `single-cell-upstream`

**用途**：单细胞上游标准流程 —— 读取 10x / h5ad，计算 QC 指标并过滤，双细胞检测，归一化与对数变换，高变基因选择，PCA，批次整合，邻接图与聚类，UMAP 可视化。它会先确认数据形态（物种、基因命名、是否已归一化），再决定走哪条分支。
**何时触发**：用户第一次加载单细胞数据；提到 QC、过滤、归一化、`scanpy`、`sc.pp.*`、整合（Harmony / scVI / BBKNN）、聚类与 UMAP；或上传了 `.h5ad` / `matrix.mtx` / `barcodes.tsv`。

**产出检查**：QC 前后细胞数对比、过滤比例告警、聚类分辨率选择理由、UMAP 图。

### 2.2 `single-cell-downstream`

**用途**：聚类之后的下游分析 —— 候选标记基因、细胞类型注释（手动标记 + 参考图谱映射）、组间差异表达、GO / KEGG / GSEA 富集、拟时序轨迹、细胞–细胞通讯。强调「注释要给出依据与置信度」，而不是直接抛出一个类型名。
**何时触发**：已有 `leiden` / `louvain` 聚类；用户问「这些 cluster 是什么细胞」「两组差异基因」「做富集」「拟时序」「cellphonedb / cellchat」等。

**产出检查**：每个 cluster 的 top markers 表、注释依据、差异基因阈值（logFC / p-adj）与多重检验校正说明。

### 2.3 `spatial-transcriptomics`

**用途**：空间转录组的完整分析链 —— 读取 Visium / Xenium / MERFISH / CosMx 数据，空间坐标与图像对齐（如有），空间高变基因（SVG），空间域划分（如 SpaGCN / 聚类 + 空间平滑），细胞类型解卷积（Visium），邻域富集与细胞–细胞空间邻近分析。会明确区分「表达聚类」与「空间域」两个概念。
**何时触发**：数据带空间坐标或组织图像；提到 Visium、Xenium、MERFISH、空间域、SVG、解卷积、邻域、空间通讯。

**产出检查**：空间坐标图、域划分图、SVG 列表、解卷积比例图；稀疏切片会提示统计功效限制。

### 2.4 `flow-cytometry`

**用途**：流式细胞术数据分析 —— 解析 FCS 2.0/3.0/3.1 的元数据与通道，应用补偿矩阵，logicle / arcsinh 变换，按层级（如 CD45/SSC → 亚群）建立门控，输出各群体频率与 MFI，并支持批量处理多个采集文件与导出 GatingML。
**何时触发**：上传 `.fcs` 文件；提到门控、补偿、CD45/SSC、免疫表型、MFI、FlowJo、FlowKit、panel 质控。

**产出检查**：补偿前后对比、门控树与每级比例（注意分母定义）、双峰/溢出通道告警。

### 2.5 `bulk-transcriptomics`

**用途**：bulk RNA-seq 与芯片数据的差异表达与功能分析 —— 读取计数矩阵或表达矩阵，样本分组与协变量检查，归一化（CPM/TPM/VST），差异表达（如 PyDESeq2 / limma 风格），批次校正，火山图 / 热图，GO / KEGG / GSEA 富集。会在样本量不足时明确拒绝过度解读。
**何时触发**：表达矩阵 + 分组表；提到差异表达、DESeq2、limma、FPKM/TPM、富集分析、批次效应。

**产出检查**：样本 PCA / 聚类离群检查、设计公式、差异基因数与阈值、富集结果的可视化。

### 2.6 `cadd-cheminformatics`

**用途**：计算机辅助药物设计与化学信息学 —— SMILES / SDF 解析，分子描述符与指纹计算，相似性检索与聚类，子结构筛选，类药性规则（Lipinski / Veber），ADMET 性质预测前的特征准备。强调结果只用于计算辅助，不构成实验结论。
**何时触发**：上传 `.smi` / `.sdf` / `.csv`（含 SMILES）；提到 RDKit、分子描述符、指纹、Tanimoto、虚拟筛选、类药性。

**产出检查**：去重与标准化（互变异构/电荷）、描述符缺失处理、筛选阈值与命中数量。

### 2.7 `geo-public-data`

**用途**：GEO 公共数据的检索与整理 —— 解析系列（GSE）元数据、下载并读取 series matrix / supplementary 文件、把样本注释整理成可用于分析的 metadata 表、识别批次与平台信息。会先核对数据的许可与引用要求，并记录数据版本，保证可复现。
**何时触发**：用户给出 GSE 编号或要复现某篇公开数据；提到 GEO、series matrix、样本注释、批次信息整理。

**产出检查**：数据来源与访问日期、样本数与分组还原、缺失/歧义注释清单。

### 2.8 `figure-style`

**用途**：出版级图表规范 —— 统一字体、字号、线宽、配色（色盲友好），多面板布局与对齐，导出矢量（PDF/SVG）与高分辨率 PNG，并给出图注模板。不会为了好看而改变统计含义（如截断坐标轴需明确标注）。
**何时触发**：用户要把图用于论文 / 汇报；提到配色、字体、面板、PDF 导出、figure legend、图表美化。

**产出检查**：输出尺寸与 DPI、字体嵌入、颜色可读性、坐标轴是否被截断。

### 2.9 `report-writing`

**用途**：把一次分析组织成结构化报告 —— 摘要、数据与方法、结果（按分析步骤）、图与图注、局限性与下一步建议；根据目标读者（自己 / 课题组 / 审稿人）调整详略，并把代码与参数作为附录保留。
**何时触发**：分析收尾；用户说「写个报告 / 周报 / 结题 / 方法学段落 / 帮我总结这次分析」；或要求导出 Markdown / HTML 报告。

**产出检查**：每个结论都有对应图表或统计量；方法与参数可追溯；局限性不是套话而是具体到数据。

### 2.10 `notebook-ops`

**用途**：内核与 notebook 的日常运维 —— 把共享内核中已完成的代码导出为 `.ipynb`，重启/中断内核，检查变量占用与内存，清理临时对象，整理可复现的分析脚本。它关注「下次还能跑通」，而不只是「这次跑出来了」。
**何时触发**：导出 notebook、内核卡住/需要重启、变量列表混乱、内存紧张、要整理可复现脚本、或 `export_notebook` 工具被调用。

**产出检查**：导出文件的执行顺序、依赖导入是否齐全、是否有隐藏状态（变量来自更早的会话）。

### 2.11 `rsi-discovery-loop`

**用途**：RSI（Research Science Intelligence）科研发现闭环的完整操作手册 —— 观察数据/历史/文献，提出可证伪假设，排序并用 UCB1 策略选择，预注册检验方案，真实执行代码，按效应量/多重校正/置换检验/样本量与混杂分级证据，最后反思并演化策略库。它要求每轮都留下可审查的账本记录，而不是只给结论。
**何时触发**：用户只给目标/数据/领域而未给假设；要建立 discovery 项目、做多轮检验；或审计某条结论是否达到 `strong` 证据标准。

**产出检查**：每轮是否有明确假设与预注册判据、证据是否分级、失败轮是否触发策略调整、报告能否只靠账本复现。

### 2.12 `hypothesis-generation`

**用途**：把观察、文献线索与历史洞察转化为可证伪假设 —— 五要素假设卡（机制、预测、判据、对照、证伪路径）、预测操作化、竞争假设对照、Jaccard 去重与可检验性校验，产出可直接写入 discovery 账本的假设。
**何时触发**：已有数据观察或文献线索但还没有明确假设；需要把模糊想法改写成可检验陈述；或审查一组假设是否值得投入一轮实验。

**产出检查**：每条假设是否有机制解释与可证伪预测；判据是否可量化；是否写入了竞争假设与去重依据。

### 2.13 `experimental-design`

**用途**：为可检验假设设计预注册实验/观察验证方案 —— 对照与随机化、区组与批次平衡、样本量与功效、混杂控制、主要终点与分析计划，产出执行前冻结的设计卡。
**何时触发**：假设已明确、准备投入真实样本/批次/算力前；需要判断现有数据能否回答该问题；或要为已有队列设计验证性分析。

**产出检查**：主要终点与分析计划是否预注册；样本量/功效是否有依据；混杂与批次是否被显式控制；停止规则是否写明。

### 2.14 `statistical-rigor`

**用途**：统计严谨性检查与实施 —— 检验选择与前提检查、效应量与 95% CI、多重比较校正（BH/Holm）、置换检验与 bootstrap、样本量/功效与常见统计伪影（p-hacking、选择性报告、伪重复），确保结论可复现。
**何时触发**：任何要写进报告/证据账本的统计结论；审阅他人的 p 值/显著性声明；需要选检验、做多重校正、算效应量或解释 CI 时。

**产出检查**：检验前提是否核对；是否报告效应量与 CI 而非只报 p；多重比较是否校正；样本量与独立性是否交代。

### 2.15 `causal-inference`

**用途**：从观察数据谨慎逼近因果 —— 明确因果问题与估计目标，用 DAG 选择调整集（后门准则），识别混杂/选择/中介，选用准实验设计与敏感性分析（E-value、负对照、安慰剂），避免把相关写成因果。
**何时触发**：用户用「导致/影响/疗效」等因果措辞描述观察数据结论；需要决定调整哪些协变量；评估某关联能否作为干预依据；或设计观察性验证时。

**产出检查**：是否给出 DAG 与调整集理由；是否列出未测量的混杂及其方向；敏感性分析是否支持结论稳健性。

### 2.16 `remote-compute-ssh`

**用途**：通过已配置的 SSH profile 安全使用远程算力 —— 先勘察环境（CPU/GPU/内存/调度器），再传输数据与脚本，提交长任务（tmux/nohup/Slurm），轮询状态并取回结果；覆盖审批、完整性校验、超时与命令注入防护。
**何时触发**：任务超出本机算力（GPU、大内存、集群队列），或数据已在远程服务器；需要上传数据/脚本、运行长任务、再取回小体积结果时。

**产出检查**：是否先做 `ssh_remote_info` 勘察；远端路径与本地产物是否一致；长任务是否用 tmux/Slurm 脱离会话；是否记录了如何复跑。

### 2.17 `function-registry`

**用途**：用 `registry_lookup` 查询本项目可用函数/类的真实签名与文档，再在 Python 环境里验证可导入、试跑最小样例；避免凭记忆编造 API、参数或包版本。
**何时触发**：写分析代码前不确定函数是否存在、参数名/默认值、返回类型；需要选包（scanpy/squidpy/statsmodels 等）；遇到 ImportError/TypeError 需要定位正确用法时。

**产出检查**：是否先 lookup 再写代码；示例是否真实跑通；版本与包名是否与索引一致。

### 2.18 `vision-interpretation`

**用途**：用 `analyze_image` 解读科研图像（UMAP/热图/空间图/显微图/门控图/统计图/界面截图），配合数值重算与图像质检，把读图结果当作观察线索而非定量结论。
**何时触发**：需要理解用户提供的图片或自己生成的图；报告前检查图是否被误读；需要从显微/空间/流式图中提取定性观察；或审阅图表是否夸大/误导时。

**产出检查**：是否区分「图上看到」与「数值算出」；是否核对坐标轴/图例/色标；结论是否声明了读图的不确定性。

## 3. 使用与覆盖

### 3.1 在对话里使用

模型会自己调用：

```text
skill_list()                      # 列出技能目录（name / description / when_to_use）
skill_view("single-cell-upstream") # 读取正文与附带脚本列表
```

你也可以直接说：「用 `flow-cytometry` 技能处理 data/fcs/ 下的文件」。

### 3.2 查看技能

- Web 界面：侧栏 **技能库** → 列表 → 点开查看正文；
- REST：`GET /api/skills`、`GET /api/skills/{name}`（见 [API.md](API.md)）；
- 直接看文件：`omicslab/skills/<name>/SKILL.md`。

### 3.3 覆盖或新增

技能根目录按**先者胜**顺序加载：

```text
$OMICSLAB_SKILL_ROOTS  →  omicslab/skills  →  <workspace>/skills
```

- **覆盖内置技能**：把同名目录放到 `$OMICSLAB_SKILL_ROOTS` 指向的位置；
- **新增技能**：放进工作区 `skills/` 下即可，无需重启（下次加载时生效）。

写法与 frontmatter 规范见 [EXTENDING.md §2](EXTENDING.md#2-自定义-skill)。

### 3.4 自检

```bash
pytest tests/test_skills.py -q
```

校验点：`SKILL.md` 存在且 frontmatter 可解析；`name` / `description` / `when_to_use` 非空；`name` 与目录名一致。技能目录尚未生成时测试会 `skip` 并给出原因。
