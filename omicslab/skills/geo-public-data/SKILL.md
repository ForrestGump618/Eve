---
name: geo-public-data
description: "公共组学数据获取：GEO/SRA/ArrayExpress(BioStudies) 检索、下载策略、元数据解析、预处理判断、可复现清单与合规/速率限制。"
when_to_use: "需要从公共数据库找数据集、下载表达矩阵或元数据、解析 GEO series matrix、构建可复现下载清单、或判断公开数据能否复用时使用。"
version: "1.0"
---

# 公共组学数据获取（geo-public-data）

## 适用场景
- 按疾病/组织/平台检索 GEO 数据集，筛选适合复用的 series。
- 下载并解析 `series_matrix.txt.gz`、补充 counts、GPL 注释。
- 把公开数据与自有数据合并前的元数据对齐。
- 需要一份别人能照着复现的下载与校验清单。

## 前置检查
1. 确认数据是否公开可下载：GEO 的 `GSE` 若关联 dbGaP 受控访问，需要授权，不能绕过。
2. 确认目标数据层级：`series matrix`（已归一化，可能被作者处理过）vs 补充文件中的原始 counts（优先用于重分析）。
3. 确认平台注释：`GPL` 是否有对应基因注释表；老平台（如 Affymetrix HG-U133A）需要专门 CDF/注释包。
4. 网络与限流：NCBI 无 key 约 3 请求/秒，有 key 约 10 请求/秒；大批量下载前先小样本试。
5. 合规：不要批量抓取受控数据；不要重新分发含个人身份信息的原始数据；引用原始文献与 accession。

## 依赖与环境
`pip install GEOparse requests pandas`；GEOparse 不可用时用 `requests` 下载 `series_matrix.txt.gz` 自行解析，或用 `ffq`/`pysradb` 定位 SRA 文件。大规模 fastq 用 SRA Toolkit（`prefetch` + `fasterq-dump`），不要在 Python 里直接拉取测序原始文件。

## 步骤
1. **检索**：用 E-utilities 的 `esearch`（db=gds）按关键词、物种、平台、样本量过滤；再 `esummary` 取标题、样本数、平台、提交日期。
2. **筛选**：逐个看 series 的设计（分组、重复数、处理、时间点）、是否有原始 counts、是否有单细胞/空间；把候选与排除理由列成表。
3. **确认层级**：优先下载补充文件里的 `*_counts.txt.gz` / `*_raw_counts.csv`；只有 series matrix 时记录作者用的归一化与 log 变换，重分析时说明局限。
4. **下载**：`GEOparse.get_GEO(geo=..., destdir=...)` 取元数据与 matrix；补充文件用 `requests` 流式下载，带 `User-Agent`、超时、重试与断点续传。
5. **元数据解析**：`gse.metadata` 是「字段 → 值列表」；`gse.pivot_samples("VALUE")` 得到表达矩阵；样本 title 里的分组信息常需正则提取，提取结果要人工抽查。
6. **注释映射**：用 `gse.gpls` 中的平台表把探针映射到基因；一对多时选最大均值探针或取均值，规则固定。
7. **质检**：样本聚类/PCA 看离群；检查分组与批次是否共线；检查 counts 是否整数、是否有大量 0。
8. **可复现清单**：记录 accession、下载 URL、下载日期、文件 SHA256、文件大小、处理脚本版本、随机种子；清单落 `results/geo_manifest.json`。
9. **合规记录**：记录数据许可/使用条款、是否受控、引用文献；受控数据不得写入共享目录。

## 关键代码片段
```python
import hashlib
import json
import re
import time
from pathlib import Path

import pandas as pd
import requests

# 1) E-utilities 检索（NCBI：无 key 限 3 req/s）
BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"
params = {"db": "gds", "term": "((breast cancer[Title]) AND gse[Entry Type]) "
                        "AND Homo sapiens[Organism]",
          "retmax": 50, "retmode": "json", "tool": "omicslab", "email": "you@example.org"}
r = requests.get(f"{BASE}/esearch.fcgi", params=params, timeout=30)
ids = r.json()["esearchresult"]["idlist"]
time.sleep(0.4)
summary = requests.get(f"{BASE}/esummary.fcgi",
                       params={"db": "gds", "id": ",".join(ids), "retmode": "json"},
                       timeout=30).json()
rows = [{"uid": k, "accession": v.get("accession"), "title": v.get("title"),
         "n_samples": v.get("n_samples"), "platform": v.get("gpl")}
        for k, v in summary["result"].items() if k != "uids"]

# 2) GEOparse 读取 series（元数据 + matrix）
import GEOparse
gse = GEOparse.get_GEO(geo="GSE12345", destdir="data/geo", silent=True)
print(list(gse.metadata)[:20])
expr = gse.pivot_samples("VALUE")            # 探针 × 样本
pheno = gse.phenotype_data                    # 样本表型
if "characteristics_ch1" in pheno:
    pheno["group"] = pheno["characteristics_ch1"].str.extract(r"group:\s*(\w+)")

# 3) 流式下载 + SHA256 校验（补充文件）
def download(url, out_path, retries=3):
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    part = out_path.with_suffix(out_path.suffix + ".part")
    for attempt in range(retries):
        try:
            with requests.get(url, stream=True, timeout=120,
                              headers={"User-Agent": "omicslab/1.0"}) as resp:
                resp.raise_for_status()
                with open(part, "wb") as fh:
                    for chunk in resp.iter_content(1 << 20):
                        fh.write(chunk)
            part.replace(out_path)
            h = hashlib.sha256(out_path.read_bytes()).hexdigest()
            return {"path": str(out_path), "sha256": h, "bytes": out_path.stat().st_size}
        except requests.RequestException as exc:
            print(f"[retry {attempt + 1}] {url}: {exc}")
            time.sleep(2 ** attempt)
    raise RuntimeError(f"download failed: {url}")

# 4) 可复现清单
manifest = {"accession": "GSE12345", "download_date": "2025-01-01",
            "files": [], "notes": "processed counts from supplementary"}
with open("results/geo_manifest.json", "w", encoding="utf-8") as fh:
    json.dump(manifest, fh, ensure_ascii=False, indent=2)
```

## 参数建议
| 项目 | 建议 | 说明 |
|---|---|---|
| NCBI 速率 | 3 req/s（无 key）/ 10 req/s（有 key） | 用 `time.sleep(0.4)` 或 0.11 |
| 重试 | 3 次，指数退避 | 5xx/超时才重试，4xx 不重试 |
| 超时 | 连接 30 s、读取 120 s | 大文件用流式 |
| GSE 筛选 | 每组 ≥3 重复 | 单细胞数据看细胞数而非样本数 |
| 探针映射 | max mean 或 mean | 规则固定并写入方法 |
| 清单 | 每个文件 SHA256 | 复现的最小要求 |

## 常见陷阱
1. **series matrix 已被作者归一化**：直接拿来做差异分析会重复归一化或低估方差；优先找原始 counts。
2. **`pivot_samples("VALUE")` 列名是 GSM 而非样本名**：需要与 `pheno` 按 GSM 对齐，别按顺序硬拼。
3. **GPL 注释缺失或一对多**：不同注释版本会改变基因数，记录 GPL 与注释文件版本。
4. **样本 title 里的分组靠猜**：正则提取后必须人工抽查全部样本，尤其含「rep1/rep2」「control_treated」等混合词。
5. **批次与分组共线**：同一个 GSE 内不同批次处理不同组时，合并前先查 `pivot` 的提交信息。
6. **受控数据当公开下载**：dbGaP/EGA 受控数据需要授权，爬取或二次分发违规。
7. **限流被封**：高频请求会返回 429，脚本要处理并暂停，不要循环重试。
8. **未记录下载时间**：GEO 数据会更新，复现清单必须含日期与哈希。

## 自检清单
- [ ] 检索条件、命中数、筛选与排除理由已记录。
- [ ] 明确使用的是原始 counts 还是归一化 matrix，并写入方法。
- [ ] 元数据字段与分组提取经人工抽查，样本数对得上。
- [ ] 平台注释版本、探针映射规则已记录。
- [ ] 每个下载文件有 SHA256 与字节数，清单落盘。
- [ ] 数据许可/受控状态已确认，未违反使用条款。
- [ ] 原始文献 accession 与引用信息已保存。

## 输出产物
- `results/geo_candidates.csv`（候选 GSE 与筛选理由）
- `data/geo/<GSE>/`（matrix、supplementary、GPL 注释）
- `results/geo_manifest.json`（URL、日期、SHA256、脚本版本）
- `results/geo_pheno.csv`（对齐后的表型表）
- `figures/geo_pca.png`（合并前批次/离群检查）
