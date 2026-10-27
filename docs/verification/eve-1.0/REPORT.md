# Eve 1.0.0：科研工作区与发布验收

验收日期：2026-10-27。本轮在 `74a98f95b6b2685a34752ae73724b65f923c1860` 上渐进修改，分支 `codex/eve-1.0-science`。最终提交由 `eve-v1.0.0` 标识，保留此前 SuWen 的 `v1.0.0`，不移动旧标签。产品名称为 Eve，内部 Python 包名、IPC 和已有数据目录保留为兼容接口。

此前 SSH、权限、引导、托盘和统一工作台的实现根因与基线见 `../release-1.0/REPORT.md`。本报告与同目录 JSON 记录新增科研模块、扩大的技能库，以及本轮重新执行的回归；不把旧版本的通过结果移作新增功能的证明。

## 实际修改与根因

| 问题 | 根因及代码位置 | 修复与验证 |
| --- | --- | --- |
| 科研页启动后聊天为空 | `omicslab/web/js/views/chat.js` 只使用浏览器本地运行标识 | 读取会话 `meta.last_run_id`，重新订阅真实任务与审批；正式安装包 UI 验收 |
| 扩大技能库后启动和上下文负担增加 | 全量内容和资源不能进入每轮上下文 | `desktop/src/skill-library.ts` 使用元数据倒排索引、按偏移解压和有界缓存；`domain/tools.ts` 按页加载 |
| 点名基础技能却匹配到泛化条目 | 扩展库关键词得分压过准确名称 | 精确名称优先；真实 SSH 与模型执行 `csv-analysis` |
| 两条新工具结果已超过上下文 | 压缩器跳过最近两条结果 | `desktop/src/harness/agent-loop.ts` 必要时压缩近期观察，保留协议配对及原文取回入口 |
| 长阶段多条中等结果与写入参数仍超限 | 单条低于旧阈值但累计超限；课题结论和长报告同时出现在工具结果与调用参数 | 逐级压缩、限制摘要体积；已观察调用的大段参数在原始决定持久化后摘要；`ResearchQuests.agent_list` 返回紧凑投影，UI 保留完整记录 |
| 已执行阶段又被要求创建、运行无关技能 | 校验器扫描 JSON 课题说明，跨句拼接工具要求 | 排除结构化尾部数据和代码样例，按有限句段判断实际操作要求；定向回归 |
| malformed 工具参数后无法恢复 | OpenAI 请求误执行 Anthropic 历史序列化 | `desktop/src/providers.ts` 按 provider 选择序列化；错误观察仍能回传 OpenAI 模型，参数无效不执行工具 |
| scout 产物已生成但未登记即耗尽 12 轮 | 阶段边界不明确，工具和可选分析消耗预算 | 阶段提示限定当前节点；有限 16 轮，末两轮提示收束，仍遵循调用、时间、Token 和权限预算 |
| 新品牌导致旧流式全局名称失配 | 已有页面仍引用历史全局接口 | 保留兼容别名；界面显示 Eve，既有会话与用户配置继续读取 |

失败未被抹去：完整科研测试先后复现轮次耗尽、错误的技能要求和写作上下文超限，均标记失败后修复重跑；协议混用曾令固定集一次运行出现 21/22。最终结果以本目录机器可读矩阵为准。原始 Trace 留在本机，不公开凭据、机器路径和完整模型回答。

## DeepScientist 对应到 Eve 的模块

参考提交 `b36624417f0c6b8238ec02db37b94d6db2faa5b0`，Apache-2.0。采用现有 Harness 的适配集成，没有启动第二套竞争的 Agent Loop。

| 上游机制 | Eve 模块与真实界面 |
| --- | --- |
| Quest / Research Map | `omicslab/suwen/research.py`：SQLite 课题、工作区隔离、七阶段和乐观版本锁；`research-workspace.js`：课题列表与阶段图 |
| Baseline Gate | dataset、protocol、指标名和方向形成比较契约；baseline/experiment 读取真实 JSON，拒绝 NaN、缺失或不同协议 |
| Runner / Skills | `routes_platform.py` 经 RunService 创建普通持久任务；复用 TypeScript Harness、本地/SSH backend、审批和引导 |
| Findings / Artifacts | 阶段结论、阴性结果、真实文件 SHA-256、指标差值及运行标识 |
| Finalize | 界面明确人工复核；Agent API 禁止自行批准，结题后仍保留 `scientific_status=unverified` |

前序证据不足不能跳阶段；已登记阶段不可覆盖，需要修改契约或重做时建立后续课题。执行完成、证据登记、科学结论成立分别表示，真实产物登记不替代实验设计、统计推断和同行评议。

DSH 参考提交沿用 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`，审计见 `../../research/deepseek-harness-audit.md`。既有插件生命周期、统一工具注册和 MCP/Skill 适配继续复用。ClawsGO 仅参考信息分区与能力入口，不分发其程序或资产。

## 预装技能与性能

原有 8 个基础技能之外，共享库加入 278 项去重的方法技能：K-Dense 175、Superpowers 15、DeepScientist 20、Composio 18、OpenClaw Medical 50。用户补充的 Zhihu 来源对应 Composio；Juejin 所引条目与这些来源按名称/内容哈希去重。

上游固定 commit、每项许可与所有未分发原因见 `desktop/skill-library/import-report.json`。113 项重复，1597 项缺少明确再分发许可或带限制声明，没有进入公开安装包。本版没有完成“上游全部技能均预装”的要求，不能把未分发条目计为通过。

2958 个唯一文件的原始文本 26,399,820 bytes，压缩包 9,112,964 bytes。解压按对象偏移执行，校验 SHA-256；文本 LRU 上限 4 MB。指令首屏 8000 字符、目录每页 40 条；能力中心每页 32 项。搜索不预读正文。没有 run 入口的参考技能不虚报执行，资源代码须经权限约束在当前工作区实际运行。额外 API、依赖、数据与硬件不随方法文本自动安装。

## 实际验证的范围

- 固定 22 项同模型任务：网页、PubMed、摘要、文献比较、文件、MCP、Skill 和多步骤；任务 SHA-256 `08e2cc0eddd7db3d0bd87c4f0027e9825e7fccd0fa1f68a0015f3d4776caf2e6`。逐项状态、耗时、Token、失败后恢复与前后指标见 `test-matrix.json`。MCP/Skill 为真实本地可执行测试服务，不声称外部服务全面可用。
- 完整科研验收：模型完成六个执行阶段，人工通过 UI 结题。三行合成 CSV 的标签为 value>=4；实际 Python 计算常数零预测的 baseline accuracy=1/3、阈值预测的 experiment accuracy=1。非模型填数或手工导入指标。与较早的“scout 实跑、其他阶段导入文件”测试分别记录。
- 正式 Electron 页面、并行工作区与独立模型、引导队列、技能安装、审批聚合、长历史、远程执行见 `ui-summary.json`；托盘见 `tray-formal-packaged.json`；真实 SSH 18 项见 `ssh-live-acceptance.json`。
- 单元与集成计数见 `test-summary.json`。安装包资源与构建源逐一比对见 `package-integrity.json`，安装器大小和 SHA-256 见 `installer.json`。

引用验证只检查 URL 来自实际工具结果，未评测逐条语义蕴含率。提供方未报告金额，不编造货币成本。错误恢复率按“含工具失败但最终完成全部固定断言的任务”统计，不等同于所有失败类型的自动恢复概率。

最终固定集在其他真实模型验收结束后单独运行。模型均为 `deepseek-v4.1-flash-economy`，任务、配置和断言保持一致：

| 指标 | 基线 74a98f9 | Eve 最终 |
| --- | ---: | ---: |
| 任务断言通过 | 22/22 | 22/22 |
| 成功工具调用 | 56/62（90.32%） | 53/60（88.33%） |
| 含工具失败后仍完成全部断言 | 2/2 | 3/3 |
| P50 | 7,649 ms | 7,310 ms |
| P95 | 21,697 ms | 34,845 ms |
| Token | 283,308 | 277,171 |

工具成功率和尾延迟没有改善。公开检索提供商仍有偶发错误，本轮由有限回退恢复；这不支持“所有性能都提高”的说法。最后单独运行前，一轮并行验收为 21/22：实际检索和读取完成，但回答使用 `Context Isolation`，未命中固定词形断言 `contextIsolation`。该次不计为通过，未更改断言；最终完整重跑为 22/22。这些都是单次运行，不能作为统计显著性结论。

最终构建验收为 TypeScript 265 通过、1 跳过、0 失败，Python 581 通过；正式安装包完整科研 31/31、受控 UI 与真实 SSH 75/75、真实模型与 SSH 37/37、托盘 8/8，RPC 42/42。安装包中的 333 个代码与资源文件逐项校验，无差异。

## 桌面性能实测及局限

`desktop-performance.json` 是在同一机器分别构建基线和 Eve 的正式工作台测量：启动 12,265→10,413 ms；已追踪进程工作集 528.5→539.1 MB；主进程定时器 P95 6.80→6.64 ms，渲染进程 1.30→1.40 ms。内存与渲染延迟没有改善，不声称整体性能全面提升。

样本只有一次配对和短时空闲窗口，测试期间其他进程仍在运行；安全软件注入模块影响 CPU，CPU 不作为可靠的前后收益。已追踪工作集也不是整个系统树的完整峰值。需要独立机器、多轮启动和多小时负载再评估。

## 复现命令

```powershell
npm --prefix desktop run typecheck
npm --prefix desktop test
python -m pytest -q
cd desktop
node scripts/e2e-rpc.mjs --live
node scripts/ui-dom-qa.mjs
node scripts/harness-benchmark.mjs --phase=eve-final --credentials=<本地凭据文件>
npm run dist:win -- --config.directories.output=release/eve-v1.0.0
node scripts/product-100-e2e.mjs --research-only --research-full --live --credentials=<本地凭据文件> --packaged --packaged-dir=release/eve-v1.0.0/win-unpacked
node scripts/product-100-e2e.mjs --packaged --packaged-dir=release/eve-v1.0.0/win-unpacked --ssh-credentials=<临时测试凭据文件>
node scripts/product-100-e2e.mjs --live --credentials=<本地凭据文件> --packaged --packaged-dir=release/eve-v1.0.0/win-unpacked --ssh-credentials=<临时测试凭据文件>
node scripts/tray-e2e.mjs --formal --packaged --packaged-dir=release/eve-v1.0.0/win-unpacked
python scripts/curate-eve-release.py
```

## 尚未验收或仍有限制

真实认证只覆盖一台物理 SSH 主机的密码和两个独立配置；私钥/系统 Agent、多物理主机、多小时耐久、系统重启交接、干净虚拟机安装未计为通过。远端 stdio MCP 尚不支持，不能把本地服务当远端执行。Python 需要在系统单独安装；子进程隔离不等于操作系统安全沙箱。Windows 安装包未签名。模型兼容性本轮仅实际验收 `deepseek-v4.1-flash-economy`。

这些边界意味着不能宣称用户列出的全部能力均已完成真实验收，也不能把小样本合成流程当成科研发现。无真实凭据/依赖的服务均保持未验证。

旧构建目录的递归清理被自动审批以 `blocked by policy` 拒绝，保留约 1.49 GB 逻辑大小的旧生成物，详见 `cleanup.json`。这些目录均被 Git 与新干净导出排除。没有通过更换执行器绕过拒绝，也未删除用户项目、历史数据或配置。
