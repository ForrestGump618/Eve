# Eve 1.1.0 平台升级验收

> 验收日期：2026-10-29
> 发布分支：`codex/eve-1.0-science`
> 目标平台：Windows x64（安装包未签名）

本轮在不替换既有运行时、持久任务和 SSH 工作区架构的前提下，完成科研技能外挂、自主团队协作、RSI/Sage 整合、设置页能力、输出降噪、侧边栏、终端背压、上下文可见性和界面收口。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **831 passed, 1 skipped, 1 warning** |
| 桌面 TypeScript 单元/集成 | **302 passed, 1 skipped, 0 failed**（303 项，Windows 符号链接用例跳过） |
| 前端集成（设置、团队、终端、产物） | **40 passed, 0 failed** |
| 桌面类型检查 | **通过** |
| 科学能力审计 | **通过**，17 个能力域、3 个场景、351 个选中资源哈希一致 |
| 打包态 Electron smoke | **10/10 检查通过** |
| 安全扫描 | **0 HIGH / 531 LOW**，20 个测试夹具已登记 |
| Windows 安装包 | `Eve-Setup-1.1.0-win-x64.exe`，144,273,806 bytes |
| SHA-256 | `670dc02e964c1ca7a9f31067f56576085951e1a24fd056d1b2d4ce05e64f0d96` |

## 功能落地

### 自主团队协作

- 主智能体根据复杂度自主调用 `team_create`，不存在要求用户预先选择的独立组队模式。
- 团队方案先成为草稿，用户批准后才创建成员任务；依赖未完成的成员不能领取任务。
- 用户消息只下发到已批准成员；成员通过持久信箱讨论、复核并向队长回传结果。
- 子智能体在左侧「子智能体」侧栏中显示，可查看活动、依赖和状态，也可打开成员会话继续对话。
- 原会话继续显示队长汇总；团队结构化数据渲染为摘要卡，原始 JSON 仅保留在折叠诊断信息中。

详见 [多智能体协作架构](../../COLLABORATION.md)。

### RSI 与 Sage

- 科研发现闭环：工作区假设、预注册判据、证据账本、策略选择与负结果保留。
- 桌面策略调参：只允许五类声明式策略，评估后须显式确认晋升，可回滚。
- Proteus 源码副本进化：只改冻结副本，不部署、不替换当前安装。
- Sage 被明确为 RSI 的可选**验证增强内核**，不是第四层自主改进，也不替代引用检查、人工确认或回归门禁。
- Eve 的系统提示词、专职 Agent 和工具契约均声明以上边界。

详见 [RSI 能力与边界](../../RSI.md)。

### 科研技能与三大场景

技能库当前发现 **373** 个技能，其中 Google DeepMind Science Skills **40** 个、声明脚本 **65** 个。技能正文、脚本和资源按需读取，不整体注入上下文，也不编译进主 JavaScript 包。

| 场景 | 已有 | 缺口与边界 | 本轮补充 |
| --- | --- | --- | --- |
| 深度调研 | PubMed、bioRxiv、Europe PMC、OpenAlex 检索；全文、复现计划、引用与轨迹门禁 | 计划成功不等于逐句引用支持，也不等于数值结果已复现 | 工具正确性与引用存在性门禁、证据观察关联、原始哈希与人工复核保留 |
| 实验设计 | 引物/载体方法技能、NCBI 序列获取、Primer3 资源 | 单参考精确匹配不证明体内外特异性，克隆校验不证明湿实验成功 | 新增按需 Primer3 设计/Tm/二聚体检查、载体连接/CDS/环状校验 CLI |
| 数据处理 | 有界表达矩阵 QC、Scanpy/PyDESeq2 技能资源、产物和指标契约 | 未打包全部科研依赖，也没有真实多组学基准复现 | 复用确定性 QC 与沙箱脚本执行，输入/脚本/输出哈希和失败退出码可验收 |

完整“已有 / 缺失 / 补充方式”和来源清单见 [科学能力审计](science-capabilities.md) 与 [审计快照](science-capabilities.json)。该审计是离线源码/目录审计，本轮没有重跑外部数据库、模型服务或湿实验。

### 设置与会话

- 权限默认全部开放，仍可按工具覆盖为允许、询问或拒绝。
- 每个模型可配置温度、上下文窗口、最大输出、Token 参数名、输入模态和允许参数；支持备用模型。
- 验证模式可选 `standard`、`sage`、`off`，并保留旧 `sage_verification` 配置迁移。
- 会话支持归档、标题检索和长列表虚拟化；输入区下方展示上下文用量与压缩事件。
- 会话上限、分项组成、压缩趋势、多智能体占比和可展开摘要均有可见入口。

### 输出与侧边栏

- 文本和表格渐进渲染；执行型代码默认折叠，普通聊天不显示执行源码。
- 图表与 Archify 在受控沙箱和侧栏 Tab 中渲染；标注事件回传为局部修改请求，而不是整图重绘。
- 侧栏优先提供文件、Git diff、终端三个工作入口，并保留 Artifact、子智能体和第三方 Tab 扩展点。
- 终端后端使用 PTY，前端消费合并后的输出并做信用窗口背压；SSH 连接失败不会回退本机。
- 输入上方提供用户消息快速定位器，支持搜索、上一页/下一页和跳转后焦点恢复。

## 验证矩阵

| 证据 | 结果 | 文件 |
| --- | --- | --- |
| Python 全量 | 831 passed, 1 skipped | [python-tests.txt](python-tests.txt) |
| 桌面 TypeScript | 302 passed, 1 skipped | `npm --prefix desktop test` |
| 前端集成 | 40 passed | `node --test tests/frontend-*.mjs` |
| 设置页真实 Edge | 参数、模态、Sage 和权限保存通过 | [settings-browser-results.json](settings-browser-results.json) |
| 科学技能资源 | 373 skills; 351 resources matched | [science-capabilities.json](science-capabilities.json) |
| 打包态 smoke | 10 checks; daemon/Python/workbench retained | [packaged-smoke.json](packaged-smoke.json) |
| SBOM | CycloneDX 1.5 | Release asset `sbom.cdx.json` |
| 安全扫描 | 0 HIGH | Release asset `security-scan.json` |

关键界面证据：

- [模型能力设置](settings-models-desktop.png)
- [权限设置桌面版](settings-permissions-desktop.png)
- [权限设置移动版](settings-permissions-mobile.png)
- [打包态聊天与执行记录](packaged-chat-desktop.png)
- [打包态工具页](packaged-tools-desktop.png)
- [打包态兼容工作台](packaged-workbench-desktop.png)

## 体量与性能

同条件实测使用真实 Git 基线/当前 UI 源码和同一 Edge 版本，不启动 RPC 或模型：

| 指标 | 基线 | 当前 | 变化 |
| --- | ---: | ---: | ---: |
| 用户聊天气泡高度 | 91.390625 px | 82.390625 px | **-9.85%** |
| `desktop/ui` 源资源（LF 归一） | 373,440 B | 390,944 B | +17,504 B |
| `desktop/ui` 磁盘字节 | 373,440 B | 397,081 B | +23,641 B |
| `library.pack` | 12,232,630 B | 12,245,039 B | +12,409 B |
| `index.json` | 1,210,386 B | 1,213,218 B | +2,832 B |

完整数据见 [ui-comparison.json](ui-comparison.json)。技能体和脚本保持在外部资源包，没有整体进入主包；新增 UI 只增加约 17.5 KB 归一化源资源。

终端固定 4096 包、958,464 UTF-16 单元的 loopback xterm 基准：

- 渲染写入由 **4,096** 次合并为 **30** 次，减少 **99.27%**。
- 信用窗口峰值为 **131,040** 单元，不超过配置上限 **131,072**。
- 本次含合并等待的总耗时由 29.5 ms 变为 106.1 ms，因此该数字只证明写入收敛和背压边界，不宣称端到端更快，也不代表 SSH/网络吞吐。

见 [terminal-benchmark.json](terminal-benchmark.json)。

## 安装与校验

安装包为 per-user NSIS、可选择安装目录、默认保留用户数据。发布资产应包含：

- `Eve-Setup-1.1.0-win-x64.exe`
- `Eve-Setup-1.1.0-win-x64.exe.blockmap`
- `Eve-installer.json`
- `SHA256SUMS`
- `sbom.cdx.json`
- `security-scan.json`

机器可读安装包清单见 [installer.json](installer.json)。安装包未签名，Windows SmartScreen 可能提示；在受管环境部署前应完成组织签名策略。

## 未验证边界

- 本轮打包 smoke 使用本地 OpenAI-compatible HTTP fixture，没有使用真实计费模型账号。
- 没有在干净 Windows VM 执行安装、升级和卸载矩阵；宿主打包态 smoke 不等于干净机安装证明。
- 没有代码签名，也没有长时间 SSH、网络抖动、8/24/72 小时连续耐久或断电池恢复证明。
- 科学审计没有重跑全部 live API，没有验证逐句引用语义、真实多组学复现或湿实验成功。
- Proteus 真实进化需要可选依赖和真实模型凭据；自动化证据只覆盖冻结副本、计划和回归门禁。
- Python 子进程隔离是进程级边界，不是操作系统级安全沙箱。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck
python scripts/audit_science_capabilities.py --verify-resources --output docs/verification/platform-upgrade --check
node --test tests/frontend-settings.mjs tests/frontend-agents.mjs tests/frontend-teams.mjs tests/frontend-terminal.mjs tests/frontend-artifacts.mjs tests/frontend-terminal-benchmark.mjs
node desktop/test/ui-comparison.mjs
node desktop/scripts/verify-doc-hashes.mjs
```
