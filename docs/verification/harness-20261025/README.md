# 素问 Harness 诊断与交付记录（2026-10-25 至 2026-10-26）

本轮交付 **3.3.2** 代码和 Windows 安装包。额度恢复后，使用相同 `deepseek-v4.1-flash-economy`、相同固定 22 项和参数完整复跑：首轮 **21/22**；修复引用解析后再次完整运行，最终 **22/22**。正式页面同时使用真实模型和真实 PubMed 完成 8/8；受控模型 UI 测试单列，未计入真实任务成功率。完整产品能力仍有边界，见 open-issues.md，不宣称所有 P0 能力全部关闭。

## 直接进入正式页面

源码启动：在 `desktop` 运行 `./启动素问.ps1`，或者在项目根目录运行 `./启动工作台.ps1`。默认启动完整科研工作台，隐藏原生诊断控制台，不再需要手动进入“实验工作台”点击安装/打开。优先复用可用 Python；确实缺少依赖时自动准备并显示进度，失败明确显示原因。仍需可用的 Python 解释器；未验证无 Python 的干净 Windows 环境。

`desktop/release/SuWen-Setup-3.3.2-win-x64.exe` 为本轮安装包。原 3.3.0、3.3.1 安装包保留。`./启动素问.ps1 -NativeConsole` 打开原生控制台；根启动器 `-LegacyWeb` 保留原浏览器启动方式和原 `.omicslab` 数据目录。

原有数据没有迁移、覆盖或删除。Electron 使用既有用户数据目录；模型密钥仍通过 safeStorage 加密。测试全部使用独立临时目录。用户提供的 API 文件没有复制进项目，真实测试模型固定为 `deepseek-v4.1-flash-economy`。

## 已复现的根因

详见 [根因报告](root-causes.md)、[架构记录](architecture.md)、[测试矩阵](test-matrix.csv)、[性能对照](comparison.json)、[未解决问题](open-issues.md)。

最重要的断链是：普通聊天没有 Function Calling/工具循环；检索被关键词强制路由到原始 PubMed 查询；正式页面又使用另一条 Python 执行链，且传入了错误的 provider 名称。模型“没有联网/没有读取”的回答仍被旧代码标记为完成。

逐项代码位置与当前行号见 [code-locations.csv](code-locations.csv)；源码 SHA-256、安装包校验值和总体门槛见 source-sha256.json、release.json、acceptance.json。

## 本轮实测

| 项目 | 结果 | 证据/边界 |
|---|---|---|
| 固定 22 项真实任务基线 | 0/22；旧状态却全部 completed | [baseline.json](baseline.json)，不是“模型完全不会回答” |
| 同模型、同任务、同参数修复后 | 最终 22/22 | [verified-final.json](verified-final.json)；原 19/22 和恢复首轮 21/22 分别保留在 final.json / resumed-final.json |
| 真实工具调用 | 48 成功 / 56 尝试，85.7% | 8 次中间错误均记录；6/8 后续有同名工具成功，按任务仍全部通过 |
| 引用来源机械检查 | 15 次引用、11 个唯一 URL 均属于检索来源集合 | 只证明来源对应，不等于每句话都被来源蕴含 |
| TypeScript / 单元测试 | 240 项：239 通过、0 失败、1 跳过 | [verified-window-unit-tests.txt](verified-window-unit-tests.txt)；跳过 Windows symlink 权限用例 |
| Python 兼容回归 | 261/261 | [resumed-python-tests.txt](resumed-python-tests.txt) |
| 真后台 RPC 集成 | 42/42 | [verified-rpc-integration.txt](verified-rpc-integration.txt)，含真实 Europe PMC、UniProt |
| 原生聊天 UI | 草稿保留、输入框 0px 位移、滚动上翻 0px 漂移、并发无串话、助手仅持久化一次 | [streaming-ui-verified.json](streaming-ui-verified.json)，本地模型协议 fixture；本次连续新建竞态失败另有保留 |
| 原生会话竞态 | 4/4 | [conversation-race-ui.json](conversation-race-ui.json)，真实 IPC；延迟 get/list 不覆盖显式新建或其他会话 |
| 长历史 | 120 条保留、DOM 80 条窗口、前后可访问，打开 148ms | [ui-history-window.json](ui-history-window.json)，窗口分页而非连续无限滚动 |
| 正式页面配置回归 | 13/13 | [workbench-config-verified.json](workbench-config-verified.json)；最初未指定依赖目录的环境失败也保留 |
| 正式页面 UI / 打包版本 | 8/8，真实模型 + 真实 PubMed | [formal-ui.json](formal-ui.json)；先前 fixture 验证保留在 formal-ui-packaged.json，二者不混计 |
| 正式工作台所有路由、Markdown 扩展回归 | 34/34，12/12 路由、无页面错误/CSP 违规 | [workbench-routes-verified.json](workbench-routes-verified.json)；33/34 失败保留在 workbench-progressive-reproduced.json |
| 窗口退出生命周期 | 四种关闭顺序 | window-lifecycle-fixed.json / window-lifecycle-packaged.json；window-lifecycle-reproduced.json 保留用户截图同型异常 |
| DOM 静态检查 | 18 通过、0 失败、13 条既有桥接方法提示 | [dom-audit.txt](dom-audit.txt) |
| npm 声明的生产依赖审计 | 0 已知漏洞 | [npm-audit-production.json](npm-audit-production.json)；不覆盖所有打包资源，开发依赖/离线渲染资源仍有告警 |

真实任务 P50：6998 → 10031ms，P95：16282 → 38391ms。持久化 Token 记账：64397 → 186010。修复后真正执行工具，不能把未执行任务的较低成本当作有效效率优势；供应商未报告货币成本，费用为未知。网络回退仍是延迟来源，未宣称吞吐/成本优化已经完成。

最终 22 项均通过，没有混入 429 快速失败；原先限流阶段的数字仍保留，不能替代最终数值。基线没有成功子集，不能比较“成功任务延迟”。最慢网页任务进行了多次抓取回退，约 59 秒。

测试断言检查工具执行、期望字段、非空结果、引用来源集合；不完整覆盖中文长度要求和全部语义正确性。人工抽查了官方文档、iPS 摘要及两篇论文比较，仍需独立领域评审。

## 复现命令

在 `desktop`：

```powershell
npm ci
npm run typecheck
npm test
node scripts/e2e-rpc.mjs --live
node scripts/harness-benchmark.mjs --phase=final --credentials='C:\path\API.txt'
node scripts/harness-benchmark.mjs --phase=verified-final --credentials='C:\path\API.txt'
node scripts/streaming-ui-e2e.mjs --mode=final --runs=1 --only=composer,scroll,concurrent,persist
node scripts/streaming-ui-e2e.mjs --mode=final --runs=1 --only=long,persist
node scripts/formal-ui-e2e.mjs --fixture --credentials='C:\path\API.txt'
node scripts/formal-ui-e2e.mjs --fixture --packaged --credentials='C:\path\API.txt'
node scripts/conversation-ui-e2e.mjs
node scripts/window-lifecycle-e2e.mjs
npx --no-install electron-builder --win nsis --x64 --config.electronDist=node_modules/electron/dist
node scripts/window-lifecycle-e2e.mjs --packaged --phase=packaged
node scripts/formal-ui-e2e.mjs --packaged --credentials='C:\path\API.txt'
node scripts/harness-report.mjs
```

`formal-ui-e2e --fixture` 使用本地模型协议；去掉该参数才是真实供应商。真实凭据限流时不得把 fixture 的 UI 结果记作真实模型通过。所有 benchmark 阶段保留，`probe.json` 有一项严格关键词断言失败，未改写为通过。

本次默认打包命令曾因 Electron 下载连接 GitHub 超时失败，保存在 verified-package-build.txt；复用本项目已安装的相同 Electron 45.0.0 分发后打包成功，见 verified-package-final.txt。安装器仍未签名，未替用户安装覆盖现有生产程序，也未做干净 Windows VM 安装验收。

Git 原始基线为 `e07bb5db65d1eafd3ef3d6315bb23b01a8ff689b`；保留分支 `codex/harness-baseline-20261025`。开发分支 `codex/harness-reliability-20261025`。运行时产物和用户密钥未提交；其他并行工作产生的 `omicslab/cli.py` 与 `omicslab/integrations` 改动不属于本轮，不覆盖、不纳入本轮提交。
