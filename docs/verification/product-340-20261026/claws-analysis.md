# ClawsGO 1.1.3：安装包分析与素问采用记录

分析对象为用户指定的 `C:\Users\Qingyuan Zhuang\AppData\Local\Programs\@clawsgodesktop`。只读取安装包；实际启动使用独立临时 `--user-data-dir`，未读取现有账户配置、登录或绕过认证。

| 标识 | 实测值 |
|---|---|
| package | `@clawsgo/desktop` 1.1.3，region cn |
| Electron 主入口 | `dist/main.js` |
| app.asar SHA-256 | `e21b73cfeabd98ace9be44606ca7930e652fd8e77e14600a2836edcbe1aa0b58` |
| ClawsGO.exe SHA-256 | `9d58e682afcf2e9a9dbff26282b2a9c8167da55363658830ebbe22b8a4be1eb2` |
| 实际运行 | `app://bundle/login`，标题 ClawsGO Science；见 claws-runtime.json / claws-isolated-initial.png |
| REA 静态证据 | `ev_bd15c36551e911d019a97445d0a86703a58f36060e2169ce134c91bd087b63a5` |

## 能确认的设计与采用方式

| 安装包位置 / 观察 | 价值 | 素问对应改动 |
|---|---|---|
| `dist-app/assets/ChatMessageParts-CbOSNp3p.js` 的 run 分组及长过程折叠逻辑 | 将正文和执行过程分开，保留逐步诊断入口 | 每条回答一个默认折叠的执行记录；步骤状态、耗时、错误及原始结果可展开；历史恢复同一分组 |
| 同模块的 resume / compaction / stopped / error 部件 | 接续、压缩、停止不能冒充完整成功 | 保留统一 Trace，增加 model.truncated / model.continuing；最多三次接续；不执行截断的工具参数 |
| `sidebar-CGY2gVSM.js` 的侧栏偏好和尺寸状态 | 用户可把空间还给正文，偏好重启后仍在 | 复用素问已有 splitter，增加桌面侧栏折叠及偏好持久化 |
| `SkillDetailDialog-BRCX8h_A.js` / skills 模块有技能详情和分组入口 | 技能应能发现并检查内容，不能只是装饰名称 | 预装真实文件、许可证和版本；聊天与能力中心共用原生 Registry；skill_load 返回资源目录，skill_read_resource 逐项读取 |
| 外置 `resources/daemon/dist/index.mjs` 的 pickWorkdir / checkWorkdir / stageSkills | 工作目录与技能部署属于实际执行边界 | 在输入区增加工作目录和技能入口；将已选目录传到 TS 文件工具；文件写入要求旧内容哈希 |
| daemon 的 30s presence、[500,1000,2000,4000,8000,15000] 退避及 watchdog | 长任务需与窗口生命周期分离，连接恢复须有限 | 保留素问已有脱离 UI 的 durable daemon 和退避机制，补版本协商；空闲旧后台升级，有未结束任务时保留 |
| `dist/main.js` 的 cn/global 用户目录分区与单实例 | 生命周期与账户状态需明确 | 沿用素问现有隔离 profile / 单实例 / safeStorage，不导入其他程序账户配置 |

这里采用交互结构和工程原则；未把 ClawsGO 的私有代码、图标、CSS 或品牌资源复制进素问。实际产品改动在 code-locations.csv，ClawsGO 原始选定文件只留在临时分析目录。

## 覆盖和未知

REA 对明确选择的四个 JS 文件进行了静态分析：198391 字节、55059 个 AST 节点、330 个 finding、0 个语法解析失败。语义节点上限为每文件 3000、总体 12000，SkillDetailDialog 的部分语义分析还触发 worker heap 限制，因此**图覆盖是 partial**，不能用缺少 finding 证明能力不存在。完整限制保存在 claws-rea-evidence.json；62MB 完整 Evidence bundle 的本地位置与 SHA 在 claws-full-evidence-location.json，未放入产品或 Git 大文件。

实际界面启动仅验证到登录页；登录后的聊天折叠交互来自安装包静态代码观察，未做账户内交互验收。外置 daemon 可确认设备桥接、工作目录和技能部署；当前证据不能恢复服务器端模型调度、云 Agent Loop、云技能全集或其可靠性。没有宣称完整复刻这些能力。

可复查方式：对同 SHA 的 app.asar 用 REA `analyze_javascript_application`，format=asar，source_paths 选择 `dist/main.js`、上述 ChatMessageParts、ChatMessages-D9gU1ZGH.js、SkillDetailDialog；选定文件清单与内容 SHA 在 claws-reference-path.json。

## 开源技能来源

- [OpenAI skills](https://github.com/openai/skills)，commit `49f948faa9258a0c61caceaf225e179651397431`：skill-creator、skill-installer。原始文件逐个 Git blob 比对全匹配，Apache-2.0 许可证保留；SuWen 的 skill.json 是新增适配清单，非上游执行入口。详见 bundled-provenance.json。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，commit `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`：dsh-error-handling，保留 MIT 许可证。实际 GitHub 下载与固定 SHA 安装见 tools-e2e.json。
- 五个 SuWen 基础技能为本项目实现；其中 csv-analysis、descriptive-stats、json-transform 有实际 Python run 入口，另两个为文件/文献工作流指引。

DSH 更完整的 Cordis、Agent Loop、Registry、MCP 等审查见上一轮 `../harness-20261025/architecture.md`。本轮继续采用 Adapter 和同一执行核心，没有替换成第二套竞争的 Harness。
