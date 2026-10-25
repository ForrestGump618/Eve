# 素问 SuWen vNext

> 面向真实科研任务的 Windows 桌面科研 Agent：可持久运行、可追溯、可恢复、可诊断。
> A desktop research agent for Windows built around durable execution, evidence provenance, and reproducible research workflows.

- 当前版本 / Version: **3.3.0**
- 桌面应用 / Desktop app: `desktop/` (Electron + TypeScript, MIT)
- 旧版 Python 工作台 / Legacy Python workbench: `omicslab/` (Apache-2.0, 保留用于兼容与迁移)
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
npm run dist:win    # -> release/SuWen-Setup-3.3.0-win-x64.exe
```

- 无 Python 也可使用基础聊天与数据库检索；Python 科研 Worker 作为受管子进程按需启动。
- 旧版 Python 工作台可用时，应用内“工具 → 兼容工作台”会以隔离窗口打开；本机未安装依赖时会明确显示不可用，而不是假装成功。
- 用户数据目录为 Electron `userData` 下的独立运行时目录；旧版 `~/.omicslab` 数据不会被自动覆盖，导入前会先备份。

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

## 实验工作台与 Markdown（3.3.0）

- **实验工作台**：第六个原生工作区页面。按需安装固定版本的 Python 运行时（约 130 MB，可取消），
  随后在隔离的 Electron 窗口中托管**现有素问网页版**（同一套 HTML/CSS/JS，12 个可导航路由），
  桌面端模型/凭据配置会注入托管桥接；页面本身不获得 Node/preload 能力。
- **Markdown 补齐**：流式过程中逐步排版已闭合内容（表格/代码块/公式/图表），未闭合区域保持纯文本尾部；
  离线内置 KaTeX 与 Mermaid，失败时降级为标注代码块，不阻塞主线程。
- 注意：安装包未签名；干净 Windows 虚拟机安装、8/24/72 小时耐久与重启/断电测试**未执行**；
  真实厂商模型账号/SSH/消息渠道未配置。

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

**已明确未验证的项**（不得当作通过）：8/24/72 小时连续耐久与断电/休眠/磁盘满；干净 Windows 虚拟机安装；代码签名（当前未签名，SmartScreen 可能提示）；真实厂商 API 账号；GitHub Release API 自动发布（本机无 `gh`/token）。详见 [`docs/release/release-gates.md`](docs/release/release-gates.md)。

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
