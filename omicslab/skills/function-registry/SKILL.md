---
name: function-registry
description: "用 registry_lookup 查询本项目可用函数/类的真实签名与文档，再在 Python 环境里验证可导入、试跑最小样例，避免凭记忆编造 API、参数或包版本。"
when_to_use: "写分析代码前不确定函数是否存在、参数名/默认值、返回类型；需要选包（scanpy/squidpy/statsmodels 等）；报错 ImportError/TypeError 需要定位正确用法时。"
version: "1.0"
---

# 函数注册表检索（function-registry）

## 何时用
- 要调用一个不熟的函数（如 `sc.pp.normalize_total`、`squidpy.gr.ligrec`、`statsmodels` 的混合模型）。
- 遇到 `ImportError / AttributeError / TypeError: unexpected keyword`。
- 需要写「某包某版本才有的参数」时，先确认版本。
- 给用户/其他 agent 提供 API 建议前，先核实签名。

## 工具契约
```text
registry_lookup(query, limit=8)
```
返回每条：`name / qualname / module / kind / signature / summary / package / package_version / docstring`。
- `query` 用英文关键词更稳（如 `normalize total counts`、`cox proportional hazards`、`permutation test`）。
- 默认覆盖 numpy/pandas/scipy/sklearn/statsmodels/matplotlib/seaborn/scanpy/anndata/omicverse/lifelines/gseapy/pydeseq2/flowio/flowkit/rdkit/squidpy/harmonypy/bio/plotly/networkx/umap/leidenalg。
- **注册表里有 ≠ 当前内核已安装**：后者必须在 `run_python_code` 里实际 import 验证。

## 标准流程
### 1. 检索
```text
registry_lookup("normalize total counts", limit=5)
registry_lookup("batch correction", limit=5)
registry_lookup("survival cox", limit=5)
```
看 `signature` 确认：参数名、默认值、位置参数顺序；看 `package_version` 确认版本。

### 2. 在当前环境验证可导入
```python
import importlib, importlib.metadata as md

def check_import(module: str):
    try:
        mod = importlib.import_module(module)
        ver = None
        try: ver = md.version(module.split(".")[0])
        except md.PackageNotFoundError: pass
        return {"module": module, "ok": True, "version": ver, "file": getattr(mod, "__file__", None)}
    except Exception as e:
        return {"module": module, "ok": False, "error": f"{type(e).__name__}: {e}"}

for m in ["numpy", "pandas", "scipy", "scanpy", "statsmodels", "sklearn", "lifelines"]:
    print(check_import(m))
```
> 返回 `ok=False` 时不要假装能跑：改用 numpy/pandas 实现、或告知用户需安装依赖；不要在执行代码里硬 import 后崩掉。

### 3. 小样例试跑（最小代价验证）
```python
import inspect
def probe(obj, name):
    try:
        sig = str(inspect.signature(obj))
    except (TypeError, ValueError):
        sig = "<no signature>"
    print(f"{name}{sig}")
    doc = (inspect.getdoc(obj) or "").splitlines()
    print("  doc:", doc[0] if doc else "<no doc>")

import numpy as np
probe(np.mean, "np.mean")
# 试跑最小输入，确认返回结构与 dtype
out = np.mean(np.array([[1.0, 2.0], [3.0, 4.0]]), axis=0, keepdims=True)
print("shape=", out.shape, "dtype=", out.dtype)
```

### 4. 记录到分析日志
```python
import json, pathlib, platform
log = {"python": platform.python_version(), "platform": platform.platform(),
       "checked": ["numpy", "pandas"], "note": "registry_lookup 的 signature 与本地实际一致"}
pathlib.Path("results").mkdir(exist_ok=True)
pathlib.Path("results/api_provenance.json").write_text(json.dumps(log, ensure_ascii=False, indent=2))
print("saved")
```

## 常见检索场景与建议
| 需求 | 推荐 query | 备选 |
|---|---|---|
| 归一化/标准化 | `normalize total counts` / `scale data` | 手写 numpy 实现 |
| 差异表达 | `differential expression test` | Welch t / 置换检验 |
| 批次校正 | `batch correction combat` | harmonypy / 分层分析 |
| 生存分析 | `cox proportional hazards` | Kaplan-Meier + log-rank |
| 多重检验 | `multipletests fdr` | 本 skill 的 BH 实现 |
| 轨迹推断 | `trajectory inference` | 只做相关性/排序 |
| 细胞通讯 | `ligand receptor` | 表达相关性替代 |
| 空间邻域 | `spatial neighbors` | KD-tree（scipy） |

## 检查清单
- [ ] 每个不确定的函数都先 `registry_lookup`，没有凭记忆写参数。
- [ ] 关键包已在当前内核 import 验证，版本已记录。
- [ ] 参数名、默认值、返回类型与 signature 一致。
- [ ] 最小样例跑通后再放进正式分析。
- [ ] 版本敏感参数（如 `copy=`、`inplace=`、`n_jobs=`）在代码里显式写出。
- [ ] 缺失依赖有降级方案，并在结论/日志中标注。
- [ ] API 来源（registry 的 qualname/版本）写入可复现清单。

## 常见陷阱
1. **把注册表当已安装**：查到 scanpy 不代表当前 venv 能 import；必须实测。
2. **凭记忆写参数**：`normalize_total(target_sum=)` 与旧版 `counts_per_cell=` 不同；以 signature 为准。
3. **跨版本 API 漂移**：教程写的是旧版；用 `package_version` 对齐。
4. **同名函数混淆**：`sklearn` 与 `scipy` 都有 `scale`，模块前缀要写全。
5. **返回类型假设错误**：inplace 操作返回 None；链式调用前先确认。
6. **静默失败**：`try/except` 吞掉 ImportError 后用备用实现，但报告里没写降级。
7. **位置参数顺序**：不同版本位置参数可能变；优先关键字参数。
8. **在子进程/远程环境假设相同包**：远程需重新验证（见 `remote-compute-ssh`）。

## 验证方法
- **签名比对**：`registry_lookup` 的 signature 与 `inspect.signature()` 一致。
- **最小样例**：小数组/小 DataFrame 跑通，检查 shape/dtype/索引。
- **版本锁定**：同版本重跑结果一致；升级后重跑关键片段。
- **负向测试**：传错参数应抛出清晰 TypeError，而不是静默改变结果。
- **依赖审计**：`importlib.metadata.version` 输出写入 provenance。

## 交接
- 需要领域分析流程 → 对应 skill（如 `single-cell-upstream`、`differential-expression`）。
- 需要远程环境验证 → `remote-compute-ssh`；统计实现 → `statistical-rigor`。
