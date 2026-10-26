# 素问科研工具（DeepSeek Harness bundle）

把素问（SuWen）仓库里已有的**科研能力**封装成 DeepSeek Harness 的原生工具。计划、推理、模型调用、上下文与多代理都由 DSH 负责；Python 侧只执行明确指定的科研操作，**不加载 LLM、`AppState` 或 `AgentLoop`**，也不需要在本插件里配置另一套模型。

- Bundle 目录：`integrations/dsh/`（本目录），包名 `@local/suwen`
- 后端入口：`python -m omicslab.integrations.science --stdio --workspace <ws> --home <home>`
- 协议：NDJSON，请求 `{id, op, params}` → 响应 `{id, ok, result | error{code,message,type}}`
- 主技能文档：[`skills/suwen-research/SKILL.md`](skills/suwen-research/SKILL.md)；科研方法原文仍由 `suwen_science_skills` 从 `omicslab/skills/` 按需读取

## 十一个工具

| 工具 | 说明 |
| --- | --- |
| `suwen_science_status` | 工作区、数据目录、内核状态与可用操作 |
| `suwen_literature_search` | Europe PMC 文献元数据，返回可引用来源 id |
| `suwen_protein_lookup` | UniProt 蛋白条目 |
| `suwen_sequence_check` | 本地 DNA 字母表/GC/反向互补检查 |
| `suwen_python` | 持久内核中执行显式代码，返回输出与 provenance id |
| `suwen_variables` | 列出内核变量 |
| `suwen_notebook_export` | 导出 nbformat 4 notebook |
| `suwen_evidence` | `record` / `verify` / `list` 证据台账 |
| `suwen_experiments` | `record` / `compare` / `list` 实验台账 |
| `suwen_knowledge` | `add` / `index` / `search` / `list` 知识库 |
| `suwen_science_skills` | 技能目录；传 `name` 读取正文 |

## 安装

1. 确认 Python 环境能 `import omicslab`（`pip install -e .` 或设置 `repoPath`）。
2. 用 DSH 的 `plugin_manager` 安装本目录的**绝对路径**，不要手工改 profile：

```json
{ "action": "install_bundle", "target": "<绝对路径>/integrations/dsh" }
```

3. 以返回的 `application`、`warnings`、`nextStep` 判断是否生效；安装成功、工具注册、真实科研任务验证是三件不同的事。
4. 修改本目录代码后需重新安装或重启 Harness，磁盘改动不会热更新已加载模块。

## 配置

配置写在 `cordis.patch.yml` 的 `config` 里（改完重新安装）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `pythonPath` | 空 | 数据计算后端 Python；空 → `$SUWEN_PYTHON` → `python` |
| `repoPath` | 空（自动识别） | 包含 `omicslab` 的素问仓库根目录；空时按本 bundle 位于 `<repo>/integrations/dsh` 推断 |
| `workspace` | 空 | 固定分析工作区；空时使用发起工具调用的 Agent 工作目录 |
| `home` | 空 | 后端数据目录；空时为 `<workspace>/.suwen-dsh` |

不同 workspace 有各自独立的 scope、内核与台账，路径不可混用。先用 `suwen_science_status` 核对。

## 边界

- Python 代码以**当前用户权限**执行，不是沙箱；只能执行你愿意在本机运行的代码。
- 工具成功只代表执行完成：文献/数据库结果是外部数据，证据核验与实验比较不替代统计学与生物学复核。
- 后端不读模型提供商配置，不会自行继续研究；下一步做什么由 DSH 决定。
