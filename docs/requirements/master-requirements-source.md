# Master Requirement Register (source of truth for `master-requirements.csv`)

本文件由 Lead 从用户 2026-10-25 指令中提取唯一需求 ID。D 负责按本表生成
`docs/requirements/master-requirements.csv`，每条必须绑定代码路径、验证方式、测试 ID 与真实状态：
`IMPLEMENTED_PASS | BLOCKED_EXTERNAL | FAIL | NOT_STARTED`。只有 `IMPLEMENTED_PASS` 计入完成。
禁止把“已记录/已设计/被阻塞”写成通过。

| ID | 需求（不可删减） |
|---|---|
| R001 | 只读审计并复制 SOURCE_ROOT 至 TARGET_ROOT（唯一工作区），源目录零改动，记录 source-inventory 与 copy-verification |
| R002 | TARGET_ROOT 标注为 vNext 唯一开发工作区（README），所有命令/产物以此为基准 |
| R003 | 复制清单/哈希抽样、git 状态与 commit 校对、源前后一致性证据 |
| R010 | Python 旧版全功能现场审计（入口/页面/配置/供应商/会话/项目/文件/Prompt/Agent/规划/MCP/Skills/科研工具/分析/记忆/压缩/嵌入/视觉/渠道/审批/安全/诊断/导入导出/安装升级）→ python-feature-inventory.md |
| R011 | feature-parity-matrix.csv + .md：Python 旧版 / Desktop 原型 / vNext 三列，含复用方式、数据迁移、priority、test_id、status、evidence、gaps；不得有未处理缺失 |
| R012 | 可逆、版本化、可重复执行的 legacy 数据迁移工具（模型配置/数据库/会话/项目/技能/文件引用/实验产物），保留来源 hash 时间；不自动覆盖用户数据；测试升级/回退/重复导入去重 |
| R013 | Python 科研计算封装为独立受管 Python Research Worker + 类型化 RPC/MCP；不维护第二套主 Agent Loop |
| R014 | 旧 Python 工作台隔离兼容访问（独立进程/凭据/home，不复制用户凭据） |
| R020 | 五工作区 UI：对话/科研项目/任务执行/工具技能/设置诊断；窄导航+列表+中央时间线+右侧按需面板 |
| R021 | 稳定聊天：流式节流、虚拟化/增量渲染、持久滚动位置、错误恢复、输入框不抖动、长会话稳定 |
| R022 | 统一 Agent 入口 Chat/Act/Research/Debate/Autonomous，自动路由+手动覆盖，停止/暂停/恢复/重试 |
| R023 | 工具调用可折叠、日志可展开、高风险动作逐步批准 |
| R024 | 中英双语，全新增文案覆盖；新品牌仅 SuWen/素问 |
| R025 | 任务执行面板：DAG/事件/检查点/成本/token/恢复/审批/诊断 |
| R026 | 右侧证据/文件/工件/任务进度面板，可关闭不遮挡主输入 |
| R030 | Electron 安全：contextIsolation、sandbox、nodeIntegration=false、CSP、IPC schema+sender 校验、路径白名单、外链检查、权限拒绝 |
| R031 | 独立 Harness Daemon（不依赖 renderer 生命周期）+ 当前用户鉴权 localhost IPC（命名管道） |
| R032 | Windows 用户级后台常驻/登录恢复；Windows Service 仅明确授权可选，UI 如实显示模式 |
| R033 | SQLite WAL/FULL/FK/busy_timeout；配置/日志在用户数据目录；schema version+迁移前备份+崩溃恢复检查 |
| R034 | 状态机/DAG/lease+fencing+heartbeat/reclaim/durable timer/waiting_approval 持久等待/CAS |
| R035 | 幂等 operation_id/outbox/副作用去重；未知外部结果转 reconciliation，禁止盲目重放 |
| R036 | 原子检查点（任务 DAG+context 引用+artifacts+config hash+预算），多版本恢复，大对象工件化+SHA256 |
| R037 | 资源预算（wall/time/token/费用/并发/CPU/内存/磁盘）、取消传播、限速、重试+jitter+上限 |
| R038 | 可观测性：run/step/trace id、心跳、耗时/成本/重试、worker 健康、脱敏日志、支持包导出 |
| R039 | 抽象 DurableWorkflowEngine（本地 SQLite 实现，远程 Temporal 可选接口）；Redis/BullMQ 不替代业务幂等 |
| R040 | ContextManager/CompactionService 独立于 UI/供应商；真实 token 预算（消息+系统+工具 schema+工具输出） |
| R041 | 两级压缩：约 65–75% 建议压缩、80–85% 强制压缩，可配置；支持手动压缩/大工具输出即时压缩 |
| R042 | 记忆分层：不可变原始事件日志、逐字窗口、任务摘要、项目事实、按需检索归档；摘要不替代原始记录 |
| R043 | 结构化摘要覆盖：目标/约束禁忌/假设证据来源/完成步骤与产物路径哈希/未完成 DAG/决策审批/权限/环境/失败重试/待澄清 |
| R044 | 摘要覆盖度与一致性校验、来源指针/hash/版本/token 统计/压缩比/前后差异；失败保留原上下文不回写幻觉 |
| R045 | 工具输出工件化+定位符检索；子 Agent 局部工作记忆+共享项目事实，禁止全量广播 |
| R046 | 压缩不重写科研结论；设置页开关/阈值/预览/历史版本/恢复/统计 |
| R047 | 压缩测试：100k+ token、>=10 轮、混合长工具输出、断点重启后目标/约束/证据保留；报告降幅与保留率 |
| R050 | 8/24/72h 真实故障注入（renderer/main/daemon/worker 崩溃、断网、429/5xx、磁盘满、睡眠、重启）与恢复证据；未实测必须标注未验证 |
| R051 | Knowledge：文献/数据库广检索与证据综合，保留引用/时间/可靠性/相反证据/空白；Edison 适配器可选未配置不启用 |
| R052 | Hypothesis：生成/反思/排序/进化/邻近/meta-review 角色、去重、终止准则、人工选择、可复现假设池 |
| R053 | Methods：Paper2Agent（MIT）把论文/仓库转为可测试 MCP/Skill，输出代码/测试/环境锁定/样例/偏差/许可证 |
| R054 | Analysis：隔离 Python Worker 按需 Biomni；候选生成→沙箱执行→真实指标评分→修订；保存环境/脚本/种子/数据版本；禁止泄漏 |
| R055 | Discovery：假设→实验设计→人工审批→真实结果导入→分析→反馈→机制检验；模拟与真实显著区分 |
| R056 | Autonomy：可恢复研究图/DAG/世界模型/里程碑/预算/证据/失败状态；高风险不自动越权 |
| R057 | Knowledge/Hypothesis/Debate 结果形成可审计证据链（来源/时间/模型/配置/哈希） |
| R060 | MCP Registry：stdio/HTTP 导入、发现、健康检查、凭据、按项目启用、权限、超时、错误诊断、schema 缓存 |
| R061 | Skill Registry：SKILL.md/版本/来源/许可证/依赖/沙箱权限/测试/更新/禁用/卸载 |
| R062 | GitHub 导入需用户确认，静态检查+隔离测试后启用；禁止任意仓库脚本静默自动执行 |
| R063 | 科研数据库：PubMed/PMC/EuropePMC/HGNC/Ensembl/NCBI Gene/UniProt/STRING/BioGRID/Open Targets/ChEMBL/PubChem/ClinicalTrials/WikiPathways 等；至少 PubMed+一个基因/蛋白库真实调用；响应附来源 ID/查询/时间/版本与许可审查 |
| R064 | RSI 受约束循环 Observe→Diagnose→Propose→Sandbox Test→Benchmark→Review→Canary→Promote/Rollback；同评估集；回归回滚；版本与审计；源码变更需分支/测试/人工批准 |
| R070 | 统一 ChannelAdapter（connect/disconnect/send/receive/auth/health/capabilities）；Telegram/Slack/Discord/邮件/Webhook/微信官方接口；配置/映射/过滤/权限/审计/测试/告警 |
| R071 | 远程渠道默认只读；文件修改/shell/敏感数据需额外授权；不绕过平台限制 |
| R080 | 外部项目 官方仓库审计（commit/LICENSE/NOTICES/插件生命周期/Agent Loop/持久化/压缩/安全/构建）+ 复用三选一决策 + feature-provenance-matrix + upstream-commits；不得把第三方同名仓库当官方 |
| R081 | 仅分析许可合规开源；不对已取消 外部项目 安装包逆向/黑盒/集成；不复制专有代码/UI/商标 |
| R090 | 品牌清理：UI/标题/包名/安装文件/应用标识/文档/图标/自动更新/路径/日志仅 SuWen；历史数据字段/迁移标识保留兼容读取，非破坏迁移 |
| R091 | 遗留品牌全局扫描+例外清单（`LEGACY-BRAND-COMPAT` 注释） |
| R092 | MIT LICENSE/NOTICE/third-party-licenses/SBOM/依赖清单/许可证扫描；Apache-2.0 等保留原版权与 NOTICE |
| R093 | 凭据安全存储（Electron safeStorage/系统凭据），不进普通日志/JSON/安装包 |
| R094 | 供应链检查（固定版本/哈希/签名/依赖扫描）；下载执行代码需权限提示；危险命令默认禁用 |
| R100 | Windows x64 NSIS 安装包真实产出 + SHA256SUMS + 安装/启动/升级/卸载验证（干净 Windows 环境；不可得则声明局限并提交可运行 CI） |
| R101 | Python 可选独立运行时引导（首次安装显示大小/联网/许可），无 Python 时基础聊天/MCP 可用+诊断提示 |
| R102 | 升级迁移数据库并备份；卸载默认保留用户数据，可选清除 |
| R103 | 无代码签名证书时如实报告 SmartScreen 风险，不伪造已签名 |
| R110 | 验收：多轮对话/取消/恢复/超长历史/输入框稳定 |
| R111 | 至少两种模型供应商适配器验证，错误可见（外部账号不可得则本地真实 HTTP fixture+明确阻塞） |
| R112 | MCP：PubMed+一个基因/蛋白库端到端真实调用成功，返回引用来源 |
| R113 | Skill：Paper2Agent 安装/发现/禁用 + 公开论文仓库构造工具测试 |
| R114 | Analysis：沙箱执行公开样例数据，输出版本与可复现脚本 |
| R115 | Debate：多 Agent 提案/批判/修正/总结可审计 |
| R116 | 长程：关闭 UI 后 Daemon 继续；Daemon/Python worker 崩溃与 Windows 重启后从检查点恢复；租约回收/幂等/状态可见 |
| R117 | Compaction：多次压缩/超长工具结果/重启后保留目标/证据/引用/状态/安全约束，版本与回滚 |
| R118 | 安全：拒绝未授权 Shell/文件操作；敏感配置不泄露 |
| R119 | Release：干净 Windows 安装/启动/升级/卸载通过，安装包存在且 SHA256 可核验 |
| R120 | 机器可读报告齐备：master-requirements.csv、feature-parity-matrix.csv、ui-action-coverage.csv、integration-and-e2e.md、durability-chaos-tests.md、third-party-dependencies.md、windows-installer-verification.md、progress.md |
| R121 | 最终交付：目录结构、关键功能演示路径、安装包真实路径/SHA256、测试命令与结果、覆盖率、未解决阻塞、parity 证据、回滚说明 |
