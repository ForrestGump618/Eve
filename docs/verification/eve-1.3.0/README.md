# Eve 1.3.0 研究总览验收

> 验收日期：2026-10-29
>
> 分支：`codex/eve-1.0-science`
>
> 目标平台：Windows x64（安装包未签名）

本轮把默认首页收敛为“研究总览”，直接展示课题进度、运行质量、Token
与耗时趋势、最近活动、后续计划以及待确认的经验建议。所有入口继续复用现有
`RunService`、会话、科研愿望与设置服务，没有新增第二套调度器。

## 交付结论

| 项目 | 结果 |
| --- | --- |
| Python 全量回归 | **857 passed, 1 skipped, 1 warning** |
| 桌面单元/集成 | **310 passed, 1 skipped, 0 failed**（311 项） |
| 桌面类型检查 | **通过** |
| Dashboard 真实 Edge | **通过**，桌面与 390 px 移动端 |
| Onboarding / Wishes / Settings / Artifacts / Teams | **全部通过**；Teams 16/16 |
| Web 资源版本 | **1.3.0** |
| 打包态 Electron smoke | **10/10 检查通过** |
| 安装器生命周期 | **10/10 步骤通过** |
| 静态安全扫描 | **0 HIGH / 531 LOW**，20 个测试夹具已登记 |
| Windows 安装包 | `Eve-Setup-1.3.0-win-x64.exe` |
| 安装包大小 | **144,488,451 bytes** |
| 安装包 SHA-256 | `0b943d8a1c1422a76713a801670455131b4f31c4bb0affd781e86b6e92c62a54` |

## 研究总览

`GET /api/platform/dashboard` 只返回现有数据的聚合投影，页面不直接读取数据库，
也不会因打开 Dashboard 启动任务。

- 顶部数值卡展示课题平均进度、运行成功率、累计 Token 与平均运行耗时。
- 趋势图支持 7 天与 30 天切换，以及 Token、请求数、平均耗时、估算成本四种指标。
- 图表数据点支持鼠标悬停、键盘焦点、左右方向键浏览与 Escape 关闭提示。
- 运行结果条按完成、异常、进行中/其它分组，并显示成功率、模型请求数与延迟。
- 课题卡显示当前阶段、阶段完成比例、阻塞数、下一步和更新时间。
- 后续计划区分“你”与“智能体”负责的事项，并可直接进入对应科研愿望。
- 最近运行、最近会话和待确认经验建议均可在主视图继续处理，不暴露原始 JSON。
- 移动端保持页面宽度稳定，内容在视图内部滚动，图表控件维持可点击尺寸。

实现位置：

- API 投影：`omicslab/server/routes_platform.py`
- 页面：`omicslab/web/js/views/dashboard.js`
- 样式与图表令牌：`omicslab/web/css/platform.css`
- Edge 回归：`tests/frontend-dashboard.mjs`

## 关键界面证据

- [桌面研究总览](dashboard-desktop.png)
- [移动端研究总览](dashboard-mobile.png)
- [移动端后续计划](dashboard-mobile-plans.png)
- [做梦与经验整理：桌面](dreaming-settings-desktop.png)
- [做梦与经验整理：移动端](dreaming-settings-mobile.png)

截图使用真实生产视图、本地 loopback API fixture 和 Edge 156 渲染；它们不是
真实模型科研运行截图。

## 验证矩阵

| 证据 | 结果 | 文件 |
| --- | --- | --- |
| Python 全量 | 857 passed, 1 skipped | `python -m pytest -q` |
| 桌面单元/集成 | 310 passed, 1 skipped | `npm --prefix desktop test` |
| 类型检查 | 通过 | `npm --prefix desktop run typecheck` |
| Dashboard 与经验整理 | 11 类检查通过 | [dashboard-browser-results.json](dashboard-browser-results.json) |
| 打包态 Electron | 10/10 | [packaged-smoke.json](packaged-smoke.json) |
| 安装器生命周期 | 10/10 | [installer-lifecycle.json](installer-lifecycle.json) |
| 安装包清单 | 大小与 SHA-256 | [installer.json](installer.json) |

Dashboard 浏览器检查覆盖桌面和移动端渲染、7/30 天切换、四种指标切换、
键盘提示、课题进度、后续计划、内部滚动、无页面级横向溢出、无原始 JSON，
以及经验整理的人工确认门禁。

## 体量与性能

同条件基线为 Eve 1.2.0 安装包：

| 指标 | 1.2.0 | 1.3.0 | 变化 |
| --- | ---: | ---: | ---: |
| Windows 安装包 | 144,305,025 B | 144,488,451 B | +183,426 B（+0.127%） |
| `omicslab/web` 版本控制源码 | 1,159,930 B | 1,223,549 B | +63,619 B（+5.49%） |
| Dashboard 浏览器视图 | 新增 | 32,473 B | 新增 |
| Dashboard 样式所在 `platform.css` | 未单列 | 79,609 B | 随页面扩展 |

真实 Edge 156 的本地 loopback fixture 测量：

| 指标 | 桌面 1440×1000 | 移动 390×844 |
| --- | ---: | ---: |
| Dashboard 挂载至首帧 | 128.00 ms | 16.50 ms |
| 7 天切换至 30 天首帧 | 100.70 ms | 未单独计时 |
| 页面 DOM 节点 | 262 | 331 |
| 已加载资源（编码字节） | 108,038 B | 7,214 B |

这些数字只覆盖本地静态资源、页面挂载、本地 API 响应和 SVG 重绘，不包含模型
推理、数据库延迟、SSH 或真实科研计算。单次浏览器测量存在运行环境波动，不能
外推为端到端性能保证。

## 安装与校验

发布资产：

- `Eve-Setup-1.3.0-win-x64.exe`
- `Eve-Setup-1.3.0-win-x64.exe.blockmap`
- `Eve-installer.json`
- `SHA256SUMS`
- `sbom.cdx.json`
- `security-scan.json`

安装包为 per-user NSIS，可选择安装目录，卸载默认保留用户数据。安装包未签名，
Windows SmartScreen 可能提示；受管环境部署前应完成组织签名策略。

## 未验证边界

- 没有使用真实计费模型完成一次从课题建立到人工复核的科研长跑。
- 没有执行真实多组学分析、真实公共数据库全量检索或湿实验验证。
- Dashboard 展示的是现有数据投影；没有数据时显示空状态，不生成虚构趋势。
- 打包 smoke 使用本地 OpenAI-compatible HTTP fixture，安装器生命周期仅在宿主执行，
  不是干净 Windows VM。
- 没有代码签名、长时间耐久、公网 SSH 抖动或跨大版本升级矩阵证明。
- 静态安全扫描不是渗透测试，也不能证明第三方依赖和外部数据库绝对安全。

## 复现命令

```powershell
python -m pytest -q
npm --prefix desktop test
npm --prefix desktop run typecheck
node --test tests/frontend-dashboard.mjs
node tests/frontend-onboarding.mjs
node tests/frontend-wishes.mjs
node tests/frontend-settings.mjs
node tests/frontend-artifacts.mjs
node --test tests/frontend-teams.mjs
python scripts/stamp_web_assets.py --check
node desktop/scripts/verify-doc-hashes.mjs
```
