# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)：`主版本.次版本.修订号`。

## [1.0.0] — 2026-10-30

Eve 正式发布版，作为后续公开版本的统一基线。

- 科研交付：接入并通过校验的 CNS/Sci 写作与绘图技能，覆盖论文写作、投稿模板、引文管理、同行评审、出版级图表和多面板示意。
- 技能调用：保留按需检索、依赖闭包与执行反馈；新增技能默认停用，避免全量注入和技能库无序膨胀。
- 公共数据：UniProt 主接口异常时提供有界 EBI Proteins 回退，并保留来源与失败原因；PubMed 继续支持 Europe PMC 到 NCBI 的回退。
- 界面：统一中性灰、单一强调色和语义状态色；压缩聊天气泡与空行；原始 JSON、工具参数和长输出默认折叠为摘要。
- 安装器：自绘安装与卸载页面，统一品牌、排版和按钮；支持“仅为我”和“所有用户”两种范围，不展示管理员概念。
- 稳定性：安装路径在普通实例和提权实例双重校验，拒绝相对路径、UNC、目录穿越和越界 Program Files 路径。
- 安全与发布：补充依赖审计、秘密扫描、SBOM、安装器生命周期与打包后冒烟验收。
- 最终回归：Python 911 passed / 2 skipped；桌面 266 passed / 1 skipped；真实 Edge 10/10；打包态实时数据库 smoke 11/11。
- 验收记录：[Eve 1.0.0](docs/verification/eve-1.0.0-release/README.md)。

## [1.5.0] — 2026-10-30

- 固定接入 K-Dense-AI/scientific-agent-skills 提交 `5f2bc0341354fd5590aef76a533ada1e1e5b4e62`：共享技能库现为 390 项、11 个来源，其中 K-Dense 175 项；`deepspot-m`、`rowan` 因上游再分发限制不收录。
- 新增 `wet-lab-experiment-design`、`classic-cell-and-molecular-assays`、`wet-lab-result-interpretation`，覆盖独立生物学单位、对照、随机化、盲法、样本量、QC、细胞/分子 assay、原始读数与证据分级。
- 新增确定性湿实验脚本，支持细胞活力、qPCR ΔΔCt、Western blot 归一化和 ELISA 标准曲线；缺失值不填补、标准曲线不外推、技术重复不冒充生物学重复。
- 湿实验技能接入科学工作台 `experiment` 流程、技能依赖闭包、检索同义词和 Agent 提示词；新增 sample size、实验记录、实验室自动化、细胞图像和方法验证的中英文检索入口。
- 桌面界面补齐动态版本号、按钮并发忙碌状态保护、Toast 与确认弹窗退出动画、焦点恢复、悬停能力检测、按压反馈、聊天空白行压缩和减少动画支持；Web 工作台移除残留紫色渐变，统一单一强调色和中性灰表面。
- Windows 安装与卸载器改为与主程序一致的 620×450 自绘六页界面：统一顶栏、品牌标识、中性灰表面、`#3157D5` 主操作、圆角卡片和中文排版，隐藏标准 MUI 页面与 Back/Next/Cancel 原生按钮；保留逐用户安装、路径校验、安装后启动和数据保留卸载。
- 新增湿实验、K-Dense 来源和技能副本漂移测试；完整截图、测试、安装包与未验证边界见 [1.5.0 报告](docs/verification/wet-lab-1.5.0/README.md) 和 [湿实验技能说明](docs/WET-LAB-SKILLS.md)。

## [1.4.0] — 2026-10-29

- 新增「文献雷达」：后台日循环扫描 Europe PMC、OpenAlex、bioRxiv 与 arXiv，支持研究/综述分类、先验工作接地的新颖性评分、跨学科桥接权重、用户 PDF 投喂、朋友圈评论与待审反思。
- 新增依赖感知技能图与执行反馈边权：新文献方法先成为孤立技能候选，不进入主检索入口；只有经过真实使用证据和人工确认后才能建立连接。
- 新增 `literature.embedding`、`literature.extraction`、`reflection.reasoning` 等辅助模型任务标签；未配置时回退到角色模型或主模型，不改变原模型配置接口。
- 做梦与文献反思共用待审核候选流；主动分享受每日额度、冷却和时效约束，关闭或延期不会把有效消息误标为过期。
- 公共生物医学数据按 Collector → Evaluator → Curator 封装为 `science-public-biomedical-data`，并修正科学工作台全部失效技能引用。
- 统一 11 级中性色、单一蓝色强调色与语义色令牌；开局弹窗改为单一主操作、默认勾选“下次不再提示”，并压缩营销式说明文案。
- 研究总览增加文献指标；文献页在桌面与移动端通过真实 Edge 回归，PDF 投喂反馈可持久显示，路径校验拒绝 junction/reparse point 越界。

## [1.3.0] — 2026-10-29

- 新增默认「研究总览」首页，汇总进行中的科研愿望、运行任务、最近会话、Token 与耗时趋势、课题进度、后续计划和待确认经验建议；所有入口复用既有工作流，不建立第二套调度器。
- 新增用户主动开启的「做梦与经验整理」设置页。Eve 只读取当前工作区脱敏后的会话、记忆和科研项目，候选必须经 Sage 证据门禁与用户逐条确认；生成的技能保持停用，后续课题保持未启动。
- 新增公共生物医学数据采集技能，按 Collector → Evaluator → Curator 记录检索、质量评分、字段规约与标准化步骤，并接入许愿式科研。
- 接入 Emil Kowalski 前端技能包；设置页支持按模型配置温度、上下文窗口、最大输出、Token 参数和输入模态，权限默认全部开放且可逐项覆盖。
- 开局弹窗收敛为单一主操作，并允许用户选择“下次不再提示”；空状态和欢迎提示改为可执行示例。
- 修复科研愿望失败节点重试竞态，增加研究总览、经验整理门禁、技能导入和响应式界面的真实回归测试。

## [1.2.0] — 2026-10-29

- 新增许愿式科研项目：一句愿望建立持久工作区，按章程、侦察、证据矩阵、可证伪假设、预注册、分析/实验设计、图表和人工复核推进。
- 智能体获得 `wish_status`、`wish_start`、`wish_update`、`wish_record`、`wish_block` 工具；真实产物按当前愿望与阶段目录校验并计算 SHA-256，模型不能代替用户结题。
- 界面支持同一 durable run 内连续推进；旧运行失败后可安全重试，运行中节点不可重复启动，未解决阻塞项阻止继续登记。
- 新增「科研与证据 → 许愿式科研」页面、真实 Edge 响应式验收与实现边界说明。许愿状态复用 `RunService`，没有第二套调度器。
- 完整接口、恢复规则和验证边界见 [许愿式科研](docs/WISH-RESEARCH.md) 与 [1.2.0 验收报告](docs/verification/wish-research-1.2.0/README.md)。

## [1.1.0] — 2026-10-29

- 智能体按任务需要自主提出团队草稿；用户消息只向已批准成员下发，成员按依赖执行，讨论和结果回传队长，不再提供强制组队选择器。
- 侧边栏展示子智能体状态与待批准方案；批准后才创建持久成员会话，用户可打开成员会话继续对话。
- RSI 三层能力接入智能体提示与真实工具：科研发现、结构化策略评估、Proteus 冻结源码副本实验。晋升与实验调度保留确认和回归门禁。
- 科研脚本支持输出文件回读与哈希、新鲜度验证；引物和载体校验进入按需执行技能库。
- 图表预览、批注和局部修改入口移入受控侧栏；终端输出合并、背压和解析后确认。
- 发布核验与边界见 [本轮报告](docs/verification/platform-upgrade/README.md)。

## [1.0.0] — 2026-10-26

- RSI 能力在智能体提示词中明确固化（`omicslab/agent/context.py`、桌面 `SYSTEM_PROMPT`）：科研发现闭环、桌面策略调参、Proteus 源码副本进化三类边界分离；仅配置调参允许智能体直接执行，科研证据与实验进化必须人工确认。完整说明见 [RSI 能力与边界](docs/RSI.md)。

- 2026-10-27 修复旧界面重现：正常入口只打开正式工作台；诊断控制台限隔离测试配置，测试启动时隐藏。后台复用同时核对构建内容与代码路径，同版本更新也能加载新资源；暂停任务保留。
- 修复升级用户配置中的旧 Python 依赖被后台重新注入的问题。工作台按解释器版本与依赖校验结果选择环境，历史目录保持原样。
- 提供商→模型二级菜单、统一权限/角色选择、指令定位与运行中引导按浅色扁平风格统一；加入 MinerU 参考技能和技能检索/元数据缓存。当前结果见 [本轮验收](docs/verification/eve-1.0/UPDATE-20261027.md)。

- 统一本地与 SSH 工作区的文件、搜索、写入、Shell、Python 与 Skill 执行环境；连接失败明确报错，不回退本机。
- 补齐 15 秒 SSH 保活、每主机连接锁、断线重连、密码复用与凭据引用；修复并发探测关闭正在使用连接和远端 worker 路径错误。
- 增加“请求批准 / 帮我审核 / 完全权限”、审批分组、检查点恢复、运行中引导、多会话并行与每会话模型/权限隔离。
- 正式页面使用默认浅色灰阶工作台、单项目/最近会话侧栏、可折叠工具过程和稳定输入区；正常启动只创建一个窗口。
- 能力中心的 MCP 新装、导入、更新、启停与删除同步到唯一桌面 Agent；Skill 支持发现、渐进加载、创建、安装和远程执行。
- 根据 外部项目 1.1.3 发行包的静态逆向边界，移除统一 Harness 的单轮模型/工具次数上限、三次相同调用告警与五次无进展强制终止；重复调用继续执行并把真实结果回传模型，取消、单步超时、回合时长、Token/上下文预算、检查点和恢复继续生效。证据见 [外部项目 1.1.3 逆向记录](docs/verification/clawsgo-1.1.3-rea.md)。
- 固定 22 项 `deepseek-v4.1-flash-economy` 真实任务最终 22/22 通过；完整结果、指标和未验证边界见 [1.0 验收报告](docs/verification/release-1.0/REPORT.md)。

## [3.4.0] — 2026-10-26

- 正式聊天采用折叠工具过程和扁平化气泡；支持工作目录文件访问、8 个预装技能、技能创建/安装及有限截断恢复。
- 验证详情及真实供应商 HTTP 429 限制见 [交付记录](docs/verification/product-340-20261026/README.md)。

## 独立 外部项目 插件 0.3.0

- 外部项目 集成改为原生科研工具与按需技能：由 外部项目 规划、调用模型与协调多代理；`python -m omicslab.integrations.science` 数据计算后端只执行显式操作，不加载 LLM、AppState 或 AgentLoop。
- 仓库 [`integrations/dsh`](integrations/dsh/) bundle 规划十一工具，覆盖状态、文献、蛋白、序列、Python、变量、notebook、证据、实验、知识和技能；[`suwen-research`](integrations/dsh/skills/suwen-research/SKILL.md) 指导数据审计、方法选择、显式分析、证据/指标验证与报告，沿用 [`omicslab/skills`](omicslab/skills/) 原始方法正文。
- 重写 [外部项目 插件集成说明](docs/integrations/dsh-plugin.md) 及中英文入口：使用 `plugin_manager` 安装仓库 bundle，不手工修改 profile；旧九工具 Agent 桥接不再作为推荐。执行成功不等于科学验证，外部内容不可信。
- 落地验证（2026-10-26）：新增 [`tests/test_dsh_science.py`](tests/test_dsh_science.py) 11 项真实子进程测试，与 [`tests/test_dsh_bridge.py`](tests/test_dsh_bridge.py)、[`tests/test_cli.py`](tests/test_cli.py) 合计 **44 passed**。bundle 0.3.0 已安装（`application: applied`），11 个工具注册并经真实调用验证（状态、序列检查、Python 与变量、知识、实验、证据核验、notebook 导出、技能目录与正文、Europe PMC 文献、UniProt 蛋白）。完整科研任务与干净虚拟机验证未执行，详见集成说明「验证记录」。
- 修复：Host 插件 `inject` 改为服务数组形式 `export const inject = ['tools']`（原对象形式导致行挂起、工具未激活）；UniProt 蛋白名为嵌套对象，渲染层扁平化为推荐名并补基因列。
- 本清理源码的桌面版本为 **3.4.0**，Python 工作台包版本为 **2.1.1**；本节描述独立 外部项目 插件，并不表示该插件已进入已验收的桌面安装包。

## [2.1.1] — 2026-10-24

- 消息渠道改为引导式连接：微信 iLink 扫码、过期刷新、手机验证码、本人私聊文字接收与可选回复；Telegram 使用凭据表单和真实认证测试。

- 工具执行前强制检查精确重复、并发重复、循环序列与输出停滞；拒绝作为工具结果返回，允许选择替代路径。
- 模型流在写入轨迹前合并可读块，增加推理退化、空闲、时长与输出长度保护，所有尾块与关闭路径可收尾。
- 每轮自动管理步骤、工具调用与 Token 用量，接近阈值时裁剪工具结果并缩短输出；移除累计费用、额度与迭代次数设置。
- 停止原因写入会话、轨迹与运行记录；受控停止标记为可继续的 interrupted，工作流不把未完成运行当成成功节点。
- 增加缺失目录、恢复策略、退化流与预算边界回归。实现细节见 [自动回合治理](docs/TURN-GOVERNANCE.md)。

## [2.1.0] — 2026-10-24

- 可选 Sage-A1.5 自检请求与结构化并行子任务；继承父任务权限，隔离会话上下文，限制批次、并发与时长。
- 工作流新增独立指标验证节点：读取实际文件，验证失败阻止依赖步骤；支持 JSON 模板校验导入和脱敏导出。
- 新增实验比较：保留指标文件摘要，按同数据集、同协议与同指标排序，始终保留未完成科学复核状态。
- 增加子任务权限继承与取消边界检查，更新中英文文档并保留现有品牌与文档布局。

## [2.0.0] — 2026-10-23

- 正式展示名升级为素问 Suwen，保留 Python 包、旧 API 和旧数据目录。
- 新增模块化 Model Gateway、知识/记忆、MCP、Skills、渠道、持久任务、DAG 与间隔调度。
- 生物工具支持 Europe PMC、UniProt、DNA QC；结论来源与实际数值检查贯穿执行轨迹，未复核结论进入 needs_review。
- 增加配置版本/回滚、DPAPI 凭据、产物快照、诊断与可选 Docker 隔离工具。
- 重做多级设置与各能力页面、工作区布局及明暗主题；修复页面切换后的重复事件绑定。
- 具体能力与尚未实现的子项以 docs/SUWEN-V2-CHECKLIST.md 为准，不宣称完整集成上游科研系统。

## [Suwen 1.3.0] — 2026-10-23

- SSH 档案可直接绑定远程目录作为工作区；文件、变量、控制台与标准 Agent 工具按当前工作区路由。
- 工作台默认入口，统一 Studio 设计变量、明暗主题与 SSH 工作区向导。

## [Suwen 1.2.0] — 2026-10-23

三期版本：把「一次对话」升级为**可恢复的运行**，并让同一套工具既能跑本机、也能跑远端 SSH 工作区。
本版本的核心变化是运行层（run / 事件 / 审批 / 子任务）与执行层（工作区 / 执行后端）的重构，
既有 HTTP/SSE 入口与旧轨迹数据保持兼容。

### 新增

- **持久运行与恢复**：
  - 新增 `omicslab/runtime/events.py`（SQLite，WAL，schema v3）与 `omicslab/runtime/runs.py`（`RunService`）。
    每回合是一个有 `run_id` / `trace_id` 的 run，事件**先落库再广播**；表 `runs` / `events` /
    `agent_tasks` / `approvals`，`events.seq` 自增、`event_id` 唯一。
  - `GET /api/runs/{run_id}/stream?after_seq=N` 断线重放（上限 5000 条，超出提示 `stream_gap`），
    空闲 15 秒发 `heartbeat`；`GET /api/traces/{trace_id}/events` 可回放完整时间线。
  - `client_request_id` 幂等：网络重试不会产生第二个 run；同会话已活跃时返回 409
    `run_in_progress`（带 `run_id`）。进程崩溃/重启后，进行中的 run 对账为 `interrupted`
    （`meta.recovered=true`），不伪装成成功。
  - 新增 `POST /api/sessions/{session_id}/runs`（建 run 但不开 SSE）、`POST /api/runs/{id}/cancel`、
    `POST /api/runs/{id}/messages`（steering，运行中追加用户指示）、`GET /api/sessions/{id}/runs`。
  - `GET /api/runtime/timeline|runs|agent-tasks|diagnostics|config`、`GET /api/agents/default`；
    `PUT /api/runtime/config` 可在线调整并发与子任务上限、审批策略与默认智能体。
- **工作区与内核作用域**：
  - `omicslab/workspace/service.py`：工作区注册表 `home/workspaces.json`（`version: 1`），
    默认 `ws_main`（指向启动工作区，不可删除）；支持本地目录与 SSH 工作区；会话通过
    `meta.workspace_id` 绑定，一个会话只属于一个工作区。
  - `KernelPool`：按作用域（`main` / `ws:<id>` / 子任务 `task:<task_id>`）懒启动内核，
    受 `max_workspace_scopes` 限制；新增 `GET /api/kernels` 与 `/api/kernels/{scope}/start|restart|stop|execute|vars`；
    旧 `/api/kernel/*` 保留并等价于 `main`。
  - 新端点：`GET/POST /api/workspaces`、`GET/DELETE /api/workspaces/{id}`、
    `POST /api/workspaces/{id}/probe`，以及限定在工作区内的
    文件端点 `/api/workspaces/{id}/files/*`（非本地工作区直接拒绝）。
- **统一执行后端**：
  - `omicslab/execution/base.py` 定义 `ExecutionBackend`（内核执行、Shell、文件、上传、变量内省、后台作业）；
    `local.py` 包本机实现；`ssh_backend.py` 用 SFTP + 远端常驻 worker（仅 stdio 的 JSON-lines 协议）执行 Python，
    路径限制在远端 `root` 内。远端不可用时抛 `BackendUnavailable`，**不回退本地**。
  - 工具输出统一携带 `data.execution_target`（`kind` / `root` / `cwd` / `connection_id`），UI 与模型都能看到
    「这条结果来自哪个执行目标」。
- **子智能体与委派**：
  - `delegate_agent` 改为创建**子 run + agent_task**，独立 `trace_id` 与内核作用域，结果结构化返回；
    新增 `GET /api/runs/{run_id}/children`、`GET /api/agent-tasks/{task_id}`、`/agent-tasks/{task_id}/runs`。
  - 并发上限 `max_parallel_runs`（默认 8）、`max_child_tasks`（默认 4）、`max_child_depth`（默认 2）；
    子任务有预算（迭代/时间/token）与结果契约，耗尽标记 `budget_exhausted`；父 run 取消级联取消子树。
- **审批中心**：审批记录持久化到 `approvals` 表，携带 `run_id` / `task_id` / `target`（kind/root/cwd/connection_id）
  与 `expires_at`；新增 `GET /api/approvals?run_id=&status=`、`GET /api/approvals/{id}`、
  `POST /api/approvals/{id}`；新增 `approval_resolved` / `child_run` / `run_status` / `user_message` /
  `heartbeat` / `stream_gap` / `stream_end` SSE 事件。
- **SSH 连接服务与远端执行**：
  - `omicslab/ssh/connections.py` 提供进程内单例 `ConnectionService`：REST、工具、终端与 SSH 执行后端
    共享连接池与凭据；新增 `POST /api/ssh/test`（未保存档案试连）、
    `POST /api/ssh/profiles/{id}/remember`、`GET /api/ssh/diagnostics`；
    `POST /api/ssh/exec` 支持 `cwd` / `timeout_s` / `idempotent`。
  - `omicslab/ssh/credentials.py`：密码默认只在进程内存；「记住密码」交给系统凭据库（keyring），
    无凭据库时退化为仅内存并在界面与 `diagnostics` 明示；`ssh.json` 不存明文密码。
  - 终端 `/ws/terminal` 支持 `profile_id`：用 paramiko `invoke_shell()` 提供远端真 PTY，
    支持 `resize`、Ctrl+C 与诊断帧。
- **证据判定（RSI 硬化）**：新增 `omicslab/discovery/evidence.py` 的 `AnalysisResult` 与
  `EvidenceEvaluator`——统计结论必须经 `discovery_record_analysis_result` 提交结构化数值
  （`data_sha256` / `script_sha256` / 检验方法 / 效应量 / CI / p 与 q 值等），
  只有「执行完成 + 数值合法 + 符合预注册判据」才给出 `supported` / `refuted`，否则 `inconclusive`；
  `evidence.reproducibility` 改为 `none` / `code_recorded` / `rerun_verified` 三级（保留 `reproducible` 布尔兼容视图）。
- **诊断与健康**：`/api/health` 增加 `kernels` / `workspaces_count` / `runs{active,recovered}` /
  `runtime{schema_version,db}`；新增 `GET /api/runtime/diagnostics`（版本、PID、内核、工作区后端、
  最近恢复的 run、日志尾部，脱敏）。
- **前端**（12 个页面）：新增「工作台」页（运行状态条、工作区切换、Results/Files/Variables、
  底部 Compute 面板）；对话页支持断线重连接续传与运行时间线；新增全局审批中心与任务树；
  设置页增加并发/子任务/工作区上限；SSH 页支持临时密码、记住密码、终端与诊断。

### 变更

- `POST /api/chat` 的内部实现改为 `RunService.submit`：首帧 `connected` 现在包含 `run_id` / `trace_id` /
  `workspace` / `idempotent`；`/api/chat/stop` 与 `/api/runs/{id}/cancel` 语义统一
  （先 `stopping`，15 秒内未退出则 `interrupted`）。
- `PUT /api/settings` 不再重建 `Approver` 实例，改为原地 `set_policy`，切换审批策略不会丢失在途审批；
  设置新增 `max_parallel_runs` / `max_child_tasks` / `max_child_depth` / `max_workspace_scopes` 及范围校验。
- 错误响应统一为信封 `{"error": {"message", "code", "detail"}}`；新增错误码
  `run_in_progress` / `run_not_found` / `run_finished` / `workspace_invalid` / `workspace_not_found` /
  `workspace_not_local` / `workspace_delete_refused` / `approval_not_found` / `task_not_found` /
  `invalid_scope` / `invalid_patch` / `invalid_config` / `backend_unavailable` / `remote_unavailable`。
- `GET /api/settings` 的 `providers` 保持 map 结构；`llm` / `vision` 永不 500 的行为延续。
- `/api/trajectories/*` 与 `home/trajectories/**` 保留为**旧版**轨迹：1.2.0 起新运行只写 SQLite，
  旧文件只读兼容；`/api/traces/{trace_id}/events` 提供新的回放入口。
- CLI 版本输出改为 `OmicsLab 1.2.0`。

### 修复

- **SSE 断线后事件丢失/顺序错乱**：改为按 `after_seq` 从事件库重放，前端只追加未见过的 `seq`，
  刷新页面后可恢复到当前运行的真实状态。
- **双击发送产生两个并行运行**：`client_request_id` 唯一索引 + 会话级活跃检查，
  重复请求返回同一个 run（`idempotent=true`）或 409 `run_in_progress`。
- **切换设置页丢审批**：审批器实例不再重建；已发出的 `approval_request` 仍可通过审批中心解决，
  运行取消时自动撤销（`cancel_for_run`）。
- **停止一个会话误伤全局**：取消只作用于本 run + 子树 + 对应工作区内核作用域，
  不再中断其它工作区/其它会话的运行与内核。
- **文本叙述提升证据等级**：发现引擎只把 `discovery_record_analysis_result` 提交的结构化结果
  交给 `EvidenceEvaluator`；报告里的「显著 / 不显著 / p=…」文字不参与判定。
- **SSH 执行失败被悄悄落到本地**：远端不可用统一抛 `BackendUnavailable` 并给出可操作错误，
  绝不回退本地执行，避免结果错配与数据外泄。

### 工程

- 新增 14 个测试文件覆盖 runtime / evidence / terminal / execution_ssh 等新面；`pytest -q` 全绿（357 项）。
- 测试全部离线：LLM 用 `mock` provider；SSH / 远端执行 / 视觉用伪连接与启发式路径；
  **真实 SSH 远端与真实模型调用不在自动化测试范围内**（文档中已标注）。
- 新增 `docs/API.md` §16（运行与恢复）与 §17（工作区与执行后端）、
  `docs/CONTRACTS-3.md`（1.2.0 接口契约）；README / ARCHITECTURE / EXTENDING / COMPARISON / INSTALL 同步到 1.2.0。

### 安全边界

- 运行库 `runtime/events.db` 含会话/运行元数据与工具参数摘要，按会话数据同等保护。
- 非本地工作区的文件端点直接拒绝（`workspace_not_local`）；SSH 工作区的相对路径解析限制在远端 `root` 内。
- SSH 密码默认不落盘；API 永不回传密码/私钥，只返回 `has_password_saved`；
  `diagnostics` 只含连接池计数、凭据后端与最近命令，不含明文。
- 所有设置类端点只返回 `has_key` 布尔值，密钥不进入日志、SSE、会话或运行库。

## [1.1.0] — 2026-10-23

二期版本：从「能对话」升级为「能配置、能看图、能自主发现、能连远程算力」。

### 修复（P0）

- **「配置了 API 却无法调用」**。根因有三层：① 设置页旧逻辑只把 Key 写进
  `auth.json`，`provider` / `model` / `api_base` 仍是旧值（甚至停留在 `auto`），
  后端解析不到可用端点便静默回退到 `mock`；② `GET /api/settings` 内部直接
  `resolve_llm()`，缺 Key 时抛异常导致整个设置页 500，用户看不到任何可操作提示；
  ③ 「测试连接」只检查 Key 是否存在，不真正发请求，失败也无从复现。
  现在：`POST /api/settings/keys` 把 Key、provider、model、api_base **一次性原子保存**；
  `GET /api/settings` 永不 500，缺 Key 时返回 `llm.configured=false` + `llm.error`
  可操作建议；`POST /api/settings/test_llm` 真实发起一次极小对话并返回延迟与回复。
  设置页同步重写：provider 下拉来自后端目录、显示 configured 徽标、选择 provider
  自动填充 base/model、保存后立即回测并刷新聊天页模型提示。
- 显式 `api_base` 的 provider 不再被旧地址串用：切换 provider 且未给 model 时
  `model="auto"`，非自定义 provider 且未给 api_base 时清空旧 base。
- 自定义端点错误提示更可操作：识别 `ark-...` 形态的 Key 并提示直接选择
  「火山方舟」，CUSTOM_OPENAI/CUSTOM_ANTHROPIC 缺 API 地址时给出逐项修复指引。

### 新增

- **火山方舟（Volcengine Ark）Provider**：OpenAI 兼容协议，预置
  `https://ark.cn-beijing.volces.com/api/v3`，支持 `ARK_API_KEY` /
  `VOLCENGINE_API_KEY`，`needs_model=true` 时提示填写推理接入点 ID（`ep-...`）或模型名。
- **视觉模型**：`omicslab/agent/vision.py`（OpenAI 兼容 `image_url` 与 Anthropic
  `image` 两种协议，≤12MB，按扩展名映射 MIME）；设置页视觉卡片；`analyze_image`
  工具（工作区相对路径或图库文件名）；`POST /api/settings/vision` 保存、
  `POST /api/settings/test_vision` 用内置 32×32 PNG 真实回测；`/api/health`
  同时报告 `vision.configured`。
- **RSI 科研发现引擎**（`omicslab/discovery/**`）：观察 → 假设 → 优先级（UCB1 策略选择）
  → 预注册检验 → 真实内核执行 → 证据分级/评审 → 反思与策略进化，7 步闭环；
  账本落盘为 JSONL（`project.json` / `hypotheses.jsonl` / `evidence.jsonl` /
  `insights.jsonl` / `rounds.jsonl` / `strategies.json` / `report.md`）；
  `/api/discovery/*` 提供项目 CRUD、SSE 运行流、报告、停止、删除；
  `discovery_*` 6 个工具；CLI `python -m omicslab discovery ...`；
  无真实 LLM 时以启发式模式运行，不崩溃、不造假数据。
- **函数注册表**（`omicslab/registry/**`）：用内核解释器在子进程内省 numpy / pandas /
  scipy / sklearn / statsmodels / matplotlib / seaborn / scanpy / anndata / omicverse /
  lifelines / gseapy / pydeseq2 / flowio / flowkit / rdkit / squidpy / harmonypy /
  biopython / plotly / networkx / umap / leidenalg 的公开函数与类，
  生成可搜索索引（`home/registry/index.json`）；`/api/registry/*` 提供搜索、模块、
  详情、重建索引 4 个端点；`registry_lookup` 工具。
- **轨迹记录**（`omicslab/trajectories.py`）：每个对话回合写
  `home/trajectories/<conversation_id>/<turn_id>.jsonl`（meta + 事件 + done）；
  `/api/trajectories/*` 支持列表、回放、删除；记录失败不影响主流程。
- **SSH 远程算力**（`omicslab/ssh/**`）：paramiko 连接池、档案 CRUD、
  连通性测试（首次记录主机指纹、变化时给中文警告）、命令执行、SFTP 上传/下载、
  目录浏览、远端系统信息；`/api/ssh/*` 10 个端点和 `ssh_*` 5 个工具
  （`ssh_exec` / `ssh_upload` 需审批）；密码默认不落盘，API 永不含密码与私钥内容；
  上传/下载上限 200MB。
- **前端二期**：设置页重写与视觉卡片；新增「发现」「函数库」「SSH」三个页面；
  聊天图片附件（选择/粘贴/拖拽）上传后随消息发送；侧栏导航扩展到 11 项；
  命令面板与路由自动覆盖新页面。
- **内容**：新增 6 个智能体（`discovery-lead`、`hypothesis-smith`、
  `experiment-designer`、`evidence-critic`、`research-strategist`、
  `remote-compute-engineer`）与 8 个技能（`rsi-discovery-loop`、
  `hypothesis-generation`、`experimental-design`、`statistical-rigor`、
  `causal-inference`、`remote-compute-ssh`、`function-registry`、
  `vision-interpretation`）。

### 变更

- `GET /api/settings` 的 `providers` 由数组改为 **以 provider id 为键的 map**，
  单个对象新增 `needs_api_base` / `needs_model` / `hint` 字段；旧前端需同步升级。
- `POST /api/settings/keys` 请求体扩展为 `{key, provider, model, api_base,
  keys, vision_api_key}`，返回新增 `settings` / `llm` / `vision`；
  兼容旧的 `{"DEEPSEEK_API_KEY": "..."}` 扁平写法。
- `POST /api/settings/test_llm` 支持内联传入**尚未保存**的
  `provider` / `model` / `api_base` / `api_key`，返回新增 `provider` / `model`。
- `GET /api/health` 新增 `llm.error` 与 `vision` 字段；`version` 升至 `1.1.0`。
- 工具总数 17 → **30**，新增 toolset：`discovery` / `registry` / `ssh` / `vision`。
- 技能 10 → **18**，智能体 7 → **13**；新增页面 3 个（发现 / 函数库 / SSH）。
- 运行依赖新增 `paramiko>=3.4`（SSH 子系统）；数据目录新增
  `discovery/`、`registry/`、`tmp/`。
- `pyproject.toml`、`omicslab/__init__.py`、服务端版本回退值同步为 `1.1.0`。

### 工程

- 新增测试覆盖设置原子保存与内联测试、视觉客户端与工具、发现引擎与账本、
  函数索引、轨迹、SSH（伪连接）、前端契约字段；全部测试离线运行、使用 mock 模型。
- `scripts/smoke.py` 与发布脚本继续可用；产物名随版本变为 `omicslab-1.1.0*`。

### 安全边界

- 设置页与 API 只回传 `has_key` / `has_password_saved` 布尔值，明文 Key、
  SSH 密码与私钥内容永不出现在响应、日志与会话文件中。
- SSH 档案密码默认不落盘；勾选「记住密码」时以 base64 混淆存储并在 UI 警示
  （不是加密，仅避免明文肩窥）。
- 远程命令执行与上传需按审批策略确认；服务仍只监听 `127.0.0.1`，无内置登录。

## [1.0.0] — 2026-10-22

首个公开版本：本地优先、可扩展的生物医学分析工作台。

### 功能

- **对话式分析**：流式回复、工具调用卡片、图片内联、停止/重发、SSE 断线重连、
  `Ctrl/Cmd+Enter` 发送、`Ctrl/Cmd+K` 命令面板。
- **常驻 Python 内核**：Jupyter 内核复用变量与 import；实时变量表（shape/dtype/head/describe）；
  matplotlib 内联图自动入库；一键导出 `.ipynb`；超时/中断/重启。
- **工作区文件**：目录树、文本/CSV/图片预览、上传（含拖拽）、下载、新建目录、编辑。
- **图表画廊**：自动收集内核产生的图片，缩略图/灯箱/下载/删除。
- **后台任务**：长任务提交、日志增量轮询、取消、退出码。
- **技能库**：10 个内置技能（单细胞上游/下游、空间转录组、流式细胞术、bulk 转录组、
  CADD 化学信息学、GEO 公共数据、绘图风格、报告撰写、Notebook 运维），运行时可查看与调用。
- **智能体**：7 个内置智能体（总控、单细胞、空间、流式、绘图、报告、数据评审），
  `delegate_agent` 支持子任务委派。
- **记忆**：跨会话的 Markdown 记忆条目，可编辑/删除。
- **多模型**：DeepSeek / OpenAI / Anthropic / 通义千问 / 智谱 / Moonshot / Ollama /
  OpenRouter / SiliconFlow / Google / 自定义 OpenAI 兼容端点；无 key 时可用 `mock` 演示。
- **前端零构建**：原生 HTML/CSS/ES Modules，由服务端直接托管，深浅主题、可拖拽分栏、响应式。
- **内置终端（可选）**：WebSocket 桥接本机 shell，无额外 Python 依赖。
- **CLI**：`serve` / `cli` / `env` / `doctor` / `config` / `skills` / `agents`。

### 工程

- Apache-2.0 许可；测试覆盖工具、会话、REST/SSE、技能与 CLI（离线、mock 模型）。
- 发布脚本：`scripts/publish.ps1` / `publish.sh` 生成 sdist + wheel + `SHA256SUMS.txt`；
  `scripts/smoke.py` 端到端冒烟；`scripts/check_dist.py` 校验产物内容。
- `pyproject.toml`：`bio`（scanpy 等）与 `dev`（pytest）可选依赖；纯 Python wheel。

### 安全边界

- 服务默认只监听 `127.0.0.1`，**没有内置登录**，不要暴露到公网或共享网络。
- 文件工具限制在工作区目录内；终端与 `run_shell` 等价于本机 shell，仅在可信环境使用。
# 1.3.0 — SSH workspaces and Studio UI

- Open a saved SSH connection and remote directory as a workspace.
- Route workspace files, Python console, variables, standard agent tools, figures and jobs to SSH.
- Reuse the remote worker across console and agent runs; preserve code history for notebook export.
- Validate remote roots, expand SFTP home paths, reject unknown workspace IDs and protect workspace-root deletion.
- Add a unified Studio theme, styled native controls and visible keyboard focus; move approvals into navigation.
- Add remote workspace integration coverage. See `docs/UPGRADE-1.3.md` for usage and verification limits.

