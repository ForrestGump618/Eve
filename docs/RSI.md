# RSI 能力与边界

本文描述 Eve 中“受控自我改进”（Recursive/Scientific Self-Improvement，RSI）的三类能力、智能体应如何掌握它们，以及哪些行为被明确禁止。文中每一项能力都有独立边界；把同一名称下的能力混为一谈，会导致越过权限或虚构结论。

## 1. 三类能力总览

| 能力 | 入口 | 作用对象 | 改动生效位置 | 晋升/上线条件 |
| --- | --- | --- | --- | --- |
| 科研发现闭环 | `rsi-discovery-loop` 技能、`discovery_*` 工具、`discovery-lead` 智能体 | 工作区内的假设、证据、策略账本 | 仅当前工作区的账本与报告 | 证据分级 + 独立复核 + 人工确认 |
| 桌面策略调参 | 「工具 → RSI 自我改进」 | routing、prompt、skill、tool-selection、test-coverage 五类结构化策略 | 同一数据库中的策略版本 | `rsi.review` 后显式 `confirm:true` 晋升，可回滚 |
| 源码副本进化 | 「自我改进」实验页 + `omicslab/evolution` | 独立冻结源码副本中的指令、技能、Python 工具 | 只写入实验快照，不触碰当前安装 | Proteus 回归门禁通过，且始终不替换当前安装 |

## 2. 科研发现闭环（Research-Scientist-in-the-loop）

这是面向“开放科学问题”的 RSI：用户给出目标/数据/领域，而不是一次具体分析。

标准流程：

1. `discovery_create_project(...)` 建立项目账本。
2. `list_files` / `read_file` / `run_python_code` 观察数据；`skill_view("rsi-discovery-loop")` 读取闭环规范。
3. 引擎或子智能体生成 2–4 条可证伪假设。
4. 排序并用 UCB1 选择策略（`0.35*novelty + 0.25*feasibility + 0.20*impact + 0.20*strategy_prior`）。
5. **先预注册** success_criteria、统计方法、校正族、样本排除规则，再执行。
6. 真实代码执行并记录种子、参数、包版本。
7. 证据分级：`strong / moderate / weak`，负结果保留为 `refuted`。
8. 反思、策略变异进入下一轮。

智能体必须掌握：

- 先建项目再跑多轮发现；单轮单次分析不能冒充发现闭环。
- 判据必须先于结果写入账本；执行后改判据是 p-hacking。
- 只有真正调用 `discovery_run` 并读取 `discovery_status`，才能说“跑过引擎”。
- 模型共识、视觉模型意见、mock 结果都不是科研证据。

相关实体：`omicslab/skills/rsi-discovery-loop/SKILL.md`、`omicslab/agents/discovery-lead.md`、`omicslab/agents/hypothesis-smith.md`、`omicslab/agents/evidence-critic.md`、`omicslab/agents/research-strategist.md`、`omicslab/discovery/**`。

## 3. 桌面策略调参

桌面 RSI 引擎（`desktop/src/domain/rsi.ts`）只允许调整五类声明式配置：

`routing`、`prompt`、`skill`、`tool-selection`、`test-coverage`。

它不读源码、不写源码、不启动子进程；候选生成使用带种子的确定性随机数，评估经注入的 EvalRunner 在受限用例集上执行。每次运行默认上限为 `MAX_CANDIDATES` 个候选 × `MAX_EVAL_CASES` 个用例（`desktop/src/domain/rsi.ts`），并用 `DEFAULT_THRESHOLDS` 做回归判定。

状态流：

```text
run → review → promote / rollback
```

`rsi.promote` 必须带 `confirm:true`；`rsi.rollback` 恢复上一策略版本。智能体不得把“候选生成了”说成“已生效”，也不得在未运行评估时声称策略有改进。

相关实现：`desktop/src/domain/rsi.ts`、`desktop/src/rsi-evaluation.ts`、`desktop/src/activities/tools.ts`。

## 4. 源码副本进化（Proteus 适配）

`omicslab/evolution` 是可选的本地 Proteus 实验层，依赖 `proteus-evolve==0.4.0`（固定上游 commit `69f766e...`）。完整运行还需要：

- OpenAI-compatible 模型连接（`api_key` + `model`）；
- 当前源码包含基线测试（`test_skills.py`、`test_tools.py`、`test_turn_governance.py`）；
- 用户在「自我改进」页先 `POST /api/evolution/plans` 确认方案，再 `POST /{id}/start` 显式启动。

实验机制：

1. `EveHarness.seed()` 冻结一份源码副本（`src/omicslab/**` + 指令/技能/工具的罗列目录）。
2. Proteus 阶段 worker 只暴露 `list_files` / `read_file` / `write_file`，写入被限制在声明的演进表面（loop、notes、skills、tools、instructions）。
3. 回归测试放在 `.eve-validation`（信任基线），候选在每轮结束时校验：Python 语法编译 + 指定 pytest 门禁 + 文件体积/数量上限。
4. 全程不读取用户凭据文件、不访问 SSH 主机、不启用 shell；模型 key 只经进程环境变量传递，公共轨迹不含模型 prose。
5. 即使实验“通过”，也只表示副本回归通过，**不部署、不替换当前安装**；用户要采用任何产物都必须人工审查后另行落地。

API：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/evolution?scope=ws_main` | 依赖状态、策略、运行列表 |
| POST | `/api/evolution/plans` | 生成待确认方案（仅接受 `goal`） |
| GET | `/api/evolution/{id}` | 单次运行与进度 |
| POST | `/api/evolution/{id}/start` | 确认后启动（必须带 `plan_hash`） |
| POST | `/api/evolution/{id}/stop` | 停止运行 |

Web 入口：侧边栏/视图中的「自我改进」页（`omicslab/web/js/views/evolution.js`）。

## 5. 智能体提示词中的 RSI 条款

### Sage：可选验证增强内核

Sage 属于 RSI 的**验证增强**，不是与发现、调参、副本进化并列的第四类自主改进能力。它只影响兼容模型的验证模板/核验提示，不能代替来源存在性检查、实验复核、RSI 晋升确认或 Proteus 回归门禁。

- 兼容工作台默认 `verification: standard`；可选 `sage` 或 `off`，保留旧 `sage_verification` 配置迁移。
- 只有模型标识匹配兼容的 Sage 模型且设置启用时，网关才传入验证模板参数；其他模型不会伪称启用了 Sage。
- 智能体仍要给出可追溯证据、标注未知和未验证项；Sage 输出不自动构成科学事实。
- Sage 不自行写当前安装源码、不批准团队草稿、不晋升策略，也不部署 Proteus 实验结果。

配置实体：`omicslab/suwen/configuration.py`、`omicslab/suwen/models.py`。桌面系统约束与 Python 智能体规则同步声明该边界。

Eve 的分析负责人和桌面助手系统提示词都固定写入以下约束：

- 科研发现用 `discovery_*` 与 `rsi-discovery-loop`，只迭代工作区账本，不改平台代码；
- 桌面 `rsi.*` 只调参，晋升必须显式确认且可回滚；
- Proteus 进化实验只作用独立副本，须先确认方案，回归通过也不替换当前安装；
- 不得绕过确认，不得把 mock 或未验证实验说成已上线效果。

位置：`omicslab/agent/context.py`（`BASE_RULES` 第 12 条与 `TOOL_HINTS`）、`desktop/src/activities/model.ts`（桌面 `SYSTEM_PROMPT`）。

## 6. 明确禁止

- 用一次普通分析冒充 RSI 发现闭环；
- 编造预注册时间、假设、p 值、效应量、引用或已通过回归；
- 跳过 `discovery_create_project` 直接手工散布假设/证据，不留账本；
- 让智能体自行触发 Proteus 进化、直接改写当前安装源码，或把实验副本产物当作已上线；
- 在未读取 `discovery_status` 时声称引擎产出了账本；
- 把视觉模型意见或 mock/占位输入当作真实证据升级结论。

## 7. 验证记录

本功能的相关自动化验证：

| 范围 | 命令 | 说明 |
| --- | --- | --- |
| Python 回归 | `python -m pytest -q` | 全仓库测试；未通过的用例必须与本次修改无关且已记录 |
| 桌面 TypeScript | `npm --prefix desktop run typecheck` | 类型检查 |
| 桌面单元/集成 | `npm --prefix desktop test` | 编译后单元测试（含 `rsi` 与 `rsi-capability`） |
| 前端终端背压 | `node --test tests/frontend-terminal.mjs` | 输出合并、帧切片、背压 |
| 前端产物/标注 | `node tests/frontend-artifacts.mjs` | 产物沙箱、批注与局部修改事件 |
| 科研技能审计 | `scripts/audit_science_capabilities.py --run-fixtures` | 技能目录、脚本执行与资源完整性 |

当前边界：

- Proteus 实验需要本机安装可选依赖与真实模型连接；自动化测试只使用本地可控协议 fixture，不消耗真实计费账号。
- 桌面 RSI 评估器调用真实模型前需要用户解锁凭据；候选模型输出只做确定性匹配，不走逐句语义判定。
- 干净 Windows 虚拟机、长期耐久、代码签名和外部模型账号验证仍属于发布前未覆盖项，见 `docs/verification/eve-1.0/UPDATE-20261027.md`。
