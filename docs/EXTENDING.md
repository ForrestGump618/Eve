# 扩展指南（EXTENDING）

OmicsLab 的扩展点全部是**文件或少量 Python**，不需要改核心代码、不需要重新构建前端。

- [1. 自定义 Agent](#1-自定义-agent)
- [2. 自定义 Skill](#2-自定义-skill)
- [3. Memory（长期记忆）](#3-memory长期记忆)
- [4. 工具扩展（ToolSpec）](#4-工具扩展toolspec)
- [5. LLM 自定义端点](#5-llm-自定义端点)
- [6. 环境变量清单](#6-环境变量清单)
- [7. 二期工具集、技能与智能体](#7-二期工具集技能与智能体)
- [8. Settings 扩展字段](#8-settings-扩展字段)
- [9. 执行后端扩展（ExecutionBackend）](#9-执行后端扩展executionbackend)

---

## 1. 自定义 Agent

Agent 就是一个带 YAML frontmatter 的 Markdown 文件。正文（frontmatter 之后的部分）会原样作为该 Agent 的 `instructions` 注入系统提示。

### 1.1 存放位置与优先级

按顺序加载，**后者覆盖同 id 的前者**：

```text
1. omicslab/agents/*.md                  # 包内置（只读，随包发布）
2. <workspace>/agents/*.md               # 当前工作区
3. $OMICSLAB_TEMPLATES_DIR/*.md          # 环境变量指定的目录（最高优先级）
```

单个文件格式错误（YAML 解析失败、缺必填字段）只会被**跳过并记 warning**，不会导致服务启动失败。

### 1.2 完整示例

`<workspace>/agents/my-analyst.md`：

```markdown
---
id: my-analyst
name: 我的分析助手
description: 专注本实验室 10x 单细胞数据的质控与注释流程
category: single-cell
toolsets: [python, files, skills, memory, jobs]
skills: [single-cell-upstream, single-cell-downstream]
example_prompts:
  - 把 data/raw/pbmc.h5ad 做一遍标准质控并出图
  - 帮我看一下 adata 里线粒体基因的比例分布
---

你是本实验室的单细胞分析助手。

工作规范：
- 开始前先用 list_files 确认数据路径，不要猜文件名。
- 优先复用 shared kernel 中已有的变量，避免重复读盘。
- 质控阈值默认：n_genes_by_counts > 200，pct_counts_mt < 15；改动阈值前先说明理由。
- 每次出图后用一句话解释图表达的内容。
- 结论必须附带可复现的代码块。
```

刷新页面后，新建会话时即可在 Agent 下拉框里选择它；也可直接：

```bash
curl -s http://127.0.0.1:5077/api/agents | python -m json.tool
```

### 1.3 Frontmatter 字段

| 字段 | 必填 | 类型 | 说明 |
|---|:---:|---|---|
| `id` | ✅ | string | 唯一标识，小写字母/数字/连字符，与文件名建议一致 |
| `name` | ✅ | string | UI 显示名 |
| `description` | ✅ | string | 一句话说明，展示在下拉框和 `agent_list` 工具结果里 |
| `toolsets` | ✅ | string[] | 允许使用的工具集子集；`[]` 表示不限制 |
| `category` | ❌ | string | 分组，如 `general` / `single-cell` / `spatial` / `visualization` |
| `skills` | ❌ | string[] | 预置提示用到的技能名（不强制，仅用于目录提示） |
| `example_prompts` | ❌ | string[] | 新会话界面的快捷提问建议 |

> `toolsets` 的常见值：`python`、`shell`、`files`、`skills`、`memory`、`agents`、`jobs`、`system`、`notebook`，以及二期新增的 `discovery`、`registry`、`ssh`、`vision`。`[]` 表示不限制工具集。

### 1.4 让 Agent 调用其他 Agent

工具集里包含 `agents` 时，该 Agent 可以：

```python
agent_list()                       # 列出可用 Agent 及其描述
delegate_agent(agent="flow-cytometrist", task="对 data/fcs/ 做门控并出报告")
```

`delegate_agent` 会启动一个子回合，把子 Agent 的结论回填给父 Agent。适合把「流式细胞术」「报告撰写」这类专职工作分包出去。

---

## 2. 自定义 Skill

Skill 是**按需加载的操作手册**：平时只把 `name + description + when_to_use` 放进上下文，模型需要时才用 `skill_view` 读正文和附带脚本。这样几十个技能也不会撑爆上下文。

### 2.1 目录结构

```text
<skill-root>/
└── my-qc/
    ├── SKILL.md          # 必需：frontmatter + 正文
    ├── scripts/
    │   └── qc_plot.py    # 可选：可执行辅助脚本
    └── templates/
        └── report.md     # 可选：模板文件
```

### 2.2 技能根目录与优先级

同名技能**先者胜**，顺序为：

```text
1. $OMICSLAB_SKILL_ROOTS     # 多个根用 ; (Windows) 或 : (macOS/Linux) 分隔
2. omicslab/skills/          # 包内置
3. <workspace>/skills/       # 当前工作区
```

想覆盖内置技能：把同名目录放进 `$OMICSLAB_SKILL_ROOTS` 指向的目录。

### 2.3 SKILL.md 示例

````markdown
---
name: my-qc
description: 本实验室单细胞质控 SOP：线粒体比例、MAD 离群检测、双细胞过滤
when_to_use: 当用户要求对单细胞数据做质控、或提到 QC/过滤/双细胞时
version: 1.2.0
---

# 实验室单细胞 QC 流程

## 输入检查

1. 确认 `adata` 已加载且 `var_names` 是基因符号（不是 Ensembl ID）。
2. 统计细胞数与基因数，记录质控前基线。

## 标准步骤

```python
import scanpy as sc
import numpy as np

# 1) 计算 QC 指标
adata.var["mt"] = adata.var_names.str.startswith(("MT-", "mt-"))
sc.pp.calculate_qc_metrics(adata, qc_vars=["mt"], inplace=True, percent_top=None)

# 2) 硬阈值
adata = adata[
    (adata.obs["n_genes_by_counts"] > 200)
    & (adata.obs["pct_counts_mt"] < 15)
].copy()

# 3) MAD 离群（log1p 后按 5 MAD）
for col in ["log1p_total_counts", "log1p_n_genes_by_counts"]:
    x = adata.obs[col]
    med = np.median(x)
    mad = np.median(np.abs(x - med))
    adata = adata[np.abs(x - med) < 5 * 1.4826 * mad].copy()
```

## 检查清单

- [ ] 质控前后细胞数、基因数对比已输出
- [ ] 线粒体比例分布图已生成（`sc.pl.violin`）
- [ ] 过滤比例超过 30% 时向用户明确告警

## 常见陷阱

- 物种不是人/小鼠时 `MT-` 前缀可能不适用，先确认基因命名。
- 已经 `normalize_total` 过的数据不要重复归一化。
````

### 2.4 配套脚本

正文里可以引用附带脚本，模型会用 `run_python_code` 执行：

````markdown
运行 `scripts/qc_plot.py` 生成质控 violin 图：

```python
exec(open("skills/my-qc/scripts/qc_plot.py").read())
```
````

脚本路径通过 `skill_view(name)` 返回的 `files` 字段可获得。

### 2.5 校验

```bash
pytest tests/test_skills.py -q
```

测试会检查每个 `SKILL.md` 的 frontmatter 必填字段（`name` / `description` / `when_to_use`）、`name` 与目录名一致、`description` 非空。

---

## 3. Memory（长期记忆）

记忆是用户与 Agent 共享的**可编辑 Markdown 笔记**，用于跨会话沉淀：数据字典、项目偏好、分析结论、踩过的坑。

### 3.1 存储位置

```text
~/.omicslab/memory/<slug>.md
```

- `slug` 必须匹配 `[A-Za-z0-9_-]{1,64}`；
- 单条正文上限 64 KiB；
- 每轮只把**标题 + 摘要**注入上下文（默认上限 3000 字符），需要全文时模型用 `memory_view(slug)` 读取。

### 3.2 三种维护方式

**A. Web 界面**：侧栏「记忆」→ 新建 / 编辑 / 删除。

**B. 让 Agent 写**（工具集包含 `memory` 时）：

```text
用户：记住这个项目里 pbmc 数据用 MT- 前缀判断线粒体基因
Agent → memory_create(slug="pbmc-data-dict", title="PBMC 数据字典", body="...")
```

**C. 直接写文件**（推荐用于脚本化）：

```markdown
<!-- ~/.omicslab/memory/pbmc-data-dict.md -->
---
title: PBMC 数据字典
---

- `data/raw/pbmc.h5ad`: 10x 3' v3，8 个样本，未过滤
- 线粒体基因前缀: `MT-`
- 批次列: `obs["sample"]`
```

### 3.3 工具接口

| 工具 | 说明 |
|---|---|
| `memory_list` | 列出所有记忆条目（slug / title / 更新时间） |
| `memory_view(slug)` | 读取全文 |
| `memory_create(slug, title, body)` | 新建；slug 已存在时失败 |
| `memory_edit(slug, title?, body?)` | 局部更新 |

REST 对应接口见 [API.md §6](API.md#6-智能体--技能--记忆)。

---

## 4. 工具扩展（ToolSpec）

工具是 Agent 能做的事。一个工具 = 名称 + 描述 + JSON Schema 参数 + 异步 handler。

### 4.1 最小可运行示例

```python
"""omicslab/agent/my_tools.py — 自定义工具示例。"""
from __future__ import annotations

from typing import Any

from omicslab.agent.tools import ToolContext, ToolResult, ToolSpec
from omicslab.agent.types import ToolError


async def count_cells(ctx: ToolContext, path: str = "") -> ToolResult:
    """读取当前内核里的 adata，返回细胞数。"""
    code = (
        "int(adata.n_obs) if 'adata' in globals() else None"
    )
    result = await ctx.kernel.execute(code, timeout_s=30)
    if not result.ok:
        raise ToolError(f"读取变量失败: {result.error}")

    n = result.outputs[-1].get("text") if result.outputs else None
    if n is None:
        raise ToolError("内核里没有 adata 变量，请先加载数据。")

    return ToolResult(
        tool_call_id="",
        name="count_cells",
        ok=True,
        content=f"当前 adata 有 {n} 个细胞。",
    )


CELL_COUNT_SPEC = ToolSpec(
    name="count_cells",
    description="统计共享内核中 adata 的细胞数。适合快速确认数据规模。",
    parameters={
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "可选：提示用的数据路径"},
        },
        "required": [],
    },
    toolset="python",
    handler=count_cells,
    requires_approval=False,
)
```

### 4.2 注册

在 `build_registry()` 返回的注册表里追加（`omicslab/agent/tools.py`）：

```python
from omicslab.agent.my_tools import CELL_COUNT_SPEC

def build_registry(settings) -> ToolRegistry:
    specs = [
        # ... 内置工具 ...
        CELL_COUNT_SPEC,
    ]
    return ToolRegistry(specs)
```

> 注意：`omicslab/agent/tools.py` 属于核心 scope。若你是外部贡献者，请在 PR 里说明；更推荐的做法是先用 `run_python_code` 组合现有能力，确实需要高频复用时再新增工具。

### 4.3 `ToolSpec` 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `str` | 全局唯一，建议 `verb_noun` 风格 |
| `description` | `str` | 给模型看的能力说明，**写清楚何时用、何时不要用** |
| `parameters` | `dict` | JSON Schema（`type: object` + `properties` + `required`） |
| `toolset` | `str` | 用于 Agent 的 `toolsets` 过滤 |
| `handler` | `Callable[..., Awaitable[ToolResult]]` | 异步实现，第一个位置参数是 `ToolContext` |
| `requires_approval` | `bool` | 为 `True` 时在 `ask` 策略下等待用户确认 |

### 4.4 `ToolContext` 能拿到什么

| 成员 | 说明 |
|---|---|
| `ctx.settings` | 全局 `Settings`（含 `workspace`、超时、审批策略） |
| `ctx.kernel` | 共享内核服务：`execute` / `interrupt` / `restart` / 变量内省 |
| `ctx.registry` | 工具注册表（工具之间可互相调用） |
| `ctx.workspace` | 工作区根 `Path` **（做路径校验请用它）** |
| `ctx.conversation_id` / `ctx.agent_id` | 当前会话与 Agent |
| `ctx.emit(event)` | 向 SSE 推事件（`AgentEvent`），可发进度 |
| `ctx.cancel_event` | `asyncio.Event`，取消时置位；长任务请轮询它 |
| `ctx.approver` | 审批器（敏感操作可主动请求确认） |
| `ctx.jobs` / `ctx.memory` | 后台任务与记忆存储 |

1.2.0 起，运行链路还会给上下文动态挂上以下**可选属性**（旧工具不依赖它们也能工作）：

| 成员 | 说明 |
|---|---|
| `ctx.backend` | 当前 `ExecutionBackend`（本机或 SSH）。需要执行/文件能力时优先用它，不要直接用 `subprocess` |
| `ctx.workspace_ctx` | `WorkspaceContext`（工作区 id、backend、root、cwd 等）；`ctx.workspace` 仍是解析后的根 `Path` |
| `ctx.run_id` / `ctx.run_ctx` | 当前运行 id 与运行上下文（取 run 服务、父运行信息等） |
| `ctx.agent_task_id` | 子任务 id（主运行里为空字符串） |
| `ctx.run_sub` | 派生子智能体的可调用对象（`delegate_agent` 用它） |
| `ctx.run_service` | 当前 `RunService`（子任务、取消、查询等） |

### 4.5 实现约定

- **失败用异常表达**：抛 `ToolError("人话原因")`，工具层会转成 `ok=false` 回填给模型。
- **输出要短**：结果会进模型上下文，长数据请先汇总（表格 / 前 N 行）。
- **取消要响应**：超过几秒的任务，在循环里检查 `ctx.cancel_event.is_set()`。
- **路径要校验**：任何文件操作都用 `(ctx.workspace / rel).resolve()` 并确认父目录在工作区内。
- **不要 `print`**：日志用 `logging.getLogger("omicslab.<module>")`，可视化进度用 `ctx.emit`。

---

## 5. LLM 自定义端点

### 5.1 OpenAI 兼容端点

**设置页**：Provider 选「自定义 OpenAI 兼容端点」→ 填 Base URL 与 Key。
**配置文件**：`~/.omicslab/settings.json`

```json
{
  "provider": "custom_openai",
  "api_base": "http://127.0.0.1:8000/v1",
  "model": "my-local-model"
}
```

**环境变量**：

```powershell
$env:CUSTOM_OPENAI_API_BASE = "http://127.0.0.1:8000/v1"
$env:CUSTOM_OPENAI_API_KEY  = "sk-optional"
```

对接要求（OpenAI Chat Completions 协议）：

- `POST {base}/chat/completions`，`stream: true`；
- 流式返回 `data: {"choices":[{"delta":{"content":"..."}}]}`，以 `data: [DONE]` 结束；
- 支持 `tools` / `tool_calls`（不支持的端点也能用，只是无法调用工具，退化为纯对话）；
- `GET {base}/models` 可选（仅用于「测试连接」展示）。

### 5.2 Anthropic 兼容端点

```json
{
  "provider": "custom_anthropic",
  "api_base": "https://my-proxy.example.com",
  "model": "claude-3-5-sonnet-latest"
}
```

对应 `POST {base}/v1/messages`，`stream: true`。若 `api_base` 以 `/v1` 结尾会自动去掉，避免重复拼接。

### 5.3 本机 Ollama

```json
{
  "provider": "ollama",
  "api_base": "http://127.0.0.1:11434/v1",
  "model": "qwen2.5:7b"
}
```

Ollama 不需要 Key（内部使用占位值）。**必须显式指定 `provider: "ollama"`**，否则模型名 `qwen2.5:7b` 会被前缀规则推断成通义千问。

### 5.4 Provider 推断规则（了解即可）

1. 显式 `provider`（设置 / `OMICSLAB_LLM_PROVIDER`）优先；
2. 只有 `model` 时，看模型名是否包含 provider id（`deepseek-chat` → `deepseek`）；
3. 仍无法判断时，按「已配置 Key」的优先级顺序选第一个；
4. 都失败 → `ConfigError`，UI 会原样显示修复建议。

可用 provider id 全集：

```text
deepseek  ark  openai  anthropic  qwen  zhipu  moonshot  ollama
openrouter  siliconflow  google  custom_openai  custom_anthropic  mock
```

> `ark`（火山方舟）是二期新增的 OpenAI 兼容 provider，必须显式填写模型名/推理接入点
> （`ep-...`），Key 形如 `ark-xxxx`；只有 `ark-` 前缀的 Key 会被自动推断为火山方舟。

### 5.5 测试连接

```bash
# 测试当前已保存配置
curl -s -X POST http://127.0.0.1:5077/api/settings/test_llm \
  -H "Content-Type: application/json" -d '{}'
# {"ok":true,"latency_ms":812,"reply":"pong","error":null,"provider":"deepseek","model":"deepseek-chat"}

# 测试尚未保存的配置（内联覆盖 provider/model/api_base/api_key）
curl -s -X POST http://127.0.0.1:5077/api/settings/test_llm \
  -H "Content-Type: application/json" \
  -d '{"provider":"ark","model":"ep-2025xxxx","api_key":"ark-..."}'
```

成功与失败都返回 HTTP `200`，失败时 `ok=false`、`error` 为可操作中文说明。
设置页的「保存并测试」会先调 `POST /api/settings/keys` 原子保存 Key + provider + model + api_base，
再调用本端点回测，避免「只存了 Key、配置没生效」。

---

## 6. 环境变量清单

### 6.1 应用级

| 变量 | 默认 | 说明 |
|---|---|---|
| `OMICSLAB_HOME` | `~/.omicslab` | 应用主目录（设置、会话、图表、任务、记忆、日志） |
| `OMICSLAB_LLM_PROVIDER` / `OMICSLAB_PROVIDER` | `auto` | 强制指定 provider id |
| `OMICSLAB_LLM_MODEL` / `OMICSLAB_MODEL` | `auto` | 强制指定模型名 |
| `OMICSLAB_KERNEL_PYTHON` | 启动进程的解释器 | 共享内核使用的 Python 解释器绝对路径 |
| `OMICSLAB_SKILL_ROOTS` | 空 | 额外技能根目录，`;`（Windows）/ `:`（Unix）分隔，优先级最高 |
| `OMICSLAB_TEMPLATES_DIR` | 空 | 额外 Agent 目录，优先级最高 |
| `OMICSLAB_LOG_LEVEL` | `INFO` | 日志级别（`DEBUG` / `INFO` / `WARNING`） |

### 6.2 Provider 密钥

| 变量 | Provider |
|---|---|
| `DEEPSEEK_API_KEY` | deepseek |
| `OPENAI_API_KEY` | openai（也作为 `custom_openai` 的 fallback） |
| `ANTHROPIC_API_KEY` | anthropic（也作为 `custom_anthropic` 的 fallback） |
| `QWEN_API_KEY` | qwen（DashScope） |
| `ARK_API_KEY` / `VOLCENGINE_API_KEY` | ark（火山方舟） |
| `ZHIPU_API_KEY` | zhipu |
| `MOONSHOT_API_KEY` | moonshot |
| `OLLAMA_API_KEY` | ollama（可空） |
| `OPENROUTER_API_KEY` | openrouter |
| `SILICONFLOW_API_KEY` | siliconflow |
| `GOOGLE_API_KEY` | google |
| `CUSTOM_OPENAI_API_KEY` | custom_openai |
| `CUSTOM_ANTHROPIC_API_KEY` | custom_anthropic |
| `MOCK_API_KEY` | mock（测试用，无需真实值） |
| `VISION_API_KEY` | 视觉模型 Key（也接受 `OMICSLAB_VISION_API_KEY`；缺省回退 `OPENAI_API_KEY`） |

### 6.3 Base URL 覆盖

通用规则：**`<PROVIDER_ID大写>_API_BASE`** 会覆盖该 provider 的默认 base URL，例如：

```text
DEEPSEEK_API_BASE   OPENAI_API_BASE   QWEN_API_BASE   ZHIPU_API_BASE
MOONSHOT_API_BASE   OPENROUTER_API_BASE   SILICONFLOW_API_BASE
GOOGLE_API_BASE   ANTHROPIC_API_BASE
```

特殊情况：

| 变量 | 说明 |
|---|---|
| `OLLAMA_BASE_URL` | Ollama 端点（默认 `http://127.0.0.1:11434/v1`） |
| `ARK_BASE_URL` / `ARK_API_BASE` | 火山方舟端点（默认 `https://ark.cn-beijing.volces.com/api/v3`） |
| `CUSTOM_OPENAI_API_BASE` | 自定义 OpenAI 兼容端点 |
| `CUSTOM_ANTHROPIC_API_BASE` | 自定义 Anthropic 兼容端点 |

> 优先级：**settings.json 中显式 `api_base` > 环境变量 > provider 默认值**。
> 环境变量里的 Key 优先级高于 `auth.json`（便于 CI / 临时切号）。

### 6.4 示例：一次性临时配置

```powershell
# Windows PowerShell
$env:OMICSLAB_HOME = "D:\omicslab-home"
$env:DEEPSEEK_API_KEY = "sk-..."
$env:OMICSLAB_KERNEL_PYTHON = "D:\conda\envs\bio\python.exe"
.venv\Scripts\python.exe -m omicslab serve --port 5077 --workspace D:\data\pbmc
```

```bash
# macOS / Linux
export OMICSLAB_HOME="$HOME/omicslab-home"
export DEEPSEEK_API_KEY="sk-..."
export OMICSLAB_KERNEL_PYTHON="$HOME/miniconda3/envs/bio/bin/python"
.venv/bin/python -m omicslab serve --port 5077 --workspace ~/data/pbmc
```

---

## 7. 二期工具集、技能与智能体

### 7.1 工具集（toolset）

工具集是 Agent `toolsets` 过滤的单位。二期新增 4 个：

| toolset | 包含工具 | 适用场景 |
|---|---|---|
| `discovery` | `discovery_create_project`、`discovery_list_projects`、`discovery_status`、`discovery_run`、`discovery_record_evidence`、`discovery_record_analysis_result`、`discovery_report` | RSI 科研发现：建项目 → 跑闭环 → 记账本 / 结构化分析结果 → 读报告 |
| `registry` | `registry_lookup` | 查已安装科学计算包的函数签名/摘要，避免猜 API |
| `vision` | `analyze_image` | 用视觉模型解读图表、显微图像、截图 |
| `ssh` | `ssh_list_profiles`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_remote_info` | 远程算力：跑命令、传文件、看主机信息 |

一期已有：`python`、`shell`、`files`、`skills`、`memory`、`agents`、`jobs`、`system`、`notebook`，共 17 个核心内置工具、9 个 toolset。
加上二期的 `discovery`（7）、`ssh`（5）、`registry`（1）、`vision`（1）四个工具包后，Agent 注册表共 **31 个工具 / 13 个 toolset**。完整清单见 [API.md](API.md) 与 `omicslab/agent/tools.py` 的 `build_registry()`；另有平台层的 6 个生物医学工具（`bio_*`）与 Docker `sandbox_python` 不在该注册表内。

### 7.2 Agent 注册表内置工具（31 个）

| 分组 | 工具 |
|---|---|
| 内核 / Shell | `run_python_code`、`run_shell`、`get_system_info`、`export_notebook` |
| 文件 | `list_files`、`read_file`、`write_file` |
| 技能 / 记忆 | `skill_list`、`skill_view`、`memory_list`、`memory_view`、`memory_create`、`memory_edit` |
| 多智能体 | `agent_list`、`delegate_agent`（1.2.0 起委派会创建子运行 + 子任务） |
| 后台任务 | `submit_background_job`、`job_status` |
| 发现 | `discovery_create_project`、`discovery_list_projects`、`discovery_status`、`discovery_run`、`discovery_record_evidence`、`discovery_record_analysis_result`、`discovery_report` |
| 注册表 | `registry_lookup` |
| 视觉 | `analyze_image` |
| SSH | `ssh_list_profiles`、`ssh_exec`、`ssh_upload`、`ssh_download`、`ssh_remote_info` |

> 审批：`run_shell`、`write_file`、`ssh_exec`、`ssh_upload` 的 `requires_approval=True`；
> `ask` 策略下会先发 `approval_request`，被拒绝时以失败结果回填模型。

### 7.3 二期新增技能与智能体

**技能**（8 个，均位于 `omicslab/skills/<name>/SKILL.md`）：

```text
rsi-discovery-loop    # 观察→假设→预注册→执行→证据→反思→策略 的完整 playbook
hypothesis-generation # 可证伪假设的写法与常见错误
experimental-design   # 对照、样本量、统计检验、预注册
statistical-rigor     # 多重检验校正、效应量、置换检验、混杂
causal-inference      # DAG、工具变量、敏感性分析
remote-compute-ssh    # SSH 远程跑批、产物回收、断点续跑
function-registry     # 用函数索引定位正确 API
vision-interpretation # 图表/显微图像解读的提问模板与校验
```

2.0.0 起另有 5 个公开方法技能：`biomedical-discovery`、`co-scientist`、`empirical-research`、`paper2agent`、`robin`（完整目录与触发时机见 [SKILLS.md](SKILLS.md)）。

**智能体**（6 个，均位于 `omicslab/agents/*.md`，`tier: specialist`）：
`discovery-lead`、`hypothesis-smith`、`experiment-designer`、`evidence-critic`、
`research-strategist`、`remote-compute-engineer`。
`lead` 的 `toolsets` 已包含 `discovery` / `ssh` / `registry` / `vision`，并在 instructions
中约定「长任务科研发现走 discovery 项目，不要单轮硬做」。

### 7.4 在自定义 Agent 中启用二期能力

```markdown
---
id: my-discovery-analyst
name: 我的发现助手
description: 用 RSI 闭环研究自己的课题
toolsets: [python, files, skills, memory, discovery, registry, vision]
skills: [rsi-discovery-loop, statistical-rigor]
---

工作规范：
- 需要多轮探索时先用 discovery_create_project 建项目，再用 discovery_run 跑闭环；
  不要在单轮对话里硬做完整个研究。
- 不确定用哪个函数时先 registry_lookup，不要凭记忆猜函数名。
- 读图前确认视觉模型已配置；未配置时提示用户去设置页开启。
```

---

## 8. Settings 扩展字段

二期（1.1.0）与三期（1.2.0）在 `settings.json` 中新增/扩展以下字段（`GET /api/settings` 的 `settings` 里可见）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `vision_enabled` | bool | `true` | 视觉模型开关 |
| `vision_model` | string | `""` | 视觉模型名（如 `gpt-4o-mini`、`qwen-vl-plus`） |
| `vision_base_url` | string | `""` | 视觉模型 API 地址；有 Key 且为空时默认 OpenAI base |
| `provider` | string | `auto` | 新增取值 `ark`（火山方舟）；`auto` 仍可存但目录不包含 |
| `model` | string | `auto` | 切换 provider 时若未指定会重置为 `auto` |
| `max_parallel_runs` | int | `8` | 同时活跃的运行数上限（1–64） |
| `max_child_tasks` | int | `4` | 每个父运行可派生的子任务上限（1–16） |
| `max_child_depth` | int | `2` | 子智能体嵌套深度上限（1–4） |
| `max_workspace_scopes` | int | `4` | 同时存在的内核作用域上限（1–16） |

相关约定（详见 [API.md §9](API.md#9-设置与系统) 与 [API.md §16](API.md#16-运行与恢复)）：

- `GET /api/settings` 的 `providers` 是 **map（id → 对象）**，不再返回数组；对象含
  `needs_api_base` / `needs_model` / `hint` / `configured` 等字段。
- 保存设置用 `PUT /api/settings`；字段非法返回 400 `settings_invalid`。
- 保存 Key 用 `POST /api/settings/keys`（支持一次提交 `key + provider + model + api_base`
  与 `vision_api_key`），返回 `saved_keys` / `settings` / `llm` / `vision`。
- `POST /api/settings/vision` 与 `POST /api/settings/test_vision` 管理视觉配置；
  Key 存 `auth.json` 的 `VISION_API_KEY`。
- `GET /api/health` 的 `llm.error` 与 `vision` 字段用于排障；设置读取永不 500。
- 1.2.0 新增的并发/子任务上限也可以在线改：`PUT /api/runtime/config`（只接受
  `approval_policy`、`max_parallel_runs`、`max_child_tasks`、`max_child_depth`、
  `max_workspace_scopes`、`default_agent`，见 [API.md §16.6](API.md#166-运行时配置)）。

---

## 9. 执行后端扩展（ExecutionBackend）

1.2.0 起，文件、Shell、内核执行不再直接调服务，而是统一走
`omicslab/execution/base.py` 的 `ExecutionBackend` 抽象。**换执行环境 = 换一个后端**：

| 后端 | 位置 | 说明 |
|---|---|---|
| `LocalExecutionBackend`（`kind="local"`） | `omicslab/execution/local.py` | 包本机 `KernelService`、文件服务与后台任务；内核按工作区作用域复用 |
| `SSHExecutionBackend`（`kind="ssh"`） | `omicslab/execution/ssh_backend.py` | SFTP 传文件 + 远端常驻 worker（仅 stdio 的 JSON-lines 协议）执行 Python；路径限制在远端 `root` 内 |

### 9.1 接口

```python
class ExecutionBackend:  # omicslab/execution/base.py
    kind: str

    def __init__(self, workspace): ...

    async def start(self) / close(self) / interrupt(self): ...
    async def status(self) -> dict: ...                 # {backend, workspace, ...}

    # 执行
    async def execute_python(self, code, timeout_s=None) -> dict
    async def list_vars(self) -> list[dict]
    async def var_detail(self, name) -> dict
    async def shell(self, command, *, cwd="", timeout_s=None) -> dict

    # 文件
    async def list_dir(self, rel=".", *, show_hidden=False) -> dict
    async def read_text(self, rel, max_bytes=200_000) -> str
    async def write_text(self, rel, content) -> dict
    async def make_dir(self, rel) -> dict
    async def delete_path(self, rel) -> dict
    async def save_upload(self, rel_dir, filename, data) -> dict
    async def read_bytes(self, rel) -> tuple[bytes, str, str]   # (bytes, mime, name)
```

所有方法都接收**工作区相对路径**；实现方负责解析到自己的根（本地目录或远端 `root`）并做越界校验。

### 9.2 错误约定

| 异常 | 含义 | 上层行为 |
|---|---|---|
| `BackendError("人话原因")` | 可恢复的执行/路径错误 | 工具返回 `ok=false`，模型可读原因并重试 |
| `BackendUnavailable(...)` | 后端不可用（缺内核、缺 SSH 连接、远端离线） | 运行失败并给出可操作提示；**禁止静默回退本地** |
| `BackendUnsupported(...)` | 该后端不支持此能力 | 工具返回明确「不支持」 |

### 9.3 新增一个后端

1. 在 `omicslab/execution/` 新建模块，继承 `ExecutionBackend` 并实现上面的方法；
   无法支持的方法抛 `BackendUnsupported`。
2. 在 `omicslab/execution/__init__.py` 的 `make_backend(settings, workspace, *, kernel_provider=None, connections=None)`
   中按 `workspace.backend` 分派（当前只认 `local` / `ssh`；新增 kind 需同时扩展
   `WorkspaceService.create(..., backend=...)` 的允许值）。
3. 该后端的错误会经 RunService 归一化：`BackendUnavailable` 记为运行失败，
   `BackendError` 转成工具失败；工具输出自动带
   `data.execution_target = {kind, root, cwd, connection_id}`，方便前端与审计定位。

> 约定：后端只负责「在哪里执行」，不负责审批与运行生命周期；审批仍由 `Approver` 与工具层处理，
> 运行状态仍由 `RunService` 持有。这样同一套工具与 Agent 不用改代码即可切换执行环境。

---

本文件对应 Suwen 2.0.0。
