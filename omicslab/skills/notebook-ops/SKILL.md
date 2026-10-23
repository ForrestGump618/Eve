---
name: notebook-ops
description: "Notebook 运行时管理：共享 IPython 内核状态、重启与恢复、变量清理、大内存数据处理、导出 ipynb 与环境快照。"
when_to_use: "需要管理跨轮复用的内核变量、分析中途重启恢复、释放内存、把交互分析固化成交付 notebook、记录可复现环境时使用。"
version: "1.0"
---

# Notebook 运行时管理（notebook-ops）

## 适用场景
- 分析跨多轮对话，需要复用已加载的 AnnData / DataFrame，不必重复读盘。
- 内核崩溃或重启后，快速恢复到上次状态。
- 大对象占内存，需要清理、序列化或换 Parquet/AnnData 落盘。
- 交付时把交互过程整理成可重跑的 `.ipynb`。

## 前置检查
1. 确认内核可用：`import sys; sys.executable` 指向预期解释器；包版本与 `pyproject` 一致。
2. 确认工作目录：`import os; os.getcwd()`；相对路径全部基于项目根。
3. 确认可用内存：`psutil.virtual_memory()` 或 `resource`；单细胞数据 10 万细胞约需数 GB。
4. 确认数据已落盘：重跑靠脚本 + 数据文件，而不是靠「内存里还有」。
5. 确认随机种子与参数集中存放，重启后能复现。

## 步骤
1. **开工**：先 `%who_ls` 看已有变量，避免重复定义/覆盖；读取是幂等的，计算不是。
2. **命名规范**：`adata_raw`（原始）、`adata_qc`、`adata`（最终）、`de_<对比>`、`fig_<主题>`；禁止 `df1/df2` 满天飞。
3. **大对象落盘**：AnnData 用 `.h5ad`，表用 `.parquet`，中间结果加 `_v<N>` 版本；内存里只留当前需要的一层。
4. **重启恢复**：写一小段「恢复块」放在 notebook 顶部，按顺序读 `data/` 与 `results/` 的缓存；恢复后用断言校验形状与关键列。
5. **清理**：`del` 不再用的大对象 → `gc.collect()`；清理前后用 `psutil` 记录 RSS 变化。
6. **固定随机性**：`np.random.seed(...)`、annData 的 `random_state=`、sklearn 的 `random_state=` 全流程一致。
7. **导出**：用 `jupyter nbconvert --to html`（展示）与 `--to notebook --execute`（验证可重跑）；导出前跑 `nbconvert --to notebook --execute` 确认无隐藏状态依赖。
8. **环境快照**：记录 `sys.version`、关键包版本、git commit（若有）、平台信息到 `results/env_snapshot.json`。

## 关键代码片段
```python
import gc
import json
import platform
import sys
from pathlib import Path

import psutil

# 1) 查看当前内核变量（避免重复定义）
ip = get_ipython()          # 仅在 IPython/Jupyter 内核中可用
print("top-level variables:", sorted(ip.user_ns.keys() - {"_", "__", "___"}))
print("python:", sys.executable)

# 2) 内存快照与清理
def rss_gb():
    return psutil.Process().memory_info().rss / 1e9

print(f"RSS before: {rss_gb():.2f} GB")
del adata_qc
gc.collect()
print(f"RSS after:  {rss_gb():.2f} GB")

# 3) 大对象落盘（AnnData / DataFrame）
adata.write_h5ad("results/adata_final.h5ad", compression="gzip")
df.to_parquet("results/de_table.parquet", index=False)

# 4) 重启恢复块（放在 notebook 顶部，幂等）
import anndata as ad
import pandas as pd

adata = ad.read_h5ad("results/adata_final.h5ad")
df = pd.read_parquet("results/de_table.parquet")
assert adata.shape[0] > 0, "AnnData 为空，检查上游路径"
assert {"log2FoldChange", "padj"} <= set(df.columns), "DE 表列缺失"

# 5) 环境快照
from importlib.metadata import version
pkgs = ["anndata", "scanpy", "pandas", "numpy", "matplotlib", "flowkit", "pydeseq2"]
snapshot = {"python": sys.version.split()[0], "platform": platform.platform(),
            "packages": {}}
for p in pkgs:
    try:
        snapshot["packages"][p] = version(p)
    except Exception:
        snapshot["packages"][p] = None
Path("results/env_snapshot.json").write_text(
    json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")

# 6) 导出（命令行，不在内核里跑）
#   jupyter nbconvert --to notebook --execute --inplace analysis/report.ipynb
#   jupyter nbconvert --to html analysis/report.ipynb --output-dir results/
```

## 参数建议
| 项目 | 建议 | 说明 |
|---|---|---|
| 缓存格式 | `.h5ad` / `.parquet` / `.pkl` | 文本 CSV 只用于小结果 |
| 压缩 | h5ad `gzip` | 体积约减半，速度略慢 |
| 恢复校验 | shape + 关键列断言 | 防读到旧版本缓存 |
| 清理时机 | 每完成一个阶段 | 别等到 OOM |
| 随机种子 | 42（或项目约定） | 写进 params.json |
| 导出 | 先 execute 再 html | 保证无隐藏状态 |

## 常见陷阱
1. **隐藏状态**：单元格乱序执行后，`--execute` 会失败或得到不同结果；导出前必须全量重跑。
2. **覆盖原始数据**：`adata = adata[...]` 后原始对象丢了；先 `adata_raw = adata.copy()`。
3. **重启后路径错**：内核 cwd 与 notebook 所在目录可能不同，统一用项目根相对路径。
4. **pickle 跨版本失效**：sklearn/anndata 升级后 pickle 可能读不了；优先 h5ad/parquet。
5. **忘了删临时大对象**：循环里反复创建 AnnData 会累积；每轮 `del` + `gc.collect()`。
6. **内存估算过低**：稀疏矩阵转稠密会让内存爆 10 倍以上；保持 `sparse=True`。
7. **环境快照不全**：只记 Python 版本不够，关键包版本与 git commit 都要记。
8. **notebook 输出过大**：嵌入大图/大表会让 ipynb 膨胀到几十 MB；导出前清空输出或压缩图。

## 自检清单
- [ ] 顶部有幂等恢复块，重启后可一键恢复。
- [ ] 大对象已落盘，变量名规范，原始数据未被覆盖。
- [ ] 关键中间结果有版本/校验（shape、列名、hash）。
- [ ] 随机种子与参数在 `params.json` 中。
- [ ] notebook 全量重跑通过（`nbconvert --execute`）。
- [ ] `results/env_snapshot.json` 记录了 Python 与关键包版本。
- [ ] 导出文件大小合理（输出已清理/压缩）。

## 输出产物
- `analysis/*.ipynb`（可重跑的交付 notebook）
- `results/adata_final.h5ad`、`results/*.parquet`（恢复用缓存）
- `results/env_snapshot.json`（环境快照）
- `results/notebook_execution.log`（全量重跑日志）
- `results/` 下导出的 HTML 报告
