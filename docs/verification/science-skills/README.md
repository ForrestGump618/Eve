# 科学工具与退出交互验收

本记录对应 Eve 1.0.0，验收日期为 2026-10-28。机器路径、用户配置和凭据未纳入记录。

## 本次变更

- 增加 40 项科学技能、65 个执行脚本和 333 项文本资源引用。技能来源版本锁定为 1.3.1，提交为 `4de6786171f1479026da5d3a00f110703c8ba35e`。
- 沿用内容寻址、压缩存储与渐进加载。技能包增加 634,557 字节；22 张上游示例图片未打包，遗漏清单保存在 `desktop/skill-library/science-import-report.json`。原始许可与数据库条款保留。
- 增加 `skill_prepare`，检查资源哈希、运行环境和凭据是否存在；`skill_run` 将脚本交给任务绑定的本地或 SSH 执行环境。未连接远端时不回退本地。
- 科学脚本通过 `uv` 和参数数组执行。联网解析依赖需要明确启用，并遵循任务权限。超时、非零退出、资源被改动或结果截断均不标记为成功。
- 科学技能详情展示执行入口、必需与可选凭据，支持将选定技能填写到工作台。
- 关闭、未完成任务确认、后台连接异常和停止失败全部使用现有窗口内的弹窗，保留托盘与安全退出行为。

## 发现并修复的根因

| 问题 | 根因 | 修复位置 |
| --- | --- | --- |
| 本地技能执行后无法解析结果 | 本地内核返回 `outputs` 流，SSH 返回 `stdout`，适配器只读取后者 | `omicslab/server/routes_harness.py` 的 `backend_stdout` |
| 点击使用技能后输入框仍为空 | 页面异步挂载前就发出填写事件 | `omicslab/web/js/app.js` 与 `views/skills.js` |
| 新会话首次选择权限后恢复成默认值 | 选择事件在会话未创建时直接返回，新建会话又覆盖控件值 | `omicslab/web/js/views/chat.js` 的 `saveExecutionSelection` 与发送等待逻辑 |
| 退出确认与界面风格不一致 | 主进程直接调用系统消息框 | `desktop/src/window-prompt.ts` 与 `window-lifecycle.ts` |
| 按 Esc 后关闭流程可能一直等待 | 工作台已有弹窗的键盘处理先取消了浏览器默认事件 | 退出弹窗单独处理 Esc，并清理监听 |

## 验证范围

| 验证 | 结果 | 说明 |
| --- | --- | --- |
| TypeScript 构建与测试 | 280 通过，1 跳过 | 跳过项要求 Windows 符号链接权限 |
| Python 测试 | 629 通过 | 包含科学执行器、权限和结果适配 |
| 真实本地内核准备技能 | 40/40 | 校验并实际写入工作区资源，不计为科学任务完成 |
| 公开数据库查询 | 5/5 | Europe PMC、PubChem、ChEMBL、GTEx、UniProt，运行原始脚本 |
| 本机安装版科学技能 UI | 8/8 | 受控模型协议驱动真实工具和 PubChem 网络请求，保存并回读结果文件 |
| 本机安装版关闭与托盘 UI | 16/16 | 真实窗口、按钮、托盘与后台任务；异常分支对隔离测试实例注入故障 |

关闭测试还覆盖取消、Esc、重复关闭、记住选择、托盘恢复、隐藏窗口退出时重新显示确认、后台连接不可用、停止失败、运行中任务继续到托盘，以及明确停止后的运行时退出。测试断言整个流程没有调用系统消息框。

实际数据库结果包括阿司匹林 CID 2244（分子式 C9H8O4）、ChEMBL 记录 CHEMBL25、TNF 的 GTEx 标识、UniProt P04637，以及带原始标识符的 Europe PMC 文献记录。完整机器原始结果保留在本地验收目录，公开摘要见 `results.json`。

## 复现

在仓库根目录运行：

```powershell
python -m pytest -q
python scripts/verify_science_skills.py --output desktop/release/science-acceptance/live --live
```

在 `desktop` 目录运行：

```powershell
npm run typecheck
npm test
node scripts/science-skills-e2e.mjs --live
node scripts/tray-e2e.mjs --formal
```

本机安装版验收：

```powershell
node scripts/science-skills-e2e.mjs --live --installed
node scripts/tray-e2e.mjs --formal --packaged "--packaged-dir=C:\Users\<用户名>\AppData\Local\Programs\Eve"
```

测试采用隔离用户目录，退出时停止测试后台。原始用户配置和会话不参与修改。本次已同步本机安装版资源，并在覆盖前保留原程序资源供回退；没有上传安装包。

## 尚未验证

- 未提供 AlphaGenome 的有效凭据，未进行真实预测验收。
- PyMOL、OSMesa 等外部程序的运行环境未验收。
- SSH 路由与禁止回退已有自动化覆盖，本次没有新增生产 SSH 主机的在线科学任务验收。
- 界面端到端测试使用受控模型协议，不代表付费模型的科学推理质量。未声称重新通过此前全部科研任务集。
- 数据库测试没有同条件的改造前性能基线，不提供性能提升比例。
- 子进程执行不等于操作系统级安全沙箱。
