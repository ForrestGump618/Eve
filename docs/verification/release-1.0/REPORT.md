# 素问 1.0：实现、实测与剩余边界

验收日期：2026-10-26。基线提交为 `392a26460463b43e4b7a39af515bf10a3568e558`，开发分支为 `codex/suwen-1.0-reliability`。产品版本按用户要求定为 1.0，包版本统一为 `1.0.0`，并保留原 3.4 的 Git 历史。

本报告只记录已经执行或有可复核产物支持的结论。外部模型只验收了 `deepseek-v4.1-flash-economy`；MCP 与 Skill 使用实际可执行的本地服务或脚本；SSH 验收使用一台用户提供的真实主机。模拟、单元测试和真实端到端测试分别标明。

## 已交付的代码

- **统一 Agent Harness**：`desktop/src/harness/agent-loop.ts`、`desktop/src/harness/engine.ts` 和 `desktop/src/harness/store.ts` 实现 Plan → Act → Observe → Verify、有限重试、取消、检查点、恢复、Trace ID、结构化观察、上下文压缩和工具结果回传。简单请求可直接进入执行；只有模型实际返回工具结果并通过任务断言时才标记完成。
- **工作区执行环境**：`desktop/src/execution-environment.ts` 与 `omicslab/server/routes_harness.py` 将运行绑定的本地或 SSH backend 传给文件、搜索、编辑、Shell、Python 和 Skill 工具。模型不能自行改绑到另一台主机或另一执行根目录；连接失败抛错，不静默回退本地。
- **SSH 可靠性**：`omicslab/ssh/manager.py` 增加保活、每主机连接锁、系统 SSH Agent、密码复用、异常重连和执行器重建；`omicslab/execution/ssh_backend.py` 修正 worker 路径并校验 SFTP 解析后的真实路径与父目录。工作区越界、陈旧哈希写入和失败后的本地同名文件隔离均有测试。
- **权限模式**：`omicslab/agent/permissions.py` 落实“请求批准 / 帮我审核 / 完全权限”。审核模式只自动放行有限的只读命令与普通工作区文本写入；脚本、技能安装或执行及未分类操作仍需批准。权限按会话保存，恢复任务重新采用请求批准模式。
- **Skills**：保留并验证 8 个预装科研 Skill，支持发现、渐进加载、版本与完整性检查、依赖检查和技能作者工具。正式 UI 可安装 GitHub Skill；Agent 可通过受控工具创建和安装 Skill。远程工作区中的 Skill 在远程 backend 执行。
- **MCP**：正式能力中心支持新增、导入、启停、删除、动态发现和真实调用 MCP server；写入型 MCP 复用统一审批通道。stdio 与 HTTP 路径均受超时、取消、Schema 和错误诊断约束。远程工作区明确拒绝本机 stdio MCP，HTTP MCP 按配置执行。
- **对话与引导**：每个会话独立保存模型连接、模型名、工作区与权限。运行中可以切换目录、会话并启动第二个任务，迟到事件按订阅代次丢弃。`desktop/src/guidance.ts` 保存候选、待送达和已加入上下文的引导；支持修改、删除、撤回、批注和直接发送，不中断正在进行的模型 HTTP 请求或工具。
- **桌面生命周期**：`desktop/src/window-lifecycle.ts` 实现单正式窗口、原生 Tray、关闭三选项、选择记忆和显式安全退出。正常退出等待 daemon 清理；最小化到 Tray 后任务与 SSH 连接继续运行。
- **正式页面**：默认浅色、黑白灰一体化工作台；只有一个项目/最近会话侧栏，不显示品牌副标题，完整工作台就是首页。历史消息虚拟化，工具步骤折叠显示，流式输出节流，输入框固定，仅在用户接近底部时自动滚动。
- **审批与模态框**：权限选择器与工具栏统一；同一轮审批聚合为一个区域，不重复弹出浮动提示。`omicslab/web/js/ui.js` 跟踪正在退场的模态层，`omicslab/web/js/views/platform.js` 在打开新对话框前关闭旧层，修复关闭动画期间再次打开导致的模态框堆叠。

## 实际定位的根因

| 根因 | 可复现行为 | 修复与证据 |
| --- | --- | --- |
| SSH worker 路径指向不存在的文件 | 文件可读，但远程 Python 或 Skill 不可执行 | 修正 worker 上传路径；单元测试与真实 SSH 验收 |
| 并发获取连接时关闭其他调用持有的客户端 | 同主机并行操作随机断线 | 每主机连接锁、独立探测、heartbeat 与重连；断线后重建执行器 |
| Python → TypeScript 适配遗漏 backend/run context | 模型把远端任务当作本地工具调用 | 显式绑定执行环境；远端与本地同名文件使用不同内容验收 |
| 恢复校验依赖已从公开快照移除的本地字段 | 合法检查点恢复被 409 拒绝 | 按 resolved path 与完整 SSH 配置校验，保留工具协议配对 |
| 恢复任务未重新登记事件订阅 | 后台恢复完成，页面仍显示等待 | 记录恢复 run/trace 后重新订阅正式工作台 |
| 正常启动同时创建旧诊断页和正式页 | 两套界面、重复导航与额外窗口 | 正常路径只创建正式窗口；源码和打包 E2E 均验证窗口数为 1 |
| 仅凭 IPC 拒绝连接判断后台已退出 | 窗口先消失，daemon 和连接尚未清理 | 等待 daemon 清理完成；打包 Tray E2E 验证任务继续与安全退出 |
| 每次审批都产生 toast | 多工具任务出现大量重复提醒 | 同轮审批聚合，全局中心处理跨任务请求 |
| 模态框在关闭动画期间仍在 DOM | 一个弹窗尚未退场就打开另一个，出现堆叠和焦点争用 | 关闭层跟踪与打开前清理；源码和打包 UI E2E |
| MCP 只检查连接、不检查实际工具 | 页面显示已连接但模型无法调用 | 动态发现、Schema 校验、实际 call，以及写入型 MCP 审批测试 |

## 固定 Agent 测试

固定任务集共 22 项，覆盖普通网页检索、PubMed、摘要、文献比较、文件读取、MCP、Skill 和多步骤任务。修改前后使用同一模型、同一接口、同一任务文件和相同 SHA-256：

`08e2cc0eddd7db3d0bd87c4f0027e9825e7fccd0fa1f68a0015f3d4776caf2e6`

| 指标 | 修改前 | 1.0 最终回归 |
| --- | ---: | ---: |
| 固定断言通过 | 21/22 | **22/22** |
| 成功工具调用 | 55/66（83.33%） | 56/62（90.32%） |
| 含工具失败后仍完成全部断言 | 4/4 | 2/2 |
| P50 | 8,867 ms | **7,649 ms** |
| P95 | 59,442 ms | **21,697 ms** |
| Token 总量 | 286,212 | **283,308** |
| 金额 | 提供方未返回 | 提供方未返回 |

最终汇总见 `test-matrix.json`。每项任务的耗时、缺失断言、trace ID 和完成状态在矩阵中列出；产生矩阵的原始 Trace 含调用时序、观察哈希、工具成功/失败和验证结果，因包含机器路径与临时任务数据而只保留在本地。

引用验收只证明回答中的 URL 来自实际工具观察，不等于逐条语义支持的准确率。后者需要人工或独立评审，本版本没有把它计为已通过。金额也不按估算价格伪造。P50/P95 和 Token 改善只代表这一次同条件运行，不推广为所有模型的普遍性能。

## 界面、打包与 SSH 验收

| 验收 | 结果 | 证据 |
| --- | ---: | --- |
| TypeScript 测试 | 252 项：251 通过、1 跳过、0 失败 | `test-summary.json`；跳过项是 Windows 拒绝创建符号链接 |
| Python 测试 | 560 通过 | `test-summary.json` |
| 源码正式 UI 受控 E2E | 69/69 | `product-ui-summary.json` |
| 源码正式 UI + SSH | 70/70 | `product-ui-summary.json` |
| 打包 UI 受控 E2E | 69/69 | `product-ui-summary.json` |
| 打包 UI + 真实 SSH | 74/74 | `product-ui-summary.json` |
| 打包 + 真实模型 + 真实 SSH | 37/37，0 错误 | `product-ui-summary.json` |
| 真实 SSH | 16/16；P50 226.52 ms，P95 777.33 ms | `ssh-summary.json` |
| 打包 Windows Tray | 8/8 | `tray-summary.json` |

正式 UI 自动化覆盖完整工作台首页、单窗口、权限选择器、目录选择、并行会话、运行中切换目录、模型隔离、运行中引导/批注/撤回/直接发送、审批聚合、工具折叠、Skill 安装与执行、MCP 安装与调用、检查点恢复、取消、长会话虚拟化和主题。打包版使用实际 Electron 可执行文件运行，不是浏览器占位。

真实 SSH 验收包括密码认证、创建与读回、远程搜索、哈希保护编辑、Shell 工作目录、远程 Python、远程 Skill、凭据复用、dead transport 替换、worker 重建、两个 profile 隔离、路径越界拒绝和本地同名文件不变。两个 profile 指向同一台物理主机，因此不能证明第二台物理主机或跨公网长时间稳定性。

## 性能观察

同机短时配对测量使用隐藏的正式工作台，空闲观察窗口约 12.5 秒。结果见 `performance-summary.json`：

| 指标 | 修改前 | 1.0 |
| --- | ---: | ---: |
| 启动到 ready | 9,506 ms | 9,675 ms |
| Electron 窗口数 | 2 | 1 |
| 跟踪进程工作集合计 | 612 MB | 525.5 MB |
| 完整快照大小 | 114,194 B | 114,345 B |
| 完整快照延迟范围 | 1.89–4.04 ms | 1.62–3.22 ms |
| 单任务增量快照 | 未记录 | 4,362 B / 0.77 ms |
| daemon event-loop utilization | 0.770% | 0.092% |

跟踪工作集合计减少约 86.5 MB（14.13%），窗口数减至 1。启动时间在该次观测中增加 169 ms（1.78%），因此本报告不宣称启动提速。完整快照大小基本不变，延迟处于毫秒级。

Windows 进程级 CPU 会包含注入到进程中的奇安信 `LHShield64.dll`。Win32 线程采样把主要 CPU 时间归因到该外部安全模块；同一采样窗口内 daemon 的 Node 调度器在 after 状态为 `pending=false`、`active=0`、`poll=250ms`、`concurrency=2`。这能解释这次高进程 CPU 的主要来源，但不能代替长时间性能分析，也不能证明所有负载下没有应用侧热点。

## 安装包与发布证据

发布资产在构建后单独计算哈希，`SHA256SUMS.txt` 是最终校验来源。

| 资产 | 当前值 |
| --- | --- |
| 安装包 | `SuWen-Setup-1.0.0-win-x64.exe` |
| 大小 | 131,511,857 bytes |
| SHA-256 | `AF4C3C33053080E67D1F1A84231A4A0F1D36ABE75A726B483E82815DEB6D03FA` |
| Blockmap SHA-256 | `083837B4ADA88D8BA7CEE14A673C7A9388369D88C6C58AD40C63E7CCA07002A1` |
| SBOM | CycloneDX `sbom.cdx.json` |

安装包未做代码签名。SmartScreen/杀毒误报、干净虚拟机安装、标准用户与管理员权限矩阵尚未完成真实验收。

## 复现命令

从源码根目录执行。凭据只从本地文件读取，不写入仓库：

```powershell
python -m pytest -q

Set-Location desktop
npm ci
npm run typecheck
npm test
node scripts/e2e-rpc.mjs --live
node scripts/harness-benchmark.mjs --phase=validation --credentials=$env:SUWEN_MODEL_CREDENTIALS
node scripts/product-100-e2e.mjs --live --credentials=$env:SUWEN_MODEL_CREDENTIALS --ssh-credentials=$env:SUWEN_SSH_CREDENTIALS
python scripts/ssh-live-acceptance.py --credentials=$env:SUWEN_SSH_CREDENTIALS
npm run dist:win
node scripts/product-100-e2e.mjs --packaged --ssh-credentials=$env:SUWEN_SSH_CREDENTIALS
node scripts/tray-e2e.mjs --formal --packaged
```

测试使用独立的 `SUWEN_TEST_HOME`，不覆盖原用户会话和配置。SSH 验收只创建随机临时目录并清理。`SUWEN_WORKBENCH_DEPS` 可指向带有效标记的独立 Python 依赖目录。

## 架构取舍与参考

TypeScript durable Engine 是唯一桌面模型/工具循环；Python 保存科研工作台、工作区、事件和既有研究能力，通过 Adapter 传递能力，避免两套 Agent Loop 竞争。原有多模型辩论、裁判、历史、科研工具、Python Worker 与桌面功能保留，并由现有测试覆盖兼容路径。

DSH 参考提交为 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。复用已有 DSH 插件 0.3.0，参考 Cordis 生命周期、注册/卸载与按需扩展；没有整体替换运行时。ClawsGO 只参考了适用的信息分区与能力入口，没有复制其发行物代码。

参考：

- [DSH 仓库](https://github.com/deepseek-ai/deepseek-harness)
- [Electron 自定义标题栏](https://www.electronjs.org/docs/latest/tutorial/custom-title-bar)
- [Electron Tray](https://www.electronjs.org/docs/latest/api/tray)
- [Paramiko Client](https://docs.paramiko.org/en/stable/api/client.html)
- [GitHub Releases API](https://docs.github.com/en/rest/releases/releases)

## 仍未验证的边界

- 安装包未签名；没有完成干净虚拟机安装、SmartScreen 行为或大规模升级兼容验收。
- 真实 SSH 只使用一台物理主机和密码认证。私钥、系统 SSH Agent 的代码路径由测试覆盖，但没有对用户真实主机完成同一深度的在线验收。
- 远程 stdio MCP 不支持；远程工作区只允许按配置连接的 HTTP MCP。
- 未完成 8/24/72 小时耐久、跨 Windows 重启或休眠的任务交接、长时内存泄漏与多公网主机稳定性测试。
- 引用语义准确率和供应商金额没有统计；当前只有 URL 来源可追溯和提供方返回的 Token 用量。
- 性能数据是同机短时观测。启动时间在该次观测中变慢，不能宣称全面性能提升。
