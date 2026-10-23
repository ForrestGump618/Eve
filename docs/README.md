# Suwen 文档

素问 Suwen 是面向日常工作与科研的本地 AI Agent 工作室：在本机或 SSH 工作区里运行持久的 Agent 任务，用技能扩展分析方法，并对科研结论执行证据门控。本目录是它的公开文档入口。

> 当前版本 **2.0.0**（Python 包名仍为 `omicslab`）。项目根目录的 [README](../README.md) 给出定位、启动方式和能力边界；本页负责把文档按读者和主题组织起来。

## 从这里开始

第一次使用，按这个顺序读即可：

1. [安装指南](INSTALL.md) — 从零安装、可选依赖与离线安装。
2. [运行说明](SUWEN-V2-GUIDE.md) — 启动参数、数据目录、模型配置、SSH 工作区与任务。
3. [常见问题](FAQ.md) — 安装、端口、密钥、数据位置等高频问题。
4. [V2 实现与缺口清单](SUWEN-V2-CHECKLIST.md) — 哪些已实现、哪些只是部分可用。

## 按读者选择阅读路径

### 使用者

想尽快跑起来并知道边界：

- [安装指南](INSTALL.md) → [运行说明](SUWEN-V2-GUIDE.md) → [常见问题](FAQ.md)
- 能力与限制：[V2 实现与缺口清单](SUWEN-V2-CHECKLIST.md)、[与商业方案的对照](COMPARISON.md)
- 科研使用：[科研证据设计](BIOMEDICAL-EVIDENCE.md)、[内置技能库](SKILLS.md)

### 研究者

关心方法、证据和可复现性：

- [科研证据设计](BIOMEDICAL-EVIDENCE.md) — Biomni 思路、证据/推断/假设分级与门控。
- [内置技能库](SKILLS.md) — 方法技能目录、触发时机与产出检查。
- [V2 验证记录](VALIDATION-V2.md) — 439 项自动回归与真实环境实测范围。
- [参考项目与许可证](REFERENCES-V2.md) — 借鉴了什么、没有打包什么。

### 开发者

要读代码、改接口或加工具：

- [架构说明](ARCHITECTURE.md) — 组件、请求生命周期、落盘位置、并发与安全边界。
- [API 参考](API.md) — REST + SSE 接口、错误码与运行恢复。
- [扩展指南](EXTENDING.md) — 自定义 Agent、Skill、Memory、工具、执行后端与 LLM 端点。
- [安装指南 §4](INSTALL.md#4-jupyter-内核解释器) — Jupyter 内核解释器的选择规则。
- 变更记录：[CHANGELOG](../CHANGELOG.md)。

### 维护者

要判断“能不能发布、还缺什么”：

- [V2 实现与缺口清单](SUWEN-V2-CHECKLIST.md) — 24 类需求的逐项状态，是实现状态的唯一事实来源。
- [V2 验证记录](VALIDATION-V2.md) — 测试与实测证据。
- [V2 原始需求](SUWEN-V2-REQUIREMENTS.md) — 需求基线，用于对照验收范围。
- [归档文档](archive/README.md) — 1.2.0→2.0.0 的开发过程记录。

## 文档一览

| 文档 | 一句话用途 | 状态 |
|---|---|---|
| [INSTALL.md](INSTALL.md) | 安装、可选依赖、离线安装、内核解释器与 Windows 注意事项 | 当前 |
| [SUWEN-V2-GUIDE.md](SUWEN-V2-GUIDE.md) | 2.0.0 运行手册：启动、数据目录、模型、SSH 工作区、任务与备份 | 当前 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 组件图、请求生命周期、落盘位置、并发/取消、运行状态机与安全边界 | 当前 |
| [API.md](API.md) | REST + SSE 接口参考与示例（含运行、工作区、SSH、Discovery） | 当前 |
| [EXTENDING.md](EXTENDING.md) | 自定义 Agent / Skill / Memory / Tool / 执行后端 / LLM 端点 | 当前 |
| [SKILLS.md](SKILLS.md) | 23 个内置技能与专职 Agent 的搭配、触发时机与产出检查 | 当前 |
| [SUWEN-V2-CHECKLIST.md](SUWEN-V2-CHECKLIST.md) | 24 类 V2 需求的逐项实现状态（含尚缺子项） | 当前 |
| [SUWEN-V2-REQUIREMENTS.md](SUWEN-V2-REQUIREMENTS.md) | V2 原始需求基线，用于对照验收范围 | 当前 |
| [VALIDATION-V2.md](VALIDATION-V2.md) | 2.0.0 自动回归与实测记录 | 当前 |
| [BIOMEDICAL-EVIDENCE.md](BIOMEDICAL-EVIDENCE.md) | Biomni 思路与科研证据门控设计 | 当前 |
| [REFERENCES-V2.md](REFERENCES-V2.md) | 参考项目清单、借鉴点与许可证边界 | 当前 |
| [COMPARISON.md](COMPARISON.md) | 与商业组学工作台的功能对照及边界声明（内容整理于 1.3.0 时期） | 当前 |
| [UPGRADE-1.3.md](UPGRADE-1.3.md) | 1.3.0 SSH 工作区升级说明与验证范围 | 当前 |
| [VALIDATION-1.3.md](VALIDATION-1.3.md) | 1.3.0 验证快照 | 当前 |
| [FAQ.md](FAQ.md) | 安装、配置、数据与使用的高频问题 | 当前 |
| [ROADMAP.md](ROADMAP.md) | 按实现状态整理的路线图与参与方式 | 当前 |
| [archive/README.md](archive/README.md) | 开发过程归档说明（契约、验收日志、旧 README） | 归档 |

界面截图位于 [`screenshots/`](screenshots/)：工作台与设置页各提供明、暗主题截图。

## 事实来源

同一主题在多个文件出现时，以这里的声明为准：

| 主题 | 事实来源 | 说明 |
|---|---|---|
| 安装、依赖与离线部署 | [INSTALL.md](INSTALL.md) | 命令与依赖清单随 `pyproject.toml` 更新 |
| 运行方式、数据目录与模型配置 | [SUWEN-V2-GUIDE.md](SUWEN-V2-GUIDE.md) | 与 `omicslab/config.py` 的默认值一致 |
| 系统架构与设计约定 | [ARCHITECTURE.md](ARCHITECTURE.md) | 接口字段与错误码以 `omicslab/server/` 代码为准 |
| HTTP / SSE 接口 | [API.md](API.md) | 契约文档仅作历史参考，当前实现以服务端代码为准 |
| 实现状态与缺口 | [SUWEN-V2-CHECKLIST.md](SUWEN-V2-CHECKLIST.md) | 其他文档不得把“部分实现”写成“已完成” |
| 验证与实测范围 | [VALIDATION-V2.md](VALIDATION-V2.md) | 未验证的真实环境会明确标注 |
| 需求范围 | [SUWEN-V2-REQUIREMENTS.md](SUWEN-V2-REQUIREMENTS.md) | 原始需求，不随实现回改 |
| 技能内容 | `omicslab/skills/<name>/SKILL.md` | [SKILLS.md](SKILLS.md) 是目录与导读 |
| 许可证 | [LICENSE](../LICENSE) | Apache-2.0；参考项目按各自许可证，不成为本包依赖 |

## 文档约定

- 版本对应：未特别标注时，文档描述 Suwen 2.0.0；正文里的“1.2.0 起”“1.3.0”用于说明能力首次引入的版本或历史记录。
- 状态用词统一为 **已实现**、**部分实现**、**待实现**、**外部依赖限制**，与 [实现清单](SUWEN-V2-CHECKLIST.md) 保持一致。
- 界面相关描述以当前 Web UI 为准；接口细节可能随代码变化，发现文档与实现不一致时，请以代码与 `GET /api/health`、`GET /api/runtime/diagnostics` 为准，并提交 Issue。

---

本文件对应 Suwen 2.0.0。
