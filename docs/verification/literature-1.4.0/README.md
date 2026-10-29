# Eve 1.4.0 文献雷达与技能图验收

> 验收日期：2026-10-29
>
> 分支：`codex/eve-1.0-science`
>
> 目标平台：Windows x64（安装包未签名）

本轮新增文献雷达、用户投喂、朋友圈、主动分享、反思审核与依赖感知技能图。所有后台行为继续依附现有 `Platform`、工作区、`RunService` 和人工确认门禁，没有建立第二套任务调度器。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **879 passed, 2 skipped, 1 warning** |
| 桌面单元/集成 | **310 passed, 1 skipped, 0 failed**（311 项） |
| 桌面类型检查 | **通过** |
| 真实 Edge 页面回归 | **9/9 套件通过**；文献页与 Dashboard 本轮再次复跑通过 |
| 文献页真实 Edge | **1/1 通过**，桌面 1440×1000 与移动 390×844 |
| Web 资源版本 | **1.4.0** |
| 打包态 Electron smoke | **10/10 检查通过** |
| 安装器生命周期 | **10/10 步骤通过** |
| SBOM | **CycloneDX 1.5，418 个组件** |
| 静态安全扫描 | **0 HIGH / 531 LOW**，20 个测试夹具已登记 |
| Windows 安装包 | `Eve-Setup-1.4.0-win-x64.exe` |
| 安装包大小 | **144,531,378 bytes** |
| 安装包 SHA-256 | `bf3c62276dd66fb3993b705f467eece6638d63ae1fb53e4001b85797180a3374` |

两个 Python 跳过项均来自当前 Windows 用户不能创建符号链接，不是功能失败。

## 文献雷达

文献雷达把“检索、阅读、沉淀、反思、分享”接入当前工作区：

- Europe PMC、OpenAlex、bioRxiv 与 arXiv 并行检索；单一来源失败只记录 warning。
- 研究论文、综述、方法与观点按元数据和摘要分类，显示兴趣度、相关度、时效、跨学科桥接和接地新颖性。
- 新颖性只与检索到的更早先验工作比较；找不到先验工作或日期精度不足时明确显示未评分，不生成伪精确数值。
- 用户可投喂本地工作区 PDF 或上传 PDF。解析只接受带文本层的 PDF，并拒绝 junction/reparse point 越界。
- 文献动态支持评论、减少同类、收藏和打开原文；评论会回流到对应记忆节点。
- 主动分享受每日额度、冷却和时效约束；关闭功能或额度不足只延期有效消息，不把消息误标为过期。
- 精读生成反思、方法步骤、项目映射、实验想法和孤立技能候选，全部进入人工审核。

自动日循环只在 Eve 应用运行且对应工作区启用时执行。它不是常驻云任务；应用退出后不会继续检索、反思或发布。

## 技能图与辅助模型

`Platform.skill_graph` 是技能检索的唯一入口：

- 词法匹配形成种子，反向感知的 Personalized PageRank 沿依赖边回溯。
- 返回有界、依赖闭合的技能束；字符预算不足时不返回被截断的半条依赖链。
- 成功执行只强化实际共用的边；失败或放弃不产生共学边。
- 未变化节点不重复写入，引用匹配正则按同步批次预编译。
- 文献生成的新技能默认停用且孤立，模型不能自行启用；只有用户审核确认后，后续真实使用证据才能逐步建立连接。

设置中的辅助模型按任务标签路由：`literature.embedding`、`literature.extraction`、`literature.classification`、`reflection.reasoning` 与 `skill.extraction`。标签未配置时回退到角色模型或主模型；原模型配置接口保持不变。

公共生物医学数据能力继续按 `Collector → Evaluator → Curator` 组织的 `science-public-biomedical-data` 技能执行，并接入许愿式科研。

## 关键修复

- 修复愿望失败节点重试竞态；提交失败时清理刚创建的空会话。
- 修复文献页异步响应晚到覆盖新状态的问题。
- 修复只有年份或月份时仍生成伪精确新颖性的情况。
- 修复引用数异常文本导致检索中断的问题。
- 修复重复 PDF 投喂返回结构不稳定的问题。
- 修复 arXiv `submittedDate` 日期过滤与本地日期范围不一致的问题。
- 修复技能图字符预算不足时返回部分依赖链、未变化节点重复写入和正则重复编译的问题。
- 开局提示弹窗收敛为标题、一句目的说明和单一主操作，并允许选择“下次不再提示”。
- 团队协作不再作为独立功能入口；主智能体按任务需要提出团队方案，子智能体在侧边栏展示并可继续对话。

## 真实证据

### 界面

- [研究总览桌面](dashboard-desktop.png)
- [研究总览移动端](dashboard-mobile.png)
- [移动端后续计划](dashboard-mobile-plans.png)
- [文献雷达桌面](literature-desktop.png)
- [文献雷达移动端](literature-mobile.png)
- [做梦与经验整理桌面](dreaming-settings-desktop.png)
- [做梦与经验整理移动端](dreaming-settings-mobile.png)
- [开局弹窗桌面](../onboarding-refresh/onboarding-desktop.png)
- [设置页模型配置](../platform-upgrade/settings-models-desktop.png)
- [设置页权限配置](../platform-upgrade/settings-permissions-desktop.png)

截图使用真实生产视图、本地 loopback API fixture 与 Edge 156 渲染；它们不是真实模型科研运行截图。

### 验证矩阵

| 证据 | 结果 | 文件 |
| --- | --- | --- |
| Python 全量 | 879 passed, 2 skipped | `python -m pytest -q`，375.70 s |
| 桌面单元/集成 | 310 passed, 1 skipped | `desktop/release/desktop-final-1.4.0.log`，44.02 s |
| 类型检查 | 通过 | `npm --prefix desktop run typecheck` |
| 文献雷达 | 1/1 | [literature-browser-results.json](literature-browser-results.json) |
| Dashboard 与反思门禁 | 11 类检查 | [dashboard-browser-results.json](dashboard-browser-results.json) |
| 打包态 Electron | 10/10 | [packaged-smoke.json](packaged-smoke.json) |
| 安装器生命周期 | 10/10 | [installer-lifecycle.json](installer-lifecycle.json) |
| 安装包清单 | 大小、blockmap、应用哈希 | [installer.json](installer.json) |
| SBOM | CycloneDX 1.5 | [sbom.cdx.json](sbom.cdx.json) |
| 静态安全扫描 | 0 HIGH | [security-scan.json](security-scan.json) |
| 发布校验和 | 5 个构建产物 | [SHA256SUMS](SHA256SUMS) |

本轮最终 Edge 套件覆盖 Agents、Artifacts、Dashboard、Literature、Onboarding、Settings、Teams、Terminal 与 Wishes。Teams 为 16/16，Terminal 为 16/16，Agents 为 5/5；包装脚本末尾出现一行格式异常的 `EDGE_SUITE failed= tests=9`，但各测试进程均以成功状态退出，包装行本身不是产品失败证据。

## 体量与性能

同条件基线为 Eve 1.3.0：

| 指标 | 1.3.0 | 1.4.0 | 变化 |
| --- | ---: | ---: | ---: |
| Windows 安装包 | 144,488,451 B | 144,531,378 B | +42,927 B（+0.030%） |
| 纳入版本控制的 `omicslab/web` 源码 | 1,223,549 B | 1,280,039 B | +56,490 B（+4.617%） |
| 文献与技能图 Python 实现 | 新增 | 123,650 B | 新增 |
| 文献页 JavaScript 与 CSS | 新增 | 45,700 B | 新增 |

Dashboard 在真实 Edge 156 的本地 loopback fixture 中测得：

| 指标 | 桌面 1440×1000 | 移动 390×844 |
| --- | ---: | ---: |
| Dashboard 挂载至首帧 | 78.6 ms | 16.1 ms |
| 图表指标切换至首帧 | 67.5 ms | 未单独计时 |
| 页面 DOM 节点 | 296 | 365 |
| 已加载资源（编码字节） | 110,301 B | 7,516 B |

技能图为进程内本机微基准，使用 29 项包内技能、最多返回 8 项：

| 操作 | 优化前同项目基线 | 1.4.0 最终复测 |
| --- | ---: | ---: |
| 首次同步 | 89 ms | 25.9 ms |
| 缓存同步 | 68 ms | 0.59 ms |
| 检索与依赖闭包选择 | 92 ms | 15.6 ms |

这些数字只覆盖本地静态资源、页面挂载、本地 API/SVG 重绘与进程内图计算，不包含模型推理、真实数据库延迟、网络抖动或科研计算。单次浏览器与微基准结果存在环境波动，不能外推为生产 SLA。

## 安装与校验

发布资产：

- `Eve-Setup-1.4.0-win-x64.exe`
- `Eve-Setup-1.4.0-win-x64.exe.blockmap`
- `installer.json` / `SHA256SUMS`
- `sbom.cdx.json`
- `security-scan.json`
- `packaged-smoke.json`
- `installer-lifecycle.json`

安装包为 per-user NSIS，可选择安装目录，卸载默认保留用户数据。安装包未签名，Windows SmartScreen 可能提示；受管环境部署前应完成组织签名策略。

## 未验证边界

- 没有使用真实计费模型完成一次从文献检索、技能沉淀到科研课题推进的长跑。
- 没有验证所有外部数据库、速率限制、断网恢复或公网长期稳定性；自动化测试主要使用确定性 fixture。
- 没有在干净 Windows VM、跨大版本升级矩阵或代码签名环境中验证安装。
- PDF 解析依赖文本层，不包含完整 OCR；扫描件需要先由外部 OCR 处理。
- 新颖性与跨学科分数依赖可检索先验工作，只用于筛选和反思，不构成同行评审或科研结论。
- 自动日循环、主动分享和自动做梦都只在应用运行且工作区启用时执行。
- 静态安全扫描不是渗透测试，不能证明第三方依赖与外部数据源绝对安全。
- 测试通过只证明代码、接口、浏览器与安装流程，不代表真实科研质量或科学结论成立。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck
node tests/frontend-literature.mjs
node tests/frontend-dashboard.mjs
python scripts/stamp_web_assets.py --check
npm --prefix desktop run dist:win
npm --prefix desktop run sbom
Push-Location desktop
node scripts/security-scan.mjs --out release/security-scan.json
Pop-Location

$env:SUWEN_SMOKE_PACKAGED='1'
$env:SUWEN_SMOKE_OUTPUT=(Resolve-Path 'desktop/release').Path + '\smoke-1.4'
npm --prefix desktop run smoke

powershell -ExecutionPolicy Bypass -File desktop/scripts/verify-installer.ps1 `
  -Installer 'desktop/release/Eve-Setup-1.4.0-win-x64.exe' `
  -Version '1.4.0' `
  -OutFile 'docs/verification/literature-1.4.0/installer-lifecycle.json'

node desktop/scripts/verify-doc-hashes.mjs
```
