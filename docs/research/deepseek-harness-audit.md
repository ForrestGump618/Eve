# DeepSeek Harness 官方上游审计（静态源码，2026-10-24）

## 结论与范围

建议 SuWen 当前采用 **III：参考设计，在现有 TypeScript Harness 独立实现**；保留 **II：通过固定版本适配器引入部分组件** 的后续选项，不以 I 整体替换现有运行时。理由并非插件架构不可用，而是本次源码对应的 workflow 明确没有 journal/resume，默认 background jobs 仅在进程内，Desktop Host 由 Electron 管理；这些能力不能直接满足附件要求的独立用户级 Daemon、持久任务 DAG、执行步骤 lease/fencing/outbox 和不可重复副作用恢复。会话事件可重放、提醒持久化与工作流持久执行是不同保证。

本报告只调查指定官方起点，不调查第三方同名桌面项目；未修改用户项目，未安装上游依赖，未执行上游脚本、应用或测试。本文的“观察”指实际读取源码或线上响应；“推断”指据此形成的设计判断；未运行的行为不计为验收通过。

## 来源身份和取样

- 官方仓库线上访问成功：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。README 链接指定文档站及 DeepSeek；这足以确认此次取样来自用户指定起点，不以 stars 等流行度决定复用。
- [指定文档站](https://deepseek-harness.github.io/deepseek-harness/) HTTP 页面可访问，但 web 工具提取为零行；主要文档证据来自下述 commit 的 `docs/`，不声称已浏览文档站全部页面。
- `git ls-remote ... HEAD refs/heads/master refs/tags/dsh-v0.2.1-rc.3` 实际返回 master/HEAD **22ddee3792402c3e70ec5f86a63c3e3e895a2f60**，tag **dsh-v0.2.1-rc.3 → 1f81c047fc48fa190a683e469daa699857e9afe8**。审计 master commit 与 release tag 不同，不能把此次快照称作 rc.3 发布内容。
- GitHub repository/tags API 首次响应成功，显示 default branch master、MIT、pushed_at `2026-10-23T15:25:40Z`；随后 commits API 返回共享出口 IP rate limit，未取得 commit 时间/签名验证。未用失败响应补造元数据。
- 浅克隆长时间零字节 pack 进展后中止，改用固定 commit 的 [GitHub codeload ZIP](https://codeload.github.com/deepseek-ai/deepseek-harness/zip/22ddee3792402c3e70ec5f86a63c3e3e895a2f60)。这是固定源码快照，不是成功的 Git checkout；无 `.git` 历史，不具备 tag 签名验证。
- ZIP 50,937,370 bytes，SHA-256 **088b7edccadb5577c7cf3898aa899de6a4efab15dc2e7cc80e43a6f8a8df65d3**。保存在当前 chat `work/upstream/deepseek-harness-22ddee37.zip`，展开目录 `work/upstream/source/deepseek-harness-22ddee3792402c3e70ec5f86a63c3e3e895a2f60/`。没有执行下载内容。
- 原地检查当前 chat 的祖先 AGENTS 文件未发现额外规则。读取上游 root `AGENTS.md`、`packages/AGENTS.md` 后仅进行只读审查；不把上游代理指令当作用户新增授权。

下文所有仓库路径都相对上述 SHA；可使用统一前缀 `https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/` 定位。

## 版本、许可与供应链

实际读取 `README.md`、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`package.json`、`AGENTS.md`、`vendor/README.md`：

- root package `@deepseek-ai/dsh-root` version `0.2.1-rc.3`，ESM，Node `>=24.9.0`，packageManager `pnpm@11.28.5`。这只说明源码 manifest，不代表本机已满足环境或成功构建。
- [LICENSE](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/LICENSE) 确为 MIT，`Copyright (c) 2026 DeepSeek`；复用 substantial portions 必须保留许可和版权。
- [THIRD_PARTY_NOTICES.md](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/THIRD_PARTY_NOTICES.md) 自述范围为 direct dependencies、明确披露的 Claude Code platform payload closure 和 bundled Python。完整 npm/Python closure 另在 pnpm/uv locks，不能将 notices 当作完整 SBOM。
- notices 明列 Apache-2.0、MPL-2.0（`@deepseek-ai/libreoffice-kit`）、`SEE LICENSE IN README.md`（Claude SDK）等。上游 MIT 不等于每个依赖、资源、平台 payload 均可随意改为 MIT。此轮没有独立验证每个包 tarball 的 license，也未生成本项目完整 SBOM。
- Cordis 是 **source-vendored + rescope + local patches**，不是简单安装 npm cordis 即等价。`vendor/README.md` 表格记录上游版本/commit，本地补丁表涉及生命周期、配置、HMR、持久写入。直接抽取插件会连带该定制框架与其依赖维护成本。
- [SAFETY.md](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/SAFETY.md) 明示 experimental developer preview，未经过 security audit，不能称为 production-ready。root AGENTS 同时说明 public APIs pre-stable。

## 实际源码调用链与边界

| 主题 | 已读取的实现与证据 | 对 SuWen 的含义 |
|---|---|---|
| 启动/配置/依赖注入 | `packages/boot/app-boot/src/index.ts` 导入 Cordis Context、Loader、Include，导出 profile composition/resolution；`docs/architecture.md` 描述 bundle → profile patch → home patch → CLI overlay；`vendor/cordis/src/fiber.ts` 实现 fiber states、effect 与 disposer；`packages/core/tools/src/index.ts:128` register 返回 disposer，executor registration 经 `ctx.effect` | 可参考配置层级、注册可撤销与服务定义/提供者/消费者拆分。配置中的 `!!js` 是可执行配置，导入第三方 config 不能仅当纯 JSON 数据 |
| Agent Loop | `packages/core/agent-loop/src/index.ts` `AgentLoop extends Service`，注入 agents/sessions/llm/tools/systemPrompt/sessionProjections；创建 `ReactLoopAgent` 并管理 teardown。`agent.ts:261` kick→turn；`:277` preStep→tools.resolve→systemPrompt.assemble→agent/pre-step；`:354` step/start；`:583` tools.execute；`:637` llm.prepareCall；事件追加是模型上下文来源 | 声称 all-plugin 有实际实现佐证，非只靠 README。核心 loop 可替换，但依赖 Cordis Context 和会话协议，不是零耦合函数库 |
| 工具执行/审批/取消 | `packages/core/tools/src/pipeline.ts:190` prepare，`:200` tools/pre-execute，ask 经 serviceAsk，deny/guards 可拒绝；`:300` tools/execute waterfall 包裹 tool body，`:488` tools/post-execute；fused abort signal 与结果 schema 校验实现可见。`agent.ts` 使用 tool recovery 补记录缺失结果 | 可借鉴真实 executor 强制策略与 UI 分离；不能仅靠隐藏 schema 阻止未授权调用。未做恶意输入/权限绕过实测，不声称整个上游安全 |
| 模型适配 | `packages/llm/llm/src/index.ts` adapter registry、prepareCall、stream seam；目录含 llm-deepseek、deepseek-account/api-key、llm-pi-ai、llm-retry | 有清晰适配点，但此轮没有真实 API key、provider 调用、错误降级或跨供应商隐私行为验证 |
| 会话持久化 | `packages/session/session-persistence-jsonl/src/storage.ts` append/flush/repair；`:207` materialized appends durable on resolution；`generation.ts` 与 docs 说明 version-named adjacent generations。`core/agent-loop/src/index.ts` resume 通过 SessionPersistence open 重建 Session；`docs/architecture.md` 明确硬崩溃前未 settle 的流式 attempt 不持久 | 原始 append-only log 与 projection 值得借鉴，但会话恢复不等于恢复到某个尚在执行的外部活动；未验证断电一致性 |
| 写锁 | `packages/session/session-persistence-jsonl/src/lease.ts` Windows kernel semaphore/POSIX flock，整个写 handle 独占；注释明确 wedged live process 继续持锁，**无过期抢占** | 这是 session writer exclusion。不能当 SuWen StepRun 的有到期时间 lease、heartbeat、fencing token 或副作用幂等机制 |
| SQLite | `packages/storage/storage-sqlite/src/index.ts` 以 JSON 文档行实现 KV backend；`schema.ts:79` foreign_keys、journal_mode WAL 默认、user_version=1；非当前 schema 拒绝而非 migration | WAL 存在不能直接宣称有附件所需原子 Task+Step+Event+Lease+Outbox 事务；该 configureDatabase 本次读取段未设置显式 busy_timeout/synchronous。不据此推断全仓库数据库均无此配置 |
| MCP | `packages/mcp/mcp-client/src/index.ts` 每实例一个 server，server-qualified names；stdio command+args 不经 shell interpolation，streamable HTTP，超时/重连配置；effect-scoped dispose 断连和撤销工具 | 值得参考 namespace、lifecycle、取消与启动失败可见性；未启动 MCP server，OAuth、凭据隔离和端到端数据库调用未验证 |
| Skills | `packages/skill/skill-filesystem/src/index.ts` project/custom/user roots、YAML frontmatter、`ctx.fs` load、watching；skill/tool-skill registry 分离 | 可参考 catalog，不能据此声称已具附件要求的源仓库静态扫描、隔离测试、许可证确认、用户批准导入链 |
| Desktop | `apps/desktop/src/main.ts:235` nodeIntegration false/contextIsolation true/sandbox true，外部 URL handler；`host-process.ts:201` spawn Node Host with IPC、无 detached，`:324` stop 发 shutdown 后限期 TERM/KILL；main finishQuit closes backend。README 说明 close hides UI、Host继续，quit停任务 | Renderer 与 Host 有进程隔离；隐藏窗口继续运行不等同脱离 Electron 的 OS 用户级 Daemon。不能直接满足 main 被杀后仍在运行与登录自动恢复 |
| 构建测试升级 | `.github/workflows/ci-windows.yml`、`windows-package.yml`、desktop-publish/release 等文件实际存在；root scripts 有 build/artifacts/check、Windows package、e2e/snapshot。compaction tests、JSONL lease/generation/migration tests 实际存在 | 仅核查了脚本和测试文件，未安装依赖、未运行 suite、未下载 release installer，也未验证 CI 当前绿灯或签名可信性 |

## Compaction 深审

源码链：`compaction-basic/src/index.ts:157` pre-step pressure hook → `compactIfNeeded` (`:292`) → `ctx.tokenMeter.measure` → region selection → `region.ts:210` append compaction/start → summarizer → `region.ts:491` append compaction/summary → append user/message `surfaceOp: replace` 并保留 `sourceEventSeqs` → append compaction/end；手动路径通过 `ctx.sessions.flush` (`index.ts:435`) 形成耐久屏障。发生异常会尝试记录结束错误；未匹配 start 可被识别。

这是 **追加事件后改变模型可见投影**，本次没有看到直接删除原始会话记录。保留原始日志、摘要范围/seq、call envelope 与 summary rawOutput 的设计适合作为 SuWen 的独立设计参考。

局限必须保留：

1. `llm/token-meter/src/estimate.ts:14` 是固定 `CHARS_PER_TOKEN = 4`，text、tool calls、JSON schemas 加结构开销；README 明示 CJK/JSON 会低估。`token-meter` 可复用相同 canonical envelope 的 provider usage，并有 route image pricing，但 **并不是所有模型请求的真实 tokenizer 预算**。不能因为其叫 token meter 就宣称满足附件真实 token 要求。
2. `compaction-basic/src/config.ts` default thresholdRatio 为 0.8，headroomTokens 默认为 65,536，并根据 model context/output cap 决定阈值。它是单 pressure threshold 加 overflow recovery；不是附件 65–75% 建议 + 80–85% 强制的完整双级 UI 策略。
3. `summarizer.ts` 使用工程助手 Markdown checkpoint prompt（Primary Request、Files、Errors、Pending Jobs 等）。不等于已提供科研证据来源 hash、摘要覆盖率/一致性验证、假设/阴性结果不可丢失约束、事实 TTL/撤销/局部删除。
4. 本轮未跑 100k token/10 次压缩/重启恢复或摘要保真评估。上游存在测试不等于本机已通过，也不能虚报精确无损。

## Durable Harness 缺口

以下是有范围的直接负面证据，不是对上游所有扩展的全称否定：

- [workflow README](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/workflow/workflow/README.md#known-limitations-and-deferred-work) `:127` 明示 No journaling or resume，脚本/中间值/子任务进度不 checkpoint；foreground holder-owned、没有 token-budget vocabulary。`workflow-ptc/src/runtime.ts:75` 创建 async vm.Script，`:105` drive，helper 由进程内 promise 管理；并不是持久 DAG engine。
- [jobs README](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/jobs/jobs/README.md) `:57,128` 明示默认 jobs 随 harness 进程退出、协议是 in-process callbacks；`jobs-local/src/index.ts` 的 TrackedJob、ring、owner、cancel 均在内存。
- schedule 是持久提醒服务而非完整 Activity workflow。`schedule/src/runtime.ts:126-140` 先 followup/Session flush 再 commit task receipt，README `:65` 明示 crash 在两次 durable writes 之间可能重复提醒；`:153` Host须运行，失败没有自动 retry timer。即便提醒可在启动恢复，也不提供外部不可逆活动幂等保证。
- 没有在上述 executor/session/workflow/jobs/schedule 采样链上证实 operation_id/outbox、步骤 fencing token、危险副作用 reconciliation、DAG 原子 checkpoint 与跨进程 worker recovery；这些是本次未验证或默认实现缺口，不能以 grep 无命中声称整个仓库不存在所有相关能力。
- 本轮没有进行 8/24/72 小时故障注入、Windows 登录/睡眠/断电/重启、守护进程复活实验。

## I / II / III 决策

| 维度 | I 官方运行时为核心+科研插件 | II 固定组件/SDK adapter | III 现有 TS Harness 独立实现 |
|---|---|---|---|
| 稳定性/API | developer preview，升级改动会穿透大量 Cordis/event/persistence consumers | adapter 可限定协议并固定版本，但 SDK profiles/数据格式仍需兼容测试 | 自控 public types/schema，需承担实现测试成本 |
| 架构耦合 | 原生 Cordis 全插件与定制 vendor 强耦合 | 进程/RPC 隔离优于硬抽内部包；明确能力/错误/取消协议 | 保留现有 Electron/TS/用户数据，先实现附件P0 |
| Durable P0 | 默认实现无法直接满足，仍需另造 engine/daemon | 可将上游视作某个受控、可重试计算活动，不能委托幂等语义 | SQLite 任务事务、leases/fencing/outbox、DAG与恢复由 SuWen 直接拥有 |
| Compaction P0 | 需扩真实 tokenizer/双阈值/科研证据保真评估 | 可借接口/协议，复用前需要可控 tokenizer+replay 测试 | 保留 append-only 原始数据，自建结构化摘要验证 |
| 数据迁移 | 当前 Session format 与既有会话迁移成本最高 | 可留原 DB，仅 adapter 保存映射/版本 | 兼容读取旧路径/DB，做备份和非破坏 migration |
| 许可成本 | 整个 runtime/desktop payload 依赖审查面广 | 仅导入实际使用组件，保留各自 license/notices | 新写代码 MIT，设计参考不复制第三方表达；依赖仍逐项审查 |
| 维护成本 | 上游能力丰富但 preview变更+本地 durability fork 双重成本 | adapter/contract tests + pin+受控升级 | 本地实现成本较高，但核心恢复语义与任务要求直接一致 |

**推荐落地：III 主线，II 留受控接口；本轮不将上游源码直接复制进用户项目，也不引入 I。** 首个纵向切片应先使独立 Daemon 与 WAL TaskRun/StepRun/Event/Checkpoint/Lease/Outbox 可测，再接模型/MCP/Python Worker。插件定义使用 SuWen 自有类型；任何未来上游 adapter 默认禁用、固定 SHA/版本、明示真实已验证能力，不向 UI 承诺上游没有的后台续跑。

## 交付后仍需验证

完整 npm/原生/Python payload SBOM与逐项许可、tag/release签名、生产 package exports 和实际 SDK integration、Windows Host生命周期实测、模型真实 token计量、多轮科研 compaction保真与崩溃恢复均尚未验证。上述内容不得标成已验收。
