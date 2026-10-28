# 科学工作台与计算技能接入验收

日期：2026-10-28。产品版本：Eve 1.0.0。

## 交付范围

在「科研与证据 → 科学工作台」新增十个流程入口：文献与证据、遗传变异、靶点与药物、结构与序列、分子设计、测序分析、单细胞与多组学、蛋白组与代谢组、仪器数据、课题与实验。

每个入口显示已安装、已启用以及含计算入口或仅提供流程指引的技能。任务提交到原有 RunService 和 Harness，绑定选定工作区；没有增加另一套 Agent Loop。任务默认请求批准，需要付费推理、数据上传、依赖安装或集群作业时遵循原审批策略。

本次新增 127 项技能，其中 51 项进入发行包、76 项安装在本机用户扩展包。共享目录由 320 项增至 371 项，合并本机扩展共 447 项；正式界面还合并五项不重名的基础操作技能，因此全新测试配置显示 452 项。数量表示可发现的技能条目，不表示全部依赖已安装或全部科学任务已完成。

公开可复用的技能和脚本保留原始内容、提交版本、许可证及内容哈希；适配说明另存为 `EVE-ADAPTER.md`。没有明确再分发许可的资源只放在用户的 `runtime/science-library`，不进入 Git 仓库或安装发行包。来源和许可证见 `desktop/NOTICE` 与技能库索引，原始来源审计见同目录 `research-workbench-sources.json`。未取得、复制或宣称复现任何商业产品的私有服务或未公开实现。

## 已实现的计算入口

| 功能 | 实际行为及边界 |
| --- | --- |
| 环境检查 | 在选定主机检查 Python 模块和 PATH 程序是否存在；不自动安装，不代表功能测试通过 |
| FASTA | 保留序列、缺口、长度、GC 和有限彩色预览；等长不代表已比对 |
| FASTQ | 严格检查四行记录、长度与质量字符，计算读数、GC、N、Q30；按 Phred+33 解释 |
| 原始计数矩阵 | 检查非负有限整数、样本和特征唯一性，显示文库大小；未开展差异分析 |
| PDB | 读取首个模型坐标，支持拖动与方向键旋转；不推断化学键、不评估结构质量 |
| 科学脚本执行 | 支持参数和有界 JSON 标准输入，按声明准备依赖，依赖下载需明确授权 |
| 专业模型与工作流 | 收录设计、结构预测和组学流程指引及脚本；模型权重、服务额度与算力另行准备 |

预览只读，文件必须位于绑定工作区；文件读取上限 20 MB，解压后的文本上限 5 MB。FASTA 最多 50 条记录、合计最多预览 8,000 个字符；PDB 最多解析 5,000 个原子、显示前 180 个，并显式提示截断。检查记录保存文件 SHA-256 和工作区，不重复存储整份序列或坐标。

本地与 SSH 均通过选定后端运行。断连异常向上返回，禁止本地回退。新流程的真实远程主机验收尚未执行。

## 实际问题与修复

| 发现 | 原因 | 修复位置 |
| --- | --- | --- |
| 新技能只能发现，无法使用既有科学执行器 | 执行分派限定旧的 bundle 名称 | `desktop/src/domain/tools.ts` 根据声明的运行时分派 |
| 公共数据库脚本需要标准输入 | 执行器只有命令行参数 | `omicslab/execution/science_skills.py` 增加有界 JSON 输入 |
| 命令零退出码仍返回业务失败 | 上游通过 JSON 表达错误或缺少依赖 | 解析结构化错误，空输出也不得标记为成功 |
| 简单仪器转换首次安装超时 | 全套仪器依赖过重 | 单脚本最小依赖声明，环境缓存复用 |
| 部分模型脚本需要单独源码环境 | 脚本不是独立命令行工具 | 保留参考资源，声明额外环境要求，移出直接执行入口 |
| 全量测试复现 Windows 设置写入 `WinError 5` | 固定临时文件名加单次替换 | `omicslab/config.py` 复用唯一临时文件与有限重试的原子写入 |

工作台模型与接口分别位于 `omicslab/suwen/science_workbench.py`、`omicslab/server/routes_platform.py`。主机侧检查位于 `omicslab/execution/science_workbench.py`，工具注册位于 `desktop/src/agent-tools.ts`，界面位于 `omicslab/web/js/views/science-workbench.js`。

## 验证结果

| 验证 | 结果 | 命令 |
| --- | --- | --- |
| TypeScript 类型检查 | 通过 | `npm --prefix desktop run typecheck` |
| TypeScript 全量测试 | 287 通过、1 跳过、0 失败 | `npm --prefix desktop test` |
| Python 全量测试 | 658 通过；一条第三方弃用警告 | `python -m pytest -q` |
| 本地 Jupyter 与真实脚本检查 | 137 项检查通过、0 失败 | 见下方实际执行命令 |
| 源码启动的正式科学工作台 | 11/11 通过 | `node desktop/scripts/research-workbench-e2e.mjs` |
| 已安装版正式科学工作台 | 11/11 通过 | `node desktop/scripts/research-workbench-e2e.mjs --installed` |
| 已安装版交互图解与隔离回归 | 17/17 通过 | `node desktop/scripts/archify-e2e.mjs --installed` |
| Windows 目录构建 | 通过；未生成或上传新安装包 | 在 `desktop` 内运行 `npm run pack -- --config.directories.output=release/research-current` |

PowerShell 中的本地计算验收命令：

```powershell
python scripts/verify_research_workbench.py --live `
  --personal "$env:APPDATA\Eve\runtime\science-library" `
  --output desktop/release/research-acceptance/compute-final
```

137 项检查包含 **127 项资源准备、5 项输入或环境检查、4 项实际脚本执行、1 项依赖缺失负例**。实际脚本执行包括密码子输入校验、测序文件识别、仪器 JSON 转 CSV、公开蛋白数据库的真实 HTTP 查询。准备成功只表示资源完整可读，不能作为分析成功；缺依赖负例通过只表示系统正确拒绝虚假成功。137 不是完整科研任务的成功数。

Electron 验收使用固定模型协议驱动真实 UI、API、Jupyter 和工具执行。科学工作台实际发起 FASTQ 检查，工具计算结果回传 Harness 后显示在对话中。检查了十个流程、四类文件预览、环境状态、可交互坐标预览、单正式窗口以及无渲染异常。固定协议验收不等于真实模型自主科研质量验收。

公开、脱敏的逐项回执见 `research-workbench-evidence.json`。原始运行日志和完整报告保留在本机 Git 忽略目录 `desktop/release/`，本次失败基线保留在 `research-acceptance/compute/baseline-report.json`；没有覆盖为全通过。界面截图见 `../../screenshots/science-workbench.png`。

## 技能调用性能

共享目录采用内容寻址压缩资源，用户扩展包并入同一个发现索引。发现阶段只读名称、描述和关键词，调用时才读取正文、脚本与参考资料；不在启动时展开全库或把所有技能塞入上下文。脚本运行环境按主机缓存。

本次本机进程内微基准：447 项技能、800 次检索；索引构建 21.92 ms，检索 P50 0.0497 ms、P95 0.1952 ms，发现过程资源正文物理读取 0 次。共享压缩包 12,232,630 字节，用户扩展包 509,654 字节，合计 12,742,284 字节。没有下载模型权重。

这些是单次运行的索引测量，不是模型响应、任务完成或 SSH 延迟；没有同条件的改造前数据，因此不报告性能提升百分比、任务 Token 成本或模型成功率。

## 安装状态与回退

已安装 Eve 的应用资源已更新，切换前校验 805 个文件的 SHA-256。安装版与源码构建标识一致：

```text
b9a3a961b97e2f9b2e2d6d54e9dad49bd183c8f3f65b2decaaaed267ae6ebebb
```

原资源保存在本机忽略目录 `desktop/release/installed-pre-research-20261028/resources`，用于关闭应用后回退。用户模型配置、凭据和历史会话未改动；个人扩展资源只安装在用户目录。GitHub 不包含 EXE 或个人扩展包。

## 未验证与受阻项

- 当前主机未发现完整 FASTQ 流水线需要的 FastQC、MultiQC、fastp、Cutadapt、seqkit 与 Snakemake；完整质控不计作通过。
- 托管或 GPU 模型推理需要服务凭据、权重和计算环境，未运行。
- 全量组学分析需要真实数据、样本设计、参考组装和统计验证，未作为端到端科学任务验收。
- 新工作流未在真实 SSH 主机执行；已有路由和断连不回退行为有代码与测试覆盖。
- 未测量真实付费模型的自主科研成功率、端到端 P50/P95、Token 成本或引用准确率。
- 文件预览不是完整的基因组浏览器、切片阅片器或分子结构软件，不宣称同等能力。
