# 示例数据（OmicsLab demo data）

本目录存放**小而完整、可被真实库直接读取**的示例数据，用于让智能体与技能包的代码片段开箱可跑，
并作为单元测试/端到端演示的固定输入。所有文件均为本仓库自研生成，不含真实受试者数据。

## 文件清单

| 文件 | 内容 | 主要用途 |
|---|---|---|
| `demo_counts.csv` | 10 基因 × 8 样本的整数 counts（行=基因，列=`gene,S1..S8`） | bulk 转录组差异表达、TPM/FPKM 换算、富集演示 |
| `demo_metadata.csv` | 8 行样本元数据：`sample_id,group,batch,sex,age,rin` | 设计矩阵、批次校正（ComBat/limma）、生存分析前置 |
| `make_demo_fcs.py` | 用 `flowio.create_fcs` 生成 `demo.fcs` 的脚本（可复现） | 生成流式样本、验证读取/补偿/门控链路 |
| `demo.fcs` | FCS 3.1，6000 事件 × 5 通道，含 `$SPILLOVER` | 流式技能包的门控与补偿示例 |
| `demo.provenance.txt` | `demo.fcs` 的生成参数（种子、事件数、通道、矩阵） | 复现与差异排查 |

## demo_counts.csv 的设计

- 基因：`CD3D, LYZ, NKG7, MS4A1, COL1A1, EPCAM, PECAM1, ACTB, GAPDH, MALAT1`。
- 分组：`S1–S4` = control，`S5–S8` = treated；处理效应写在中位数 2–4 倍量级，便于 DESeq2 出显著结果：
  - 上升：`CD3D, LYZ, NKG7, COL1A1`；下降：`MS4A1`；
  - 稳定（阴性对照）：`EPCAM, PECAM1, ACTB, GAPDH, MALAT1`。
- 批次与分组**正交**：`B1={S1,S2,S5,S6}`、`B2={S3,S4,S7,S8}`。
  - 这样可以演示 `~batch + group` 设计矩阵：批次可控但不会与处理完全混杂（避免"批次=分组"的估计不可辨识问题）。
- 数值范围 ~40–9000，足以让 `pydeseq2` 的 `DeseqDataSet` 正常估计 size factor 与离散度。

## demo_metadata.csv 的字段

| 列 | 类型 | 说明 |
|---|---|---|
| `sample_id` | str | 与 counts 列名一致 |
| `group` | str | `control` / `treated` |
| `batch` | str | `B1` / `B2` |
| `sex` | str | `F` / `M` |
| `age` | int | 年龄（用于协变量演示） |
| `rin` | float | RNA 完整度（用于 QC 协变量演示） |

## demo.fcs 的设计

- 采集通道（PnN）：`FSC-A, SSC-A, FL1-A, FL2-A, FL3-A`；标记（PnS）：`FSC-A, SSC-A, CD3, CD19, CD14`。
- 群体构成：淋巴细胞 ~45%（其中 CD3+ T 细胞 60%、其余主要 CD19+ B 细胞），单核细胞 ~22%（CD14 bright），粒细胞 ~33%（SSC 高）。
- 内置三角补偿矩阵（`$SPILLOVER`，observed=true），用于演示 `apply_compensation` 与"过/欠补偿"检查。
- 生成：

```bash
python make_demo_fcs.py --out demo.fcs --events 6000 --seed 2025
```

  依赖：`pip install flowio`（仅生成用；读取 demo.fcs 还需要 `flowkit`）。

## 复现与口径

- `demo.fcs` 为 FCS 3.1、`$DATATYPE=F`、小端 float32；通道名与矩阵一起写入，重命名通道会破坏补偿语义。
- 已用 flowkit 1.3.2 验证的参考结果（供回归比对，不要当生物学结论）：
  - 淋巴细胞门（FSC 0.10–0.17、SSC 0–0.07，xform 坐标）≈ 2674 事件（44.6%）；
  - CD3+ 占淋巴细胞 ≈ 60.5%，占总事件 ≈ 27.0%；
  - 门控可导出 `results/gating.gml` 并被 `fk.parse_gating_xml` 读回。
- 若用其他版本重新生成，事件数/阈值可能有小幅漂移，需同步更新技能包里的示例数字。

## 注意事项

- 示例数据只用于流程验证，**不要**把这里的显著性、频率或 MFI 当作科研结论。
- 不要把真实数据、临床标识或受试者信息放进本目录。
- 生成脚本只写目标文件与 provenance，不联网、不依赖 `%TEMP%`（沙箱环境下临时目录可能不可写）。
