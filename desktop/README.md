# 素问 / SuWen Desktop 1.0.0

素问桌面端是一个面向真实科研与开发任务的 Windows Agent 工作台。Electron 窗口负责交互，独立守护进程持久执行任务，Python 工作台继续承载既有科研页面和 Worker。

## 开发与验证

需要 Node.js 24.14+、npm 和 Python 3.10+：

```powershell
npm ci
npm test
npm start
```

构建未签名 Windows 安装包：

```powershell
npm run dist:win -- --config.directories.output=release/product-100
```

最终产物位于 `release/product-100/SuWen-Setup-1.0.0-win-x64.exe`。构建目录被 `.gitignore` 排除，发布资产上传到 GitHub Release。

## 核心能力

- 默认进入浅色、灰阶、一体化正式工作台；项目文件与最近会话共享单侧栏，正常启动只创建一个窗口。
- 文件、搜索、编辑、Shell、Python、Skills 与工具调用遵循当前本地或 SSH 工作区；连接失败不会静默切换成本机。
- 提供“请求批准 / 帮我审核 / 完全权限”，同一轮审批合并显示，权限和模型配置按会话隔离。
- Agent Loop 支持 Plan → Act → Observe → Verify、有限重试、取消、Trace ID、结构化工具结果、上下文压缩、检查点恢复与运行中引导。
- 能力中心可安装、导入、启停和删除 MCP；测试会实际发现并调用工具，而不只检查连接状态。
- Skill 按需发现与加载，支持在正式 UI 中安装，也允许 Agent 创建、安装和执行技能；远程 Skill 在选定 SSH 主机执行。
- 长会话使用有界窗口渲染，流式事件去重并支持断线恢复；工具过程可折叠，输入区位置保持稳定。
- 关闭窗口可选择退出、最小化到托盘或取消；托盘可恢复窗口、查看任务状态并彻底退出。

## 验收与边界

最终测试为 560 项 Python 测试通过，249 项 TypeScript 测试中 248 项通过、1 项因 Windows 符号链接权限跳过；固定 22 项真实模型任务最终 22/22。正式页面、打包程序、托盘和实际 SSH 工作区均有自动化证据。

安装包未签名，SmartScreen 可能提示。干净 Windows VM 安装、8/24/72 小时连续耐久、断电/休眠、跨系统重启恢复、实际 SSH 私钥/系统 SSH Agent、第二台物理主机与远程 stdio MCP 尚未真实验收。Python 子进程隔离不等于操作系统安全沙箱。

完整结果、同条件前后指标、Trace 范围和未解决问题见 [1.0 验收报告](../docs/verification/release-1.0/REPORT.md) 与 [测试矩阵](../docs/verification/release-1.0/test-matrix.json)。

## 数据与许可

开发与测试使用独立的 `SUWEN_TEST_HOME`，不覆盖现有会话或用户配置。模型密钥由 Electron `safeStorage` 保护，SSH 凭据通过系统凭据库与引用传递，均不写入日志或源码。

桌面原创代码使用 MIT；保留的 Python 工作台使用 Apache-2.0。第三方许可见 `NOTICE` 与 `third-party-licenses/`。
