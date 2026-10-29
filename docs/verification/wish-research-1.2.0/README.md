# Eve 1.2.0 许愿式科研验收

> 验收日期：2026-10-29
>
> 分支：`codex/eve-1.0-science`
>
> 目标平台：Windows x64（安装包未签名）

本轮把“一句话愿望”接入 Eve 现有的持久运行引擎，形成可中断、可恢复、必须留下真实证据的科研项目。没有新建第二套 Agent 调度器：模型与工具仍由统一桌面 Harness 执行，Python `RunService` 负责持久 run、取消、恢复和审批，愿望服务只管理项目状态、阶段依赖与工作区证据。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **841 passed, 1 skipped, 1 warning** |
| 桌面单元/集成 | **310 passed, 1 skipped, 0 failed**（311 项） |
| 桌面类型检查 | **通过** |
| 许愿科研真实 Edge 验收 | **6 类检查通过**，无页面异常 |
| Web 资源版本 | **1.2.0** |
| 打包态 Electron smoke | **10/10 检查通过** |
| 安装器生命周期 | **10/10 步骤通过** |
| 安全扫描 | **0 HIGH / 531 LOW**，20 个测试夹具已登记 |
| Windows 安装包 | `Eve-Setup-1.2.0-win-x64.exe` |
| 安装包大小 | **144,305,025 bytes** |
| 安装包 SHA-256 | `4e634f84805a7e45576c5ae0473886958ab29f2f1cc57a7b73a5fe4880e1ae05` |

## 许愿式科研闭环

状态机固定为：

```text
愿望章程 -> 资源侦察 -> 证据矩阵 -> 可证伪假设
         -> 预注册 -> 数据分析 + 实验设计
         -> 图表 -> 用户人工复核
```

- `wish_status`、`wish_start`、`wish_update`、`wish_record`、`wish_block` 已注册为真实 Agent 工具，并绑定当前工作区。
- 一句话即可建立项目，自动创建 `data/evidence/analysis/experiments/figures/reports/provenance`。
- 每个节点的产物都读取真实文件、限制在愿望目录和对应阶段目录，并保存 SHA-256。
- 模型不能代替用户结题。只有界面提交复核人、复核说明和明确确认后，`review` 才完成。
- 连续推进在同一 durable run 内通过提示和 `wish_status` 续接；失败、阻塞、人工复核或预算边界会停止，不伪装成完整研究。
- `analysis` 与 `experiment_design` 在预注册后可并行，可交给现有持久子智能体按依赖执行。

接口、工作区约束和完整边界见 [许愿式科研文档](../../WISH-RESEARCH.md)。

## 关键修复

- 修复失败节点重试：提交前先对账旧 run 的终态，避免把 `running` 原始记录误判为重复任务。
- 提交运行失败时删除刚创建的空会话，避免侧边栏留下孤立对话。
- 前端版本标识统一为 `1.2.0`，真实浏览器验收不再加载旧模块实例。
- 节点卡展示前置依赖，连续推进确认框明确说明会因阻塞、审批或人工复核停止。
- 原始 JSON 不进入许愿科研主视图；界面只展示阶段、证据、阻塞、工作区和可执行入口。

## 验证矩阵

| 证据 | 结果 | 文件 |
| --- | --- | --- |
| Python 全量 | 841 passed, 1 skipped | `python -m pytest -q` |
| 桌面单元/集成 | 310 passed, 1 skipped | `npm --prefix desktop test` |
| 类型检查 | 通过 | `npm --prefix desktop run typecheck` |
| 许愿页面真实 Edge | 桌面、移动端、依赖、无原始 JSON、启动 payload、会话预选 | [wish-browser-results.json](wish-browser-results.json) |
| 打包态 Electron | 10/10 | `desktop/release/smoke-1.2/work/electron-e2e-result.json` |
| 安装器生命周期 | 10/10 | [installer-lifecycle.json](installer-lifecycle.json) |
| 安装包清单 | 1.2.0 大小与 SHA-256 | [installer.json](installer.json) |

关键界面证据：

- [桌面许愿科研页](wish-research-desktop.png)
- [移动端许愿科研页](wish-research-mobile.png)
- [愿望入口局部](wish-hero-element.png)

桌面端截图使用真实生产视图和本地 API fixture；它不是实际模型运行截图。

## 体量与性能

同条件对比基线为父提交 `2e5975c`（Eve 1.1.0）：

| 指标 | 1.1.0 / 父提交 | 1.2.0 | 变化 |
| --- | ---: | ---: | ---: |
| 安装包 | 144,273,806 B | 144,305,025 B | +31,219 B（+0.02%） |
| 纳入版本控制的 `omicslab/web` 原始字节 | 1,121,851 B | 1,159,930 B | +38,079 B（+3.39%） |
| 许愿科研 Python 服务 | 新增 | 41,623 B | 新增 |
| 许愿科研浏览器视图 | 新增 | 13,588 B | 新增 |

本轮没有把技能正文、科学脚本或大体积资源复制进许愿科研主视图。项目产物留在工作区，愿望记录只保存状态与哈希。

真实 Edge 156 的本地 loopback fixture 首次测量：

| 指标 | 桌面 1440×1100 | 移动 390×844 |
| --- | ---: | ---: |
| `mountWishResearch` 至视图完成 | 6.70 ms | 3.80 ms |
| 导航开始至首个阶段卡可见 | 179.93 ms | 71.76 ms |
| 页面 DOM 节点 | 239 | 239 |
| 已加载资源（编码字节） | 445,077 B | 445,077 B |

这些数字只覆盖本地静态资源、页面挂载和本地 API 响应，不包含模型推理、真实数据库请求、科学计算或 SSH 延迟，也不构成相对基线的全面性能提升声明。完整数据见 [wish-browser-results.json](wish-browser-results.json)。

## 安装与校验

发布资产：

- `Eve-Setup-1.2.0-win-x64.exe`
- `Eve-Setup-1.2.0-win-x64.exe.blockmap`
- `Eve-installer.json`
- `SHA256SUMS`
- `sbom.cdx.json`
- `security-scan.json`

安装包为 per-user NSIS，可选择安装目录，卸载默认保留用户数据。安装包未签名，Windows SmartScreen 可能提示；受管环境部署前应完成组织签名策略。

## 未验证边界

- 没有使用真实计费模型完成一次从愿望到人工复核的科研长跑；本报告不宣称模型必然自主完成全部阶段。
- 没有重跑全部 live 科研数据库、真实多组学数据或湿实验；证据链代码路径通过测试不等于科学结论成立。
- 许愿预算会写入章程，但硬停止仍由现有 `RunService` 的回合预算、取消和审批机制执行。
- 阻塞项不会强制杀死已在运行的 run；需要用户在任务界面停止，模型收到阻塞后应汇总并停止。
- 打包 smoke 使用本地 OpenAI-compatible HTTP fixture；安装器生命周期仅在宿主执行，不是干净 Windows VM。
- 没有代码签名、8/24/72 小时耐久、公网 SSH 抖动或跨版本升级矩阵证明。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck
node tests/frontend-wishes.mjs
python scripts/stamp_web_assets.py --check
node desktop/scripts/security-scan.mjs --out desktop/release/security-scan.json
npm --prefix desktop run dist:win

$env:SUWEN_SMOKE_PACKAGED='1'
$env:SUWEN_SMOKE_OUTPUT=(Resolve-Path 'desktop/release').Path + '\smoke-1.2'
$env:SUWEN_WORKBENCH_DEPS=(Join-Path $env:TEMP 'suwen-workbench-smoke')
npm --prefix desktop run smoke

powershell -ExecutionPolicy Bypass -File desktop/scripts/verify-installer.ps1 `
  -Installer 'desktop/release/Eve-Setup-1.2.0-win-x64.exe' `
  -Version '1.2.0' `
  -OutFile 'docs/verification/wish-research-1.2.0/installer-lifecycle.json'

node desktop/scripts/verify-doc-hashes.mjs
```
