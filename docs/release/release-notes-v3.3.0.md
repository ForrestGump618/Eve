这次更新解决两个具体问题：一是桌面端此前只复刻了网页版的一部分，二是聊天里的 Markdown 长期停留在“能显示纯文本”的程度。前一件事的做法不是重写网页版，而是把它原样放回桌面；后一件事则把公式、流程图和流式渲染补到了可用状态。

## 网页版工作台进入桌面

网页版是素问 2.x 时代的产品界面：20 条路由、14 个视图模块，对话、发现、文件、图表、任务、技能、注册表、记忆、SSH、设置与诊断都在同一个工作区里。把这套界面逐页改写成原生代码，工作量和回归风险都很大，最终选择是**托管**：桌面端保留原生框架，同时新增第六个工作区“实验工作台”，由它管理一个隔离的 Python 运行时，并在独立窗口中打开原本的网页界面。窗口里看到的 HTML、CSS、JS 与网页版完全一致，因此布局、交互、快捷键都不需要重新对齐。

运行时按需安装，固定 13 个顶层依赖，约 130 MB，下载与占用会在界面上提前写明；安装目录使用标记文件绑定依赖哈希与 Python 小版本，升级依赖后会重新校验，装坏了可以修复，也可以随时取消。没有把 Python 打进安装包，是因为面向的用户大多已经有 Python 环境，也不想为一个可选组件把安装包再撑大一百多兆。

托管窗口做了几层隔离：随机回环端口、一次性令牌、只给该窗口注入 Authorization 头、页面拿不到 Node 与 preload、导航限制在托管源内。桌面端配置的模型与密钥在打开窗口时通过环境变量传入，只存在进程内存里，不写入网页版存储，也不落盘；在桌面设置里改了模型，要关掉窗口重开才生效。

## Markdown：流式、公式、流程图

之前的渲染器只有基础语法，公式和 Mermaid 一律降级成代码块；流式输出时整段消息还是纯文本，回答结束才排版。这一版改成按“稳定前缀”增量渲染：已经闭合的段落、代码块、表格、公式可以先排版，正在输入中的代码围栏、表格或公式保持原文，等闭合后再切换。重建节奏是 110 ms，实测 10,000 字符、500 次增量的排版总耗时 42–44 ms，输入框和滚动位置不跟着跳。

公式用离线内置的 KaTeX 0.16.21（含字体），Mermaid 用 11.12.0，同样内置、懒加载、按时间片执行，不联网、不走 CDN。安全策略上 `script-src` 仍是 `'self'`，不执行 HTML；Mermaid 使用 `securityLevel: strict`，渲染失败时明确退回代码块。为了让 KaTeX 与 Mermaid 的内联样式生效，样式来源放开到 `'unsafe-inline'`，这一点已写进安全评审，接受的代价与回退方案都在里面。

## 验证

所有数字都来自本机 Windows 11、Node 24.14、Python 3.11.9 的实测，不是估算：

- 托管工作台 Electron E2E：34/34 项通过，12/12 条主路由真实渲染，19 张截图，0 页面错误、0 控制台错误、0 CSP 违规；流式过程中已闭合的公式已排版、未闭合的 Mermaid 围栏保持原文。
- 桥接运行时 smoke：27/27（SPA 资源、未认证 401、19 个 API、新建会话与 run、干净关闭）；模型配置注入 13/13。
- Markdown 单元测试 32/32；桌面端全量测试 222 项，220 通过、0 失败、2 跳过（Windows 符号链接权限与可选旧版 Python 依赖）。
- 打包应用 smoke 10/10（含托管网页版窗口）；RPC E2E 42/42，其中包含真实的 Europe PMC 与 UniProt 请求；故障注入 12/12。
- 安装/启动/升级/卸载：宿主环境 12/12，包含从 3.0.0-preview.1 升级到 3.3.0。

## 已知限制

- 安装包**未签名**，Windows SmartScreen 会提示；干净 Windows 虚拟机上的完整安装流程尚未执行。
- 8/24/72 小时长时运行、重启/断电/睡眠/磁盘满等场景没有跑过，只做了短时故障注入与加速 soak。
- 真实厂商模型账号、真实 SSH 主机与消息渠道对端没有配置，相关条目仍是未验证状态；网页版里上传、内核执行、审批、SSH 执行等深层操作只做了冒烟级验证。
- 托管网页版本身是中文界面，没有做无障碍与高 DPI 审计；运行时安装在真实 `userData` 路径下的流程用临时目录替代验证。
- 网页版的旧会话不会自动迁移，需要在桌面端先执行导入；托管环境是独立 home。

## 安装与校验

从本 Release 下载 `SuWen-Setup-3.3.0-win-x64.exe`（131,011,183 字节），校验 SHA-256：

```
0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03  SuWen-Setup-3.3.0-win-x64.exe
```

对应 `win-unpacked/SuWen.exe` 的 SHA-256 为 `469D75AD64B449B98D5DB8F7D1C64C0F988F8D2F99F6B04CD213A4481A0FA991`。完整校验文件见 Release 附件 `SHA256SUMS.txt`。

网页版工作台是可选组件：首次点“打开实验工作台”时会提示安装运行时，需要联网并占用约 130 MB 磁盘；不安装也不影响原生工作区、对话与 Markdown 渲染。

源码与文档在 <https://github.com/ForrestGump618/suwen>。桌面端代码以 MIT 发布，仓库内保留的旧版 Python 工作台为 Apache-2.0；第三方组件许可见 `desktop/NOTICE` 与 `third-party-licenses/`。

## English summary

SuWen Desktop 3.3.0 brings the legacy web workbench into the desktop app as a hosted, isolated window backed by an on-demand pinned Python runtime, and closes the markdown gap with progressive streaming rendering plus offline KaTeX and Mermaid. Evidence on this build: hosted E2E 34/34, runtime smoke 27/27, config injection 13/13, markdown unit tests 32/32, full suite 222/220/0/2, RPC E2E 42/42, chaos 12/12, installer lifecycle 12/12. The installer is unsigned; clean-VM installation, long-duration endurance, and real vendor accounts remain unverified.
