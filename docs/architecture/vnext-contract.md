# SuWen vNext — 实施契约（Lead 维护，冻结）

所有并行开发者以此文件 + `desktop/src/shared/contract.ts` 为唯一接口依据。
本文件由 Lead 维护；**任何队友不得修改** `desktop/src/shared/contract.ts`、`docs/architecture/vnext-contract.md`、`desktop/src/harness/store.ts`（已由 Lead 实现 v3）。缺少接口时向 Lead 报告。

## 1. 文件所有权（写作用域）

| 角色 | 独占写作用域 |
|---|---|
| Lead | `desktop/src/daemon.ts`、`desktop/src/main.ts`、`desktop/src/preload.cts`、`desktop/src/shared/**`、`desktop/src/harness/**`、`desktop/src/activities/index.ts`、`desktop/src/activities/model.ts`、`desktop/src/activities/databases.ts`、`desktop/src/import-service.ts`、`desktop/package.json`（必要时）、`desktop/tsconfig.json`（不轻易改）、根 `README.md`、`docs/architecture/**`、`docs/progress.md` |
| A research-worker | `desktop/worker/**`、`desktop/src/research-worker.ts`、`desktop/test/research-worker.test.ts`、`desktop/test/fixtures/worker/**` |
| B research-domain | `desktop/src/activities/research.ts`、`desktop/src/domain/research.ts`、`desktop/src/domain/hypothesis.ts`、`desktop/test/research-activity.test.ts`、`desktop/test/domain-research.test.ts` |
| C ui-app | `desktop/ui/**`、`desktop/ui/actions.json`、`desktop/scripts/ui-dom-qa.mjs` |
| D docs-audit | `docs/migration/**`、`docs/requirements/**`、`docs/verification/**`、`docs/release/**`、`docs/research/**`、`.github/workflows/**`（`docs/progress.md`、`docs/architecture/**` 除外） |
| E tools-channels-rsi | `desktop/src/domain/tools.ts`、`desktop/src/domain/channels.ts`、`desktop/src/domain/rsi.ts`、`desktop/src/activities/tools.ts`、`desktop/test/tools.test.ts`、`desktop/test/channels.test.ts`、`desktop/test/rsi.test.ts` |

A/B/C/E 不得编辑 daemon.ts/main.ts/store.ts/contract.ts/package.json；需要接线时在 `desktop/src/activities/<scope>.ts` 导出工厂函数并通知 Lead。

## 2. 数据层（Store v3）

`Store` 实现 `RecordStore`（见 contract.ts）。迁移：user_version=3，升级前自动 `VACUUM INTO` 备份；新增 `records` 表：

```
records(id TEXT PK, kind TEXT NOT NULL, data_json TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
        provenance_json TEXT, project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)
INDEX records_kind(kind, updated_at DESC), INDEX records_project(project_id, kind, updated_at DESC)
```

- `putRecord(kind,data,{id?,expectedVersion?,provenance?,projectId?})`：新建 version=1；更新要求 expectedVersion===当前 version（CAS），version+1；失败抛 `ConflictError`。`data` 必须是纯 JSON 且持久化前脱敏（store 内置 redact）。
- `listRecords(kind,{projectId,limit,offset,order})` 默认 `updated_at DESC, rowid DESC`；`limit` 上限 500。
- `deleteRecord(id, expectedVersion?)`；`countRecords`。
- 所有记录带 `provenance`（来源、taskId、sha256 等）用于审计。

### 记录种类与 data 形状（权威）

- `project`: `{name, notes, archived}`；id 由调用方生成或 store 生成。
- `conversation`: `{projectId, title, mode, messages:[{id,role,text,at,taskId?,mode?}], updatedAt}`。`conversation.append` 追加消息并 CAS 重试（daemon 负责），单条 text<=100k。
- `evidence`: `{projectId, taskId, stepId, kind:'literature'|'database'|'experiment'|'analysis'|'method'|'note', title, source, query, retrievedAt, version, citation, url?, payload, payloadSha256, license?, contradicting?:boolean}`；list 支持 projectId/kind。
- `hypothesis`: `{projectId, taskId, question, statement, rationale, evidenceIds:[], score, critique, revision, status:'draft'|'critiqued'|'ranked'|'selected'|'rejected'|'testing'|'supported'|'refuted', dedupeKey}`。
- `experiment`: `{projectId, hypothesisId, design, protocol, simulated:boolean, status:'proposed'|'approved'|'running'|'completed'|'failed'|'rejected', approval:{at,note}|null, result:Json|null, artifacts:[], submittedAt}`；真实结果导入必须显式 `simulated:false` 才可用于 discovery 结论。
- `skill` / `mcpServer` / `channel` / `rsiRun` / `strategy` / `researchGraph` / `importJob`：形状见 `contract.ts` 对应 View 类型，多出的字段允许，但必须纯 JSON。
- `researchGraph`: `{projectId, taskId, objective, worldState, milestones:[], nodes:[{id,kind,status,deps,output?,evidenceIds?}], edges, budget, status}`。

## 3. 任务与活动

任务引擎不变（`Engine` + `Store` lease/fencing/checkpoint）。新增活动处理函数由各模块导出：

```ts
export function createResearchHandlers(services: ActivityServices): Record<string, ActivityHandler>;
export function createToolHandlers(services: ActivityServices & { tools: ToolServices }): Record<string, ActivityHandler>;
```

Lead 在 `src/activities/index.ts` 汇总：`{...model/pubmed/uniprot/python/research 基础, ...researchHandlers, ...toolHandlers}`，并在 daemon 中注册。活动输入/输出约定（JSON）：

- `research`: `{op:'health'|'describe'|'flowSummary'|'datasetProfile'|'discoveryScan'|'runScript', input:Json, timeoutMs?}` → `{result}`；`runScript` 输入 `{language:'python'|'node', source, args?, files?:[{name,text?|dataBase64?}], timeoutMs?, seed?}` → `{exitCode,stdout,stderr,files:[{path,sha256,bytes}],versions:{python?,node},sandbox}`。所有执行限制在 `<home>/sandbox/<uuid>`，不得访问 home 之外（相对路径逃逸拒绝），默认超时 120s、输出截断 256KB。
- `knowledge`: `{question, databases?:('pubmed'|'uniprot')[], limit?}` → `{question, findings:[{sourceId,kind,title,citation,url?,retrievedAt,query,payloadSha256,payload}], summary, gaps}`；findings 同时写入 `evidence` 记录（provenance.taskId）。
- `hypothesis`: `{op:'generate'|'critique'|'rank', question, context?, hypotheses?:[...], evidenceIds?:[]}` → 结构化 `{hypotheses:[{id,statement,rationale,novelty,testability,evidenceIds}]}` 或 `{critiques:[...]}` / `{ranking:[{id,score,reason}]}`；写 `hypothesis` 记录（generate/critique/rank 分步任务由 B 提供 `buildHypothesisTask`）。
- `debate`: `{op:'propose'|'critique'|'revise'|'synthesize', question, role, round, prior?}` → `{text, structured?}`；每轮输出写 `evidence`(kind:'note') 供审计。
- `methods`: `{op:'scaffold'|'test', name, paperText?, repoPath?}` → scaffold 生成 Skill 目录（SKILL.md/manifest/entry/测试样例/许可证字段）到 `<home>/skills/<name>-<sha8>`，写 `skill` 记录（test 状态 not_run）；test 调用 `research.runScript` 隔离执行并写回 test 结果。安装外部代码必须 `sideEffect:true` + 前置 approval 步骤。
- `analysis`: `{op:'profile'|'run', datasetPath?, source?, metric?, seed?}` → profile 用 worker `datasetProfile`；run 用 worker `runScript` + 指标评分 + artifacts；禁止训练/测试泄漏（输入显式 train/test 文件时校验不重叠，记录到输出）。
- `discovery`: `{op:'design'|'analyze'|'feedback', hypothesisId?, design?, result?}` → design 写 `experiment`(proposed, simulated:false 要求人工审批)；analyze 只接受已 approved 且已导入 result 的 experiment；feedback 生成下一轮假设并更新 `researchGraph`。
- `autonomy`: `{op:'plan'|'execute'|'verify'|'update', objective, graph?, node?}` → plan 生成 <=8 节点 DAG 写 `researchGraph`；execute 单节点（节点 kind 白名单 research/analysis/knowledge/hypothesis；高风险节点要求 approval）；verify 校验节点证据与产物 sha256；update 写 worldState/milestones。循环由 B 的 `buildAutonomyTask` 展开为有界步骤（每轮显式 checkpoint）。
- `skill.test` / `channel.send` / `rsi.evaluate`：B/E 提供，Lead 注册。`channel.send` 必须 `sideEffect:true`，非只读渠道需 approval 步骤。

活动错误语义：输入非法抛 `ValidationError`（不重试）；临时故障抛普通 Error（引擎重试）；外部结果未知时在 output 标注 `uncertain:true` 并要求 reconciliation，禁止盲目重放。

## 4. RPC 方法（daemon dispatch）

名单以 `contract.ts` 的 `RPC_METHODS` 为准。所有方法参数为纯 JSON object；返回 JSON。错误经 `safeError` 脱敏。`create` 允许的 step kind 为 `TASK_STEP_KINDS`；kind 属于需要模型的集合（model/knowledge/hypothesis/debate/methods/discovery/autonomy）时，未 configure 则拒绝。

主要方法语义：

- `project.*` / `conversation.*`：records CRUD；`conversation.append` 内部 CAS 重试 3 次，返回 `{record, seq}`。
- `import.inspect`：只读扫描 legacy home（可配 `SUWEN_LEGACY_HOME`，默认 `%USERPROFILE%\.omicslab`）与会话/配置/技能/项目/实验产物，返回 `{legacyHome, exists, items:[{kind,name,count,path}], counts}`，不写源。
- `import.apply`：`{kinds?, dryRun?}` → 先复制备份到 `<home>/migration/backup-<ts>/` 并写 manifest(sha256)，再幂等导入（provenance 含 source path+hash+时间），重复执行去重；返回 `importJob` 记录。`import.rollback` 按 job 撤销新增 records（备份保留）。
- `research.*`：`{projectId?, ...}` → 创建 durable 任务并返回 `{taskId, task}`；模板由 B 提供。`research.graph` 返回 `researchGraph` 记录。
- `hypothesis.*` / `experiment.*` / `evidence.*`：records 查询与状态迁移；`experiment.approve` 要求 `decision:'approve'|'reject'`。
- `artifact.read`：`{taskId, artifactId}` 读取 tasks artifacts 表并限制在 `<home>/artifacts` 下，返回 `{path,sha256,bytes,mediaType,text}`（文本<=200KB，二进制返回 base64）。
- `skill.*`：E 的 ToolServices 实现；`skill.install` 支持 `{path}` 本地目录或 `{url}` GitHub 公开仓库（fetch 后写入受限目录，静态检查：路径逃逸/可执行脚本/大文件；必须 `confirm:true`）。
- `mcp.*`：E 实现；`mcp.add` 校验 command/url、只读标记、env 键白名单（secret 值由 main 进程安全存储，daemon 只存 secretRef）；健康检查有超时。
- `channel.*`：E 实现；`channel.save` 的 config 只含非密文字段，凭据用 `secretRef`（由 main 进程 safeStorage 管理）；`channel.test` 做真实连通性（超时 10s）；`channel.inbox` 返回收到消息（本地持久化，最多 500 条）。
- `rsi.*`：E 实现；`rsi.run` 同步执行有界评估（<=10 候选 × <=20 用例），写 `rsiRun`/`strategy` 记录；`rsi.review` 置 review；`rsi.promote` 激活 strategy 需 `confirm:true`；`rsi.rollback` 恢复上一版本；每个策略带 metrics 与版本。
- `doctor.run`：汇总 python/worker/daemon/db/provider/mcp/channels/skills/disk/installer 检查项 `{checks:[{id,status:'ok'|'warn'|'fail',detail}]}`。
- `worker.health` / `worker.describe`：A 的 WorkerClient。
- `defaults.get/set`：`{maxTokens?, budgetCalls?, budgetCost?, compactionWarn?, compactionForce?, concurrency?}` 存 preferences.json（原子写）。

## 5. UI 契约（C）

- 仅通过 `window.suwen.call(method, params)` 访问后端；所有方法必须出现在 `actions.json`（生成 ui-action-coverage.csv 的唯一来源）。
- 五页保持不变：chat/projects/tasks/tools/settings；新增面板：
  - chat：会话列表（project 过滤）、证据面板、上下文压缩预览/版本、模式 radio（auto/chat/research/debate/autonomy）、取消/暂停/恢复/重试。
  - projects：项目 CRUD、项目详情（会话/证据/假设/实验/研究图）、导入向导（inspect→apply→jobs→rollback）。
  - tasks：任务列表+筛选、任务详情（步骤 DAG/状态/事件/检查点/工件/审批按钮/成本/token/暂停恢复取消）、research 快捷入口。
  - tools：MCP 服务器表（增删/启停/健康/工具列表）、Skills 表（inspect/install/enable/disable/test/remove）、Channels（配置/测试/发送/收件箱）、RSI（列表/运行/评审/晋升/回滚/active）。
  - settings：模型配置、默认预算/压缩阈值、诊断（doctor）、worker 健康、数据/日志目录、支持包、重启/关闭后台。
- 中英双语必须覆盖所有新增文案；不得 innerHTML 注入未信任文本（用 textContent）；所有按钮有 loading/disabled/错误反馈；无空按钮、无假进度。
- CSP 不得放宽（`connect-src 'none'`）。
- UI QA：`node --check desktop/ui/app.js` + `node desktop/scripts/ui-dom-qa.mjs`（无 Electron 时用 jsdom 不可用，则用 Electron smoke 覆盖；至少输出每个 action 的静态可达性报告）。

## 6. 测试与验证命令

- 全量（Lead）：`cd desktop && npm test`（tsc + node --test dist/test/*.test.js）。
- 单人（不写共享 dist）：`npx tsc -p tsconfig.json --outDir dist-<name>` 然后 `node --test dist-<name>/test/<你的测试>.test.js`。禁止在别人可能正在写文件时运行全量 `npm test`；若因他人文件暂时编译失败，等待并在最终消息报告。
- 禁止 mock 声称通过：单元测试可用本地 HTTP fixture（127.0.0.1 随机端口）与注入的 fake Provider/Worker；**关键验收路径必须有真实调用**（真实 Python worker、真实 MCP 子进程、真实 Electron smoke、本地 fixture provider 走完整 provider 代码路径）。
- 测试不得访问公网（PubMed 等外网调用仅 Lead 手工验证并记录证据）。

## 7. 纪律

- 只改自己作用域文件；不删除既有测试；不 suppress 失败；不写 stub/TODO 冒充完成。无法完成时在最终消息给出精确阻塞与已实现部分。
- 每个模块必须可编译、测试通过，并在 `docs/progress.md` 由 Lead 汇总；队友不要改 progress.md。
- 品牌：新代码/UI/文案不得出现旧品牌（OmicLab 等），仅历史迁移兼容代码可读取旧标识并注释 `LEGACY-BRAND-COMPAT`。
