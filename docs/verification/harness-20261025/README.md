# 素问 Harness 诊断与交付记录（2026-10-25）

本轮已交付可运行的 3.3.1 增量代码和 Windows 安装包，**尚未达到完整验收条件**。真实固定任务为 **19/22（86.4%）**；最后三项及最终正式页面的真实模型复测被外部接口持续 HTTP 429 阻断。受控模型测试不计入真实任务成功率。

## 直接进入正式页面

源码启动：在 `desktop` 运行 `./启动素问.ps1`，或者在项目根目录运行 `./启动工作台.ps1`。默认启动完整科研工作台，隐藏原生诊断控制台，不再需要手动进入“实验工作台”点击安装/打开。优先复用可用 Python；确实缺少依赖时自动准备并显示进度，失败明确显示原因。仍需可用的 Python 解释器；未验证无 Python 的干净 Windows 环境。

`desktop/release/SuWen-Setup-3.3.1-win-x64.exe` 为本轮安装包。原 3.3.0 安装包保留。`./启动素问.ps1 -NativeConsole` 打开原生控制台；根启动器 `-LegacyWeb` 保留原浏览器启动方式和原 `.omicslab` 数据目录。

原有数据没有迁移、覆盖或删除。Electron 使用既有用户数据目录；模型密钥仍通过 safeStorage 加密。测试全部使用独立临时目录。用户提供的 API 文件没有复制进项目，真实测试模型固定为 `deepseek-v4.1-flash-economy`。

## 已复现的根因

详见 [根因报告](root-causes.md)、[架构记录](architecture.md)、[测试矩阵](test-matrix.csv)、[性能对照](comparison.json)、[未解决问题](open-issues.md)。

最重要的断链是：普通聊天没有 Function Calling/工具循环；检索被关键词强制路由到原始 PubMed 查询；正式页面又使用另一条 Python 执行链，且传入了错误的 provider 名称。模型“没有联网/没有读取”的回答仍被旧代码标记为完成。

逐项代码位置与当前行号见 [code-locations.csv](code-locations.csv)；源码 SHA-256、安装包校验值和总体门槛见 source-sha256.json、release.json、acceptance.json。

## 本轮实测

| 项目 | 结果 | 证据/边界 |
|---|---|---|
| 固定 22 项真实任务基线 | 0/22；旧状态却全部 completed | [baseline.json](baseline.json)，不是“模型完全不会回答” |
| 同模型、同任务、同参数修复后 | 19/22；其余三项 429 | [final.json](final.json)，重试仍拒绝见 [recovery.json](recovery.json) |
| 真实工具调用 | 39 成功 / 46 尝试，84.8% | 工具错误均回传模型；5/7 错误之后有同名工具成功 |
| 引用来源机械检查 | 14 次引用、11 个唯一 URL 均属于检索来源集合 | 只证明来源对应，不等于每句话都被来源蕴含 |
| TypeScript / 单元测试 | 238 项：237 通过、0 失败、1 跳过 | [unit-tests.txt](unit-tests.txt)；跳过 Windows symlink 权限用例 |
| Python 兼容回归 | 261/261 | [python-tests.txt](python-tests.txt) |
| 真后台 RPC 集成 | 42/42 | [rpc-integration.txt](rpc-integration.txt)，含真实 Europe PMC、UniProt |
| 原生聊天 UI | 草稿保留、输入框 0px 位移、滚动上翻 0px 漂移、并发无串话、助手仅持久化一次 | [ui-final.json](ui-final.json)，模型为本地协议 fixture |
| 长历史 | 120 条保留、DOM 80 条窗口、前后可访问，打开 148ms | [ui-history-window.json](ui-history-window.json)，窗口分页而非连续无限滚动 |
| 正式页面配置回归 | 13/13 | [workbench-config-verified.json](workbench-config-verified.json)；最初未指定依赖目录的环境失败也保留 |
| 正式页面 UI / 打包版本 | 开发和打包程序均 8/8 | [formal-ui-controlled.json](formal-ui-controlled.json) / [formal-ui-packaged.json](formal-ui-packaged.json)；本地模型协议 fixture + 真实 PubMed，不计入真实模型通过率 |
| 正式工作台所有路由、Markdown 扩展回归 | 34/34，12/12 路由、无页面错误/CSP 违规 | [workbench-routes-final.json](workbench-routes-final.json)；初版 33/34 的首段渲染失败保留并已修复 |
| DOM 静态检查 | 18 通过、0 失败、13 条既有桥接方法提示 | [dom-audit.txt](dom-audit.txt) |
| npm 声明的生产依赖审计 | 0 已知漏洞 | [npm-audit-production.json](npm-audit-production.json)；不覆盖所有打包资源，开发依赖/离线渲染资源仍有告警 |

真实任务 P50：6998 → 7801ms，P95：16282 → 16067ms。持久化 Token 记账：64397 → 162302。修复后真正执行工具，不能把未执行任务的较低成本当作有效效率优势；失败请求可能缺少供应商 usage。供应商未报告货币成本，费用为未知。未宣称吞吐/成本优化已经完成。

上述延迟包含三次 429 快速失败。修复后成功子集另行记录在 comparison.json；基线没有成功子集，不能比较“成功任务延迟”。最慢网页任务进行了多次抓取回退，约 60 秒。

测试断言检查工具执行、期望字段、非空结果、引用来源集合；不完整覆盖中文长度要求和全部语义正确性。人工抽查了官方文档、iPS 摘要及两篇论文比较，仍需独立领域评审。

## 复现命令

在 `desktop`：

```powershell
npm ci
npm run typecheck
npm test
node scripts/e2e-rpc.mjs --live
node scripts/harness-benchmark.mjs --phase=final --credentials='C:\path\API.txt'
node scripts/streaming-ui-e2e.mjs --mode=final --runs=1 --only=composer,scroll,concurrent,persist
node scripts/streaming-ui-e2e.mjs --mode=final --runs=1 --only=long,persist
node scripts/formal-ui-e2e.mjs --fixture --credentials='C:\path\API.txt'
node scripts/formal-ui-e2e.mjs --fixture --packaged --credentials='C:\path\API.txt'
npm run dist:win
```

`formal-ui-e2e --fixture` 使用本地模型协议；去掉该参数才是真实供应商。真实凭据限流时不得把 fixture 的 UI 结果记作真实模型通过。所有 benchmark 阶段保留，`probe.json` 有一项严格关键词断言失败，未改写为通过。

Git 原始基线为 `e07bb5db65d1eafd3ef3d6315bb23b01a8ff689b`；保留分支 `codex/harness-baseline-20261025`。开发分支 `codex/harness-reliability-20261025`。运行时产物和用户密钥未提交；其他并行工作产生的 `omicslab/cli.py` 与 `omicslab/integrations` 改动不属于本轮，不覆盖、不纳入本轮提交。
