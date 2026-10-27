# Eve 1.0.0

Eve 是面向科研工作的 Windows 桌面 Agent，支持本地与 SSH 工作区、持续任务、可追溯工具执行和分阶段科研课题。默认进入浅色完整工作台，项目文件、最近会话、聊天与计算面板共用一个窗口。

产品沿用现有 TypeScript Harness 和 Python 执行后端。历史 Python 包名 `omicslab`、IPC 接口与已有数据目录作为兼容接口保留。升级时继续读取已有配置、历史会话与加密凭据。

## 开发与构建

需要 Node.js 24、npm，以及安装项目依赖的 Python 3.10+。安装包不包含 Python 解释器；首次运行的依赖初始化需要可用网络。

```powershell
python -m pip install -e ".[dev]"
cd desktop
npm ci
npm run typecheck
npm test
npm start
# 未签名 Windows x64 安装包
npm run dist:win
```

也可以运行根目录 `启动工作台.ps1` 或 `desktop/启动Eve.ps1`。`--native` 保留诊断控制台入口；正常启动只打开正式工作台。

## 科研工作区

左侧“科研”入口提供课题列表、七阶段图、比较契约、产物哈希、指标变化和发现记录。阶段为 scout、baseline、hypothesis、experiment、analysis、write、finalize。

| 参考 DeepScientist 的机制 | Eve 中的实现 |
| --- | --- |
| Quest / Research Map | 工作区隔离的持久课题与可视阶段图 |
| Baseline Gate | 锁定数据集、协议和指标方向；读取真实指标 JSON |
| Runner / Stage Skills | 复用 RunService、同一 Harness、按需技能与权限 |
| Findings / Artifacts | 保存阴性结果、阶段结论、来源路径和内容哈希 |
| Finalize | 人工复核结题，模型不能自行批准 |

任务执行结束仅进入待登记证据状态。登记产物和人工结题仍不自动证明科学结论成立。已登记阶段不允许覆盖；需要改变比较契约或重做已接受阶段时建立后续课题。

## 技能与扩展

保留原有 8 个基础技能，另以共享压缩库预装 278 项方法技能：K-Dense 175、Superpowers 15、DeepScientist 20、Composio 18、OpenClaw Medical 50。按名称和指令哈希去重，来源固定到 commit。许可与未分发原因逐项记录在 `desktop/skill-library/import-report.json`。

技能搜索只读取名称和描述，选中后加载指令；脚本与参考资源逐项校验哈希并解压，文本缓存上限 4 MB。能力中心搜索并分页显示，每页最多 32 项。参考技能没有可执行入口时不伪装成已执行，模型通过授权的当前工作区工具执行审阅后的代码。依赖、外部 API 和专用硬件需另行配置。

来源缺少再分发许可或含限制性版权声明的条目不进入公开安装包，因此本版未宣称上游全部技能均已预装。导入报告保留了这些条目的固定来源。能力中心和 Agent 工具支持继续安装、创建技能与安装 MCP 服务。

## 工作区、任务与权限

- 任务绑定工作区；SSH 失败返回明确错误，文件、Shell、Python 和技能不能静默改在本机执行。
- 每个会话独立设置模型与权限，可在运行中切换工作区并启动另一个任务。
- 引导支持候选、排队、批注、修改、撤回和直接送达，不打断当前模型请求。
- 请求批准、帮我审核、完全权限由执行端落实；审批按轮次聚合展示。
- 工具调用保留结构化观察、Trace、检查点和上下文摘要；恢复时不自动重放已完成的外部操作。
- 关闭窗口可退出、最小化到托盘或取消；后台任务与 SSH 连接遵循生命周期策略。

## 验证与边界

本轮实际结果、命令、来源 commit、安装包摘要和未验证项见 [Eve 验收记录](docs/verification/eve-1.0/REPORT.md)。此前版本的验证保留在 Git 历史与 [原工作区验收](docs/verification/release-1.0/REPORT.md)，不能当作新增科研模块的验收结果。

真实 SSH 验收限于一台主机的密码认证。真实私钥/系统 Agent、多小时耐久、系统重启恢复、干净虚拟机安装与远端 stdio MCP 尚未完成验收。HTTP MCP 使用当前配置；不把本机 stdio MCP 当作远端执行。Python 子进程隔离不等同于操作系统安全沙箱。

## 许可

Electron/TypeScript 新代码采用 MIT，Python 工作台沿用 Apache-2.0。技能各自保留上游许可和版权信息。详见 `LICENSE`、`desktop/LICENSE`、`desktop/NOTICE` 和技能索引。ClawsGO 仅作为交互设计参考，不分发其程序或资产。
