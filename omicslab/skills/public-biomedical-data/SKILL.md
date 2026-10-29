---
name: public-biomedical-data
description: "公共生物医学多组学数据的 Collector → Evaluator → Curator 流水线：检索与元数据采集、可解释质量评分、统一字段与 provenance 整理。"
when_to_use: "许愿式科研的资源侦察、公开数据复用、多组学数据候选筛选、补充材料下载、metadata 标准化，或需要在分析前建立可复现数据清单时使用。"
version: "1.0"
---

# 公共生物医学数据获取

把公开数据获取拆成三个可审计阶段。不要跳过评估直接下载，也不要把“找到 accession”写成“已获得数据”。

## Collector · 采集

- 支持 GEO、ArrayExpress/BioStudies、SRA、EGA/dbGaP 元数据、PRIDE、ProteomeXchange、MetaboLights、CELLxGENE、UCSC Cell Browser、Human Protein Atlas、GTEx、TCGA/GDC、LINCS 和文献补充材料等来源。
- 先记录 accession、来源、URL、物种、组织、疾病、平台、样本数、数据类型、版本和许可。
- 受控访问数据只登记 `controlled` 与申请入口，不尝试绕过授权或批量抓取。
- 默认只采集元数据；只有用户或当前任务明确允许联网、来源公开可下载且文件在预算内时才加 `--download`。
- 下载必须保留原 URL、最终 URL、抓取时间、字节数、SHA256、Content-Type 和失败原因。

运行：

```powershell
python scripts/pipeline.py --plan public-data-plan.json --out data/public
```

需要真实下载时：

```powershell
python scripts/pipeline.py --plan public-data-plan.json --out data/public --download
```

## Evaluator · 评估

评分是透明启发式，不是科学真值。至少检查：

1. 许可与访问级别是否允许当前用途。
2. 是否有原始/处理后数据层级说明。
3. 样本量、重复和元数据字段是否足够。
4. 数据类型是否匹配研究问题，是否存在批次、版本或平台偏倚。
5. URL、accession 和下载资产能否核验。

评分项、扣分项和缺失字段全部写入 `evaluation.json`。低于阈值的数据不进入主分析，但保留在候选中并写明排除理由。

## Curator · 整理

- 统一字段：`candidate_id`、`source`、`accession`、`title`、`species`、`tissue`、`disease`、`platform`、`data_level`、`sample_count`、`license`、`access`、`url`、`version`、`metadata`、`files`、`provenance`。
- 不覆盖原始 metadata；标准化值放入 `curated`，冲突字段保留在 `conflicts`。
- 文件哈希必须与下载清单一致；metadata-only 候选明确标记 `download_state: metadata_only`。
- `raw_record` 保留 Collector 读到的原始字段，`curated` 只承载标准化视图。
- 输出 `manifest.json` 作为后续证据矩阵和预注册的唯一数据入口。

## 输出目录

```text
data/public/
  candidates.json
  evaluation.json
  curated.json
  manifest.json
  provenance.json
  files/
```

## 边界

- 受控、需登录、需数据使用协议、可能含个人身份信息的数据不得自动下载或重新分发。
- 取得公开数据不等于取得分析许可；许可以来源条款为准。
- 质量分数不能替代人工检查、统计设计或科学验证。
- 不在脚本中保存 API key；需要凭据时由运行环境注入。
