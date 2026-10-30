# Eve 1.0.0 正式发布验收

> 验收日期：2026-10-30
>
> 目标平台：Windows x64
>
> 安装包：`Eve-Setup-1.0.0-win-x64.exe`（未签名）

本轮完成 Eve 1.0.0 的科研写作与绘图技能接入、界面收口、接口稳定性修复、安装器验收和发布准备。所有 Agent 执行继续复用现有 `RunService`、工作区、技能图和审批门禁，没有增加第二套调度器。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **911 passed, 2 skipped, 1 warning** |
| 桌面单元/集成 | **266 passed, 1 skipped, 0 failed**（267 项） |
| 桌面类型检查 | **通过** |
| 真实 Edge 前端套件 | **10/10 套件通过** |
| 打包态 smoke | **10/10 检查通过** |
| 打包态实时数据库 smoke | **11/11 检查通过** |
| 安装器生命周期 | **10/10 通过** |
| 生产依赖审计 | **0 vulnerabilities**（9 个生产依赖） |
| CycloneDX SBOM | **1.5，294 个组件** |
| 静态安全扫描 | **0 HIGH / 322 LOW**，20 个测试夹具已登记 |
| 安装包大小 | **142,895,973 bytes**（136.28 MiB） |
| 安装包 SHA-256 | `a52dd5ea28909391055759a605580413c093f05ba17694429b94075eb17f0627` |

两个 Python 跳过项来自当前 Windows 用户不能创建符号链接；桌面跳过项为上肢已记录的宿主限制。测试通过只说明对应软件路径按检查项通过，不构成真实科研质量、临床有效性或外部服务长期可用证明。

## CNS/Sci 写作与绘图技能

本轮从 `K-Dense-AI/scientific-agent-skills` 固定提交
`5f2bc0341354fd5590aef76a533ada1e1e5b4e62` 安装并验证以下技能：

- `scientific-writing`：IMRaD 结构、论证顺序、摘要与标题收口。
- `scientific-visualization`：出版级图表、统计标注、色盲友好和期刊尺寸。
- `scientific-schematics`：机制图、流程图和矢量示意图。
- `citation-management`：检索、去重、引用核验和参考文献格式。
- `venue-templates`：CNS、Nature、Science、Cell 等投稿模板约束。
- `peer-review`：结构化审稿、证据强度和可复现性检查。

全局 Codex 技能目录为 `C:\Users\Qingyuan Zhuang\.codex\skills`；六项均通过 `quick_validate.py`。Eve 共享技能库保留同版本技能副本，并通过固定来源、`SKILL.md` 哈希和检索可用性测试防止静默漂移。

技能已接入 Agent Loop 的按需加载提示和中文精确意图检索，覆盖论文写作、投稿、引文、同行评审、出版图与示意图。技能仍按需读取，不整体注入上下文，新技能不会自动进入执行入口。

## 公共数据库稳定性

打包态实时 smoke 使用真实公共网络完成：

- Europe PMC / PubMed：查询 `TP53 cancer`，返回 **5** 条结果。
- UniProt 主接口：当前上游超时，产品自动回退到 EBI Proteins。
- EBI Proteins：查询 `gene:TP53 AND organism_id:9606`，返回 **5** 条结果。

回退链路具有独立超时、取消传播、来源标记和 `fallbackReason`，不会静默伪装成 UniProt 主接口成功。确定性测试覆盖 gene/taxid、accession、PubMed 回退和双接口失败。原始结果见 [packaged-live-mcp-results.json](packaged-live-mcp-results.json)。

## 界面与安装

- 安装与卸载界面使用与主程序一致的中性灰、单一强调色、统一圆角和排版，不再使用标准 NSIS 向导外观。
- 安装范围提供“仅为我”和“所有用户”，界面不展示管理员概念。
- 当前自动化只实测了逐用户安装；“所有用户”路径需要 UAC 提权，当前非管理员验收进程未执行。
- 安装器完成普通安装、版本元数据、应用启动、守护进程健康、界面关闭后守护进程存活、同版本重装、静默卸载、用户数据保留和注册表清理。
- 安装器与主程序均未签名，Windows SmartScreen 可能显示未知发布者。

## 性能

同一主机、同一编译产物的最终样本：

| 指标 | 收尾前样本 | 最终样本 |
| --- | ---: | ---: |
| 守护进程冷启动 P50 | 1,102.17 ms | **1,055.05 ms** |
| RPC create P50 | 1.061 ms | 1.160 ms |
| Event stream P50 | 2.031 ms | **1.610 ms** |
| Python worker health | 387.93 ms | 433.93 ms |
| FCS flowSummary | 21.93 ms | 22.44 ms |

这些是同机短时观测，不包含真实模型首 token、真实科研计算、8/24/72 小时耐久或跨机器比较。完整数据见 [performance.json](performance.json)。

## 验证证据

| 证据 | 文件 |
| --- | --- |
| Python / 桌面测试记录 | 本报告“交付结论” |
| 前端 Edge 套件 | [frontend-results.json](frontend-results.json) |
| 打包态 smoke | [packaged-smoke.json](packaged-smoke.json) |
| 打包态实时 smoke | [packaged-live-smoke.json](packaged-live-smoke.json) |
| 安装器生命周期 | [installer-lifecycle.json](installer-lifecycle.json) |
| 安装包与关键文件哈希 | [installer.json](installer.json) |
| SBOM | [sbom.cdx.json](sbom.cdx.json) |
| 生产依赖审计 | [npm-audit.json](npm-audit.json) |
| 静态安全扫描 | [security-scan.json](security-scan.json) |
| 性能基线 | [performance.json](performance.json) |
| 研究总览截图 | [dashboard-desktop.png](dashboard-desktop.png)、[dashboard-mobile.png](dashboard-mobile.png) |
| 设置页截图 | [settings-models-desktop.png](settings-models-desktop.png)、[settings-permissions-mobile.png](settings-permissions-mobile.png) |
| 开局弹窗截图 | [onboarding-desktop.png](onboarding-desktop.png)、[onboarding-mobile.png](onboarding-mobile.png) |

最终打包态 smoke 处理了应用关闭与 `taskkill` 之间的进程退出竞态；清理逻辑现在把“进程已经退出”视为幂等成功，只在进程仍存活时报告失败。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck
npm --prefix desktop audit --omit=dev

$env:EVE_SMOKE_PACKAGED = '1'
$env:EVE_SMOKE_OUTPUT = (Join-Path (Get-Location) 'desktop\release\smoke-1.0-final')
node desktop\scripts\electron-smoke.mjs

$env:EVE_SMOKE_LIVE = '1'
$env:EVE_SMOKE_OUTPUT = (Join-Path (Get-Location) 'desktop\release\smoke-live-1.0-final')
node desktop\scripts\electron-smoke.mjs

npm --prefix desktop run dist:win
powershell -NoProfile -ExecutionPolicy Bypass `
  -File desktop/scripts/verify-installer.ps1 `
  -Installer desktop/release/Eve-Setup-1.0.0-win-x64.exe `
  -Version 1.0.0 `
  -OutFile docs/verification/eve-1.0.0-release/installer-lifecycle.json

node desktop\scripts\performance-baseline.mjs `
  --out docs/verification/eve-1.0.0-release/performance.json
node desktop\scripts\verify-doc-hashes.mjs
```

## 未验证边界

- 尚未用真实计费模型端到端证明模型会在每次写作任务中自动选择这六项技能。
- `scientific-schematics` 的实际示意图生成需要 `OPENROUTER_API_KEY`；本轮只验证了技能安装、接口和调用边界。
- `scientific-visualization` 的完整 Python 3.11+/uv 示例依赖未在当前宿主逐一执行。
- 未在干净 Windows VM、企业软件分发环境或跨大版本升级矩阵中验证安装。
- “所有用户”安装的 UAC 后路径未实测。
- 安装包未签名；没有代码签名证书、SmartScreen 信誉或公开下载信誉。
- 静态安全扫描不是渗透测试；`npm audit` 只覆盖当前锁文件的生产依赖。
- 未执行 8/24/72 小时耐久、真实科研项目长期运行或外部数据库 SLA 验证。
