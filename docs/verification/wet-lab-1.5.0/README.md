# Eve 1.5.0 K-Dense、湿实验与安装器验收

> 验收日期：2026-10-30
>
> 分支：`codex/eve-1.0-science`
>
> 目标平台：Windows x64（安装包未签名）

本轮把 K-Dense-AI/scientific-agent-skills 固定版本接入共享技能库，新增湿实验设计、经典细胞/分子 assay 和结果解读能力，并完成与主程序视觉风格统一的 Windows 安装与卸载界面。所有执行继续复用现有 `SkillRegistry`、`RunService`、工作区和人工确认门禁，没有建立第二套调度器。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **911 passed, 2 skipped, 1 warning** |
| 桌面单元/集成 | **261 passed, 1 skipped, 0 failed**（262 项） |
| 桌面类型检查 | **通过** |
| 真实 Edge 前端套件 | **10/10 套件通过** |
| 打包态 Electron smoke | **10/10 检查通过** |
| 安装器页面探针 | **11/11 通过** |
| 卸载器页面探针 | **9/9 通过** |
| Web 资源版本 | **1.5.0** |
| SBOM | **CycloneDX 1.5，294 个组件** |
| 静态安全扫描 | **0 HIGH / 317 LOW**，20 个测试夹具已登记 |
| Windows 安装包 | `Eve-Setup-1.5.0-win-x64.exe` |
| 安装包大小 | **142,974,163 bytes**（136.35 MiB） |
| 安装包 SHA-256 | `c1474285e06762580c571f3614c6343e884d4f70799781549494a9214f3a2e94` |

两个 Python 跳过项均来自当前 Windows 用户不能创建符号链接，不是功能失败。打包态 smoke 的 `Electron close` 清理步骤有一次 5 秒超时记录，但后续重开、Dashboard 和 Python worker 检查全部通过，因此该记录作为清理性能风险保留，不隐藏为完全无异常。

## K-Dense 与湿实验能力

- 共享技能库固定到 K-Dense-AI/scientific-agent-skills 提交 `5f2bc0341354fd5590aef76a533ada1e1e5b4e62`。
- 当前共享目录共 390 项技能、11 个来源，其中 K-Dense 175 项。
- `deepspot-m`、`rowan` 因上游再分发限制不收录。
- 新增 `wet-lab-experiment-design`、`classic-cell-and-molecular-assays`、`wet-lab-result-interpretation`。
- 湿实验脚本对细胞活力、qPCR ΔΔCt、Western blot 归一化和 ELISA 标准曲线做确定性计算；缺失值不填补，标准曲线不外推，技术重复不冒充生物学重复。
- 实验设计覆盖独立生物学单位、主要终点、对照、随机化、区组、盲法、样本量、批次、QC、停止规则和证据分级。
- 技能已接入科学工作台 `experiment` 流程、依赖闭包、检索同义词和 Agent 提示词。

完整契约、标准来源和证据边界见 [湿实验技能与结果解读](../../WET-LAB-SKILLS.md)。

## 界面与安装器

本轮 UI 统一使用单一蓝色强调色、中性灰层级和一致圆角/间距；开局弹窗、Toast、确认框、聊天内容高度、焦点恢复、按压反馈和减少动画均完成收口。

Windows 安装器不再显示标准 MUI 欢迎、进度或完成页，也不显示原生 `Back / Next / Cancel` 按钮。安装与卸载共六页使用自定义顶栏、卡片、中文排版、主次按钮和 `#3157D5` 主操作，尺寸统一为 `620 × 450`。安装为逐用户安装，可选择目录；卸载保留科研项目、技能、记忆和设置。

NSIS 底层仍使用 Win32 窗口与基础控件 API；本轮替换的是标准向导外观和原生按钮，不宣称零 Win32。安装器验收、截图和自动化步骤见 [安装器报告](../installer-1.5.0/README.md)。

## 真实证据

### 界面

- [安装欢迎页](../installer-1.5.0/installer-welcome.png)
- [安装进度页](../installer-1.5.0/installer-progress.png)
- [安装完成页](../installer-1.5.0/installer-finish.png)
- [卸载确认页](../installer-1.5.0/uninstaller-confirm.png)
- [卸载完成页](../installer-1.5.0/uninstaller-finish.png)
- [研究总览桌面](dashboard-desktop.png)
- [研究总览移动端](dashboard-mobile.png)
- [设置页模型配置](settings-models-desktop.png)
- [开局弹窗桌面](onboarding-desktop.png)
- [许愿式科研桌面](wish-research-desktop.png)

### 验证矩阵

| 证据 | 结果 | 文件 |
| --- | --- | --- |
| Python 全量 | 911 passed, 2 skipped | `python -m pytest -q`，372.22 s |
| 桌面单元/集成 | 261 passed, 1 skipped | `npm --prefix desktop test`，33.86 s |
| 类型检查 | 通过 | `npm --prefix desktop run typecheck` |
| 前端 Edge 套件 | 10/10 | [frontend-logs](frontend-logs) |
| 打包态 Electron | 10/10 | [packaged-smoke.json](packaged-smoke.json) |
| 安装器页面 | 11/11 | [page-transitions.json](../installer-1.5.0/page-transitions.json) |
| 卸载器页面 | 9/9 | [uninstaller-page-transitions.json](../installer-1.5.0/uninstaller-page-transitions.json) |
| 科学技能包装检查 | 40 项通过 | [report.json](science-skills/report.json) |
| 安装包清单 | 大小、blockmap、应用哈希 | [installer.json](installer.json) |
| SBOM | CycloneDX 1.5，294 个组件 | [sbom.cdx.json](sbom.cdx.json) |
| 静态安全扫描 | 0 HIGH / 317 LOW，20 个夹具登记 | [security-scan.json](security-scan.json) |
| 发布校验和 | 六个文件 | [SHA256SUMS](SHA256SUMS) |

前端套件覆盖 Agents、Artifacts、Dashboard、Literature、Onboarding、Settings、Teams、Terminal benchmark、Terminal 与 Wishes。Terminal 和 Teams 分别为 16/16，Agents 为 5/5，Dashboard 包含 11 类交互与可访问性检查。

## 体量与性能

同条件基线为 Eve 1.4.0：

| 指标 | 1.4.0 | 1.5.0 | 变化 |
| --- | ---: | ---: | ---: |
| Windows 安装包 | 144,531,378 B | 142,974,163 B | -1,557,215 B（-1.077%） |
| 版本控制改动 | — | 177 files | +8,114 / -17,325 行，净 -9,211 行 |
| `omicslab/web` 源码 | 1,260,052 B | 1,779,133 B | +519,081 B |

Dashboard 在真实 Edge 156 的本地 loopback fixture 中测得桌面挂载 39.2 ms、移动端挂载 8.2 ms，图表切换首帧 27.3 ms。许愿页桌面挂载 19 ms、移动端 3.3 ms。以上仅为本地浏览器与 fixture 指标，不包含模型推理、真实数据库或科研计算延迟。

安装器删除旧桌面 UI、旧测试脚本和冗余依赖后，安装包反而比 1.4.0 缩小约 1.08%。旧 `desktop/ui` 不再构建、不再打包，正常入口只保留一个托管工作台。

## 安装与校验

```powershell
Get-FileHash .\desktop\release\Eve-Setup-1.5.0-win-x64.exe -Algorithm SHA256
node desktop\scripts\verify-doc-hashes.mjs
```

安装包为 per-user NSIS，未签名。受管环境部署前应完成组织签名策略；SmartScreen 可能提示未知发布者。

## 未验证边界

- 没有在真实细胞、动物、临床样本或仪器上执行湿实验。
- 技能存在不代表 K-Dense 上游所需的第三方包、凭据、仪器或服务已经可用。
- 没有使用真实计费模型完成全部 K-Dense 技能的长期科研运行。
- 没有在干净 Windows VM、跨大版本升级矩阵或企业软件分发环境中验证安装。
- 自动化测试、截图和安装探针不构成科研结论、伦理/生物安全批准或临床有效性证据。
- 静态安全扫描不是渗透测试；外部数据源和第三方依赖仍需独立安全评估。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck

Get-ChildItem tests -Filter 'frontend-*.mjs' |
  Sort-Object Name |
  ForEach-Object { node $_.FullName }

$env:EVE_SMOKE_PACKAGED = '1'
$env:EVE_SMOKE_OUTPUT = (Resolve-Path desktop\release).Path + '\smoke-1.5'
npm --prefix desktop run smoke

powershell -NoProfile -ExecutionPolicy Bypass `
  -File docs/verification/installer-1.5.0/exercise-installer-ui.ps1
powershell -NoProfile -ExecutionPolicy Bypass `
  -File docs/verification/installer-1.5.0/exercise-uninstaller-ui.ps1

node desktop\scripts\verify-doc-hashes.mjs
```
