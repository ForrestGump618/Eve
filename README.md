# 素问 SuWen vNext

> 面向真实科研任务的 Windows 桌面科研 Agent：可持久运行、可追溯、可恢复、可诊断。
> A desktop research agent for Windows built around durable execution, evidence provenance, and reproducible research workflows.

- 当前版本 / Version: **1.0.0**（本次产品版本重新定为 1.0，原 3.4 历史保留）
- 1.0 验收与限制：[实际测试报告](docs/verification/release-1.0/REPORT.md)
- 默认入口：浅色完整工作台，项目文件与最近会话共用侧栏；正常启动只创建一个窗口。
- 桌面应用 / Desktop app: `desktop/` (Electron + TypeScript, MIT)
- 旧版 Python 工作台 / Legacy Python workbench: `omicslab/` (Apache-2.0, 保留用于兼容与迁移)
- 清理说明 / Clean source: [CLEAN-RELEASE.md](CLEAN-RELEASE.md)
- 发布证据 / Release evidence: [`docs/release/`](docs/release/) · [`docs/verification/`](docs/verification/) · [`docs/progress.md`](docs/progress.md)

---

## 这是什么 / What it is

素问是一个**桌面端科研 Agent**，不是聊天壳。它把长程任务、证据、审批、检查点与可复现分析放在同一个运行时里：

- **五个工作区**：对话 / 科研项目 / 任务执行 / 工具·技能 / 设置·诊断（中英双语）。
- **独立后台守护进程**：Electron 窗口只是控制端；关闭窗口后任务继续执行。任务状态存 SQLite WAL，具备 lease / fencing / heartbeat / checkpoint / 幂等重放保护。
- **流式事件协议**：统一 typed event envelope（run / message / reasoning / tool / artifact / compaction / paused / resumed / cancelled / failed / completed / reconnecting / restored），带 sequence、cursor、去重与断线重放；UI 增量渲染，输入框位置稳定。
- **上下文压缩**：分层记忆 + 结构化摘要（目标 / 约束 / 证据 / DAG / 决策 / 失败 / 待澄清），原始事件不可变，摘要可版本化回滚。
- **六大科研能力**：Knowledge、Hypothesis、Methods、Analysis、Discovery、Autonomy，均可通过审批点与人工裁决介入。
- **工具与数据**：MCP（stdio / HTTP）、Skill 注册表（安装前静态检查与隔离测试）、公开数据库（Europe PMC/PubMed、UniProt）真实检索并保存来源。
- **消息渠道**：Telegram / Slack / Discord / Email / Webhook / 微信官方接口；默认只读，敏感操作需额外授权；凭据由系统安全存储加密，不落明文日志。
- **RSI（受约束自我改进）**：Observe → Benchmark → Review → Canary → Promote/Rollback；源代码变更必须人工批准。
- **安全与合规**：contextIsolation、sandboxed renderer、严格 CSP、路径白名单、命名管道 token 认证、出口 URL 校验、MIT + NOTICE + SBOM。

English summary: SuWen is a Windows desktop research agent with a detached durable daemon, SQLite WAL state machine, typed streaming event protocol, context compaction, six research capabilities, MCP/Skill registries, messaging channels, constrained RSI, and a security-first Electron shell.

## 快速开始 / Quick start

开发（源码运行）：

```powershell
cd desktop
npm ci
npm test            # typecheck + unit/integration tests
npm start           # 开发模式启动 Electron
```

构建 Windows 安装包（未签名）：

```powershell
cd desktop
npm run dist:win
# -> release/v1.0.0/SuWen-Setup-1.0.0-win-x64.exe
```

- 默认进入正式科研工作台；需要可用 Python，缺少依赖时会准备受管依赖环境并显示进度。
- 在项目根目录运行 `./启动工作台.ps1`，或在 `desktop` 中运行 `./启动素问.ps1`；`-NativeConsole` 保留原生诊断控制台入口。
- 用户数据目录为 Electron `userData` 下的独立运行时目录；现有历史与密钥不包含在源码中。
- 本版本统一桌面与 Python 工作台包版本为 1.0.0；DSH 插件 0.3.0 作为独立兼容插件保留，不冒充桌面安装包的一部分。
- 最新验证、性能观察与未验证边界见 [1.0 交付记录](docs/verification/release-1.0/REPORT.md) 和 [固定 22 项任务矩阵](docs/verification/release-1.0/test-matrix.json)。

## 架构 / Architecture

```
Electron main (window, IPC, safeStorage, update glue)
        │  authenticated named pipe, one-line JSON RPC
        ▼
SuWen Harness Daemon (detached Node process)
        │  durable task DAG · leases · events · checkpoints · outbox
        ├── SQLite WAL (harness state, records, transcripts, evidence)
        ├── Model adapters (OpenAI-compatible, Anthropic; streaming, cancel, budget)
        ├── MCP client/registry · Skills · channels · RSI
        └── Python Research Worker (optional, sandboxed subprocess: FCS, datasets, scripts)
```

- 关键文档：[架构审计](docs/architecture/current.md) · [流式事件协议](docs/architecture/streaming-events.md) · [需求追溯](docs/requirements/traceability.md) · [能力对照](docs/migration/feature-parity-matrix.csv) · [UI 动作覆盖](docs/verification/ui-action-coverage.csv)。
- 旧版 Python 能力清单与迁移证据见 [`docs/migration/`](docs/migration/)。

## 正式工作台与 Markdown

- **正式页面默认启动**：完整工作台直接打开；首次缺依赖时自动准备并显示进度。保留原生诊断控制台与兼容接口。
- **工具与文件**：工具步骤默认折叠；输入区可选择真实工作目录，支持文本读取、搜索与带内容哈希的更新；预装 8 个基础技能，支持按需参考资料、自主创建/安装和有入口时实际执行。
- **长输出恢复**：遵循配置的输出预算，有限接续截断文本；不完整工具参数不会执行。受控协议和真实工具界面验收与真实供应商验收分别记录。
- **Markdown 补齐**：流式过程中逐步排版已闭合内容（表格/代码块/公式/图表），未闭合区域保持纯文本尾部；
  离线内置 KaTeX 与 Mermaid，失败时降级为标注代码块，不阻塞主线程。
- 注意：安装包未签名；干净 Windows 虚拟机安装、8/24/72 小时耐久与重启/断电测试**未执行**；
  固定 22 项真实厂商模型任务已在本轮验收中完成，单主机 SSH、远程文件/命令/Skill 与断线重连已实测；
  私钥与系统 SSH Agent、第二台物理主机、跨系统重启和远程 stdio MCP 仍未完成真实验收。

## DeepSeek Harness 插件 / DSH integration

- 仓库 [`integrations/dsh`](integrations/dsh/) 将科研能力封装为 DSH 原生工具与 [`suwen-research`](integrations/dsh/skills/suwen-research/SKILL.md) 技能。DSH 自己规划、调用模型并协调多代理；`python -m omicslab.integrations.science` 仅执行显式计算与数据操作，不加载 LLM、AppState 或 AgentLoop。
- 十一个工具覆盖状态、文献检索、蛋白查询、序列检查、Python、变量、notebook、证据、实验、知识和按需技能读取；方法正文沿用 [`omicslab/skills`](omicslab/skills/)。推荐流程为需求发现 → 查技能 → 数据审计 → 显式分析 → 证据/指标验证 → 报告；执行成功不等于科学验证。
- 使用 `plugin_manager` 安装仓库内 bundle，不手工修改 profile。安装、配置、工具契约与旧桥接迁移见 [DSH 插件集成说明](docs/integrations/dsh-plugin.md)。该 bundle 0.3.0 已安装并通过 11 个工具的真实调用验证，Python 侧 `tests/test_dsh_science.py` 等合计 44 passed；完整科研任务与干净虚拟机验证未执行，详见集成说明「验证记录」。旧九工具桥接不再作为推荐方式。当前产品版本为 1.0.0，DSH 插件版本仍为 0.3.0。

## 测试与验证 / Testing and verification

| 验证项 | 命令 | 结果说明 |
| --- | --- | --- |
| 单元/集成 | `cd desktop && npm test` | 真实 daemon、provider fixture、durable/RSI/MCP/channel、stream-core；跳过项会显式标注原因 |
| RPC E2E | `node scripts/e2e-rpc.mjs --dist dist`（可加 `--live`） | 真实命名管道与 daemon；`--live` 走真实公开数据库 |
| 科研能力 E2E | `node scripts/e2e-research.mjs` | 确定性本地模型 fixture + 真实 Python worker |
| 打包后 UI E2E | `SUWEN_SMOKE_PACKAGED=1 node scripts/electron-smoke.mjs` | 安装包 unpacked 产物：流式、关窗后台继续、重开恢复 |
| 流式 UI 稳定性 | `node scripts/streaming-ui-e2e.mjs` | 100/1000/10000 deltas、输入框稳定性、滚动、重连 |
| 视觉审计 | `node scripts/visual-audit.mjs` | 五工作区 × 分辨率 × 缩放 × 中英 × 深浅色截图 |
| 耐久故障注入 | `node scripts/chaos-smoke.mjs` | 短时故障注入（kill/重启/取消/provider 429）；**不含** 8/24/72 小时 |
| 安装生命周期 | `pwsh scripts/verify-installer.ps1` | 静默安装/启动/升级/卸载/SHA256 |

结果与原始数据见 [`docs/verification/`](docs/verification/)；当前测试数量、安装包 SHA256、缺陷与阻塞项以该目录下的机器可读报告为准。

**已明确未验证的项**（不得当作通过）：8/24/72 小时连续耐久与断电/休眠/磁盘满；干净 Windows 虚拟机安装；代码签名（当前未签名，SmartScreen 可能提示）；实际 SSH 私钥与系统 SSH Agent 登录；第二台物理 SSH 主机；远程 stdio MCP；跨系统重启的长任务交接。详见 [`docs/verification/release-1.0/REPORT.md`](docs/verification/release-1.0/REPORT.md)。

## 安全 / Security

- Renderer 无 Node 能力；IPC 校验 sender/frame/URL；CSP `connect-src 'none'` 防止渲染层直连外网。
- 模型密钥经 Electron `safeStorage`（Windows DPAPI）加密，凭据经安全引用传递，日志/支持包导出前脱敏。
- 外部工具与 MCP 输出被当作**数据**而非指令；高风险动作需人工审批。
- 安全审计范围与未覆盖项见 [`docs/verification/security-review.md`](docs/verification/security-review.md)。

## 许可 / License

- `desktop/`（vNext 桌面应用原创代码）：**MIT**，见 [`desktop/LICENSE`](desktop/LICENSE)。
- `omicslab/` 与旧版 Python 工作台：**Apache-2.0**，见根目录 [`LICENSE`](LICENSE)；历史 README 归档于 [`docs/archive/LEGACY-README.md`](docs/archive/LEGACY-README.md)。
- 第三方组件与数据源许可见 [`desktop/NOTICE`](desktop/NOTICE)、[`desktop/third-party-licenses/`](desktop/third-party-licenses/) 与 [`docs/verification/third-party-dependencies.md`](docs/verification/third-party-dependencies.md)。
- “素问 / SuWen”为产品展示名；旧名 OmicLab 仅在历史数据兼容路径与迁移文档中保留，不在面向用户的界面、安装包与日志中展示。
