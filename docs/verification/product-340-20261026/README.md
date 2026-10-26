# 素问 3.4.0：界面、文件、技能与长输出改造

本轮提供实际代码和 Windows 安装包。ClawsGO 1.1.3 已完成安装包局部分析及独立配置启动；采用执行过程折叠、侧栏状态、技能可检查性和工作目录边界等设计，保留素问自己的品牌与执行核心。

**当前版本真实模型验收尚未通过。** 供应商再次返回 HTTP 429，固定 22 项这一轮均未完成。3.3.2 之前的 22/22 保留为历史结果，不能替代 3.4.0 的实测。受控 SSE 测试、真实文件/技能测试和真实外网数据库测试在下表分列，没有混入真实模型成功率。

## 使用

- 安装包：`desktop/release/product-340/SuWen-Setup-3.4.0-win-x64.exe`。
- 打包程序：`desktop/release/product-340/win-unpacked/SuWen.exe`。
- 源码：项目根目录 `./启动工作台.ps1`，或 desktop 下 `./启动素问.ps1`，仍默认进入正式科研页面。首次缺依赖时仍需可用 Python 和依赖准备。
- 对话输入区选择“工作目录”，填写本机已有文件夹，随后从该目录开始新会话。可直接要求读取文本、列目录、搜索或保存文件；现有文件的替换需先读取得到 SHA，防止覆盖未见变更。
- “技能”可查看预装技能及正文；能力中心也使用同一目录，可启停。可要求创建技能或从公共 GitHub tree 目录链接安装；安装后有可执行入口才会执行。
- 工具过程默认折叠为一行，点击查看各步骤、耗时与错误，继续展开可看最多 4000 字符的原始结果摘要；刷新后仍能查看摘要和运行详情，完整原始证据保留在本地 Harness 产物。

浅色 / 深色实际界面截图：chat-controlled-light.png、chat-controlled-dark.png。截图回答由受控模型协议生成，CSV 均值来自真实文件和 Python 执行，不是供应商模型验收。

## 实际变更

1. 扁平化消息、输入框和工具列表；浅色用户气泡改为低饱和灰绿，深色用中性面板；减少渐变、阴影与重复框；侧栏折叠并记住偏好。
2. 统一文件工具，支持目录、文本分页、文件搜索、精确文件授权和带内容哈希的写入。正式页面传入已选工作区，修复“目录存在但模型无权读取”的断链。
3. 预装 8 个真实技能，保留许可证与固定来源。实际 OpenAI creator / installer、DSH error handling 与素问文件/文献/CSV/统计/JSON 包共用 Registry；按需加载参考文件，避免全部注入。
4. 新增 skill_create / skill_install / skill_read_resource，与已有 skill_search / skill_load / skill_run 配合；静态检查、内容摘要、依赖检查和执行结果仍沿用现有机制。
5. 正式页面不再硬编码 2048 输出上限；保留 length 截断文本和 Token，最多三次有限接续，工具参数不完整时不执行，所有恢复受任务预算控制。
6. 升级时校验后台版本，防止新界面复用旧执行器；保留有未结束任务的旧后台。修复 MCP 在 Windows 压力下将管道延迟误判为进程未退出的问题。

文件和行号见 [code-locations.csv](code-locations.csv)，根因与执行架构见 [root-causes.md](root-causes.md)，逆向证据及采用映射见 [claws-analysis.md](claws-analysis.md)。

## 验证矩阵

| 检查 | 结果 | 证据 / 范围 |
|---|---|---|
| TypeScript typecheck | 通过 | `npm run typecheck` |
| TS 单元及本地集成 | 243 通过、0 失败、1 跳过 | unit-tests.txt，244 项；含真实 Python 技能、文件边界、截断恢复；Windows symlink 权限用例跳过 |
| Python 全套 | 520 通过 | python-final-tests.txt；包含共享工作区原有科学/DSH 测试，但它们的未提交实现不在本轮发布中 |
| 认证后台 RPC | 42/42 | rpc-tests.txt；真实 Europe PMC / UniProt，不使用供应商模型 |
| 文件、技能创建/执行和固定 GitHub 安装 | 8/8 | tools-e2e.json；无模型，实际文件系统、Python Worker、公共 GitHub 下载 |
| 正式产品界面 | 打包版本 20/20 | product-ui-controlled-packaged.json；受控 SSE，真实 CSV/技能；含接续、原始结果摘要、启停同步、刷新历史/目录/运行入口和输入框 0px 位移 |
| 12 页及 Markdown 回归 | 34/34，12/12 页面 | routes-ui.json；公式、Mermaid、表格、代码、明暗主题；0 页面错误 / CSP 违规 |
| 窗口生命周期 | 开发与打包各 4/4 | window-dev.json / window-packaged.json；owner-first、formal-first、quit-both、during-start |
| 旧后台升级 | 2/2 | daemon-upgrade.json；真实 3.3.2，分别验证空闲升级与待审批任务保留 |
| OpenAI 技能来源 | 所有保留文件匹配固定 commit | bundled-provenance.json；逐个 Git blob 比对 |
| 固定 22 项真实模型任务 | 本轮 0/22 完成，未通过 | real-model-429.json / test-matrix.csv；HTTP 429 阻断，不计通过 |

最终机器可读结论见 acceptance.json。实际源码与安装包摘要在 source-sha256.json、release-provenance.json；打包文件核对在 package-source-checks.json。密钥精确扫描与临时鉴权脱敏结果在 credential-scan.json。

## 复现命令

在 desktop 目录，PowerShell：

```powershell
npm run typecheck
npm test
node scripts/e2e-rpc.mjs --live
node scripts/product-tools-e2e.mjs
$env:SUWEN_WORKBENCH_DEPS="$env:TEMP\suwen-formal-ui-6F4epw\python-env"
node scripts/workbench-ui-e2e.mjs
node scripts/build-product-340.mjs
node scripts/product-340-e2e.mjs --packaged
node scripts/window-lifecycle-e2e.mjs --packaged --app-dir=release/product-340/win-unpacked --phase=product-340-packaged
```

依赖目录是本机已准备并验证的临时环境；其他机器请改为自己的 managed Python 依赖目录。项目根目录运行 `python -m pytest tests -q`。

额度恢复后再执行以下真实供应商测试，不能删除 --live 后当作通过：

```powershell
node scripts/harness-benchmark.mjs --phase=product-340-retry '--credentials=C:\Users\Qingyuan Zhuang\Desktop\API.txt'
node scripts/product-340-e2e.mjs --packaged --live '--credentials=C:\Users\Qingyuan Zhuang\Desktop\API.txt'
```

供应商真实长输出接续还需另设低输出预算用例，`--live` 的文件/技能界面测试不强制制造 length，不代表已验证供应商截断恢复。

## 性能与剩余项

[comparison.json](comparison.json) 保留同任务、同模型、同参数对照；当前 HTTP 429 快速失败延迟不能解释为性能改善。供应商没有货币费用返回，费用未知；当前也没有有效的成功样本 P50/P95 或引用准确率。实际工具边界耗时与 UI 异常统计见 acceptance.json；引用机械来源对应不等于语义蕴含。

未解决项详见 root-causes.md：真实模型配额、二进制文档解析、操作系统沙箱、复杂第三方技能依赖和无 Python 干净系统安装均未验收；ClawsGO 服务器端 Agent Loop 未恢复。保留这些限制，不宣称全部 P0 或最初 18/20 门槛已经达到。

本轮没有安装覆盖生产程序、删除用户历史或修改 API.txt。共享工作区的 README、CHANGELOG、CLI 和 integrations 其他修改保持原样；发布的 Python 资源从已提交基线加明确覆盖文件生成，排除了这些未审查改动。
