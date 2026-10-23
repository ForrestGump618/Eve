# 素问 V2 运行与维护

本文件说明 2.0.0 的启动参数、数据目录、模型配置、SSH 工作区、任务与恢复、MCP/渠道、代码隔离和备份流程；接口细节见 [API.md](API.md)，实现状态见 [实现清单](SUWEN-V2-CHECKLIST.md)。

## 文件与服务

本交付是原工程的独立副本。运行根目录 `启动工作台.ps1`，或在项目根目录执行：

```powershell
python -m omicslab serve --workspace . --home .omicslab --port 8766
```

本地地址：<http://127.0.0.1:8766/>。API 文档：<http://127.0.0.1:8766/api/docs>。使用其他端口时同步替换地址。后台进程退出后，任务不继续运行；关闭浏览器不会停止仍在运行的后端。

`settings.json`、SSH 档案与主机指纹保留兼容格式。原工程的会话、图表和轨迹已复制，原执行数据库使用 SQLite backup API 一致性复制。`workspaces.json` 的默认本地根目录重定位到交付副本，并保留已建立的 SSH 工作区。迁移清单为内部交付产物，未随仓库发布（`DATA-MIGRATION-V2.json` 已被 `.gitignore` 排除）。不复制旧进程的连接文件、活动内核或内存中的临时密码。

新增平台数据：

```text
.omicslab/
  settings.json                 原有连接/内核配置
  workspaces.json               本地/SSH 工作区注册表
  runtime/events.db             原有 Run/SSE/审批事件
  suwen/platform.db             配置/队列/知识/来源/结论/审计/用量
  suwen/blobs/<sha256>           产物版本内容
  suwen/skills/<scope>/<name>/   受管理的技能版本
  backups/                      自动迁移与手工备份
```

## SSH 作为工作目录

打开 SSH 页，在现有连接卡片选择“作为工作区打开”，填写远端目录并验证。或工作台“新建工作区 → SSH 远程工作区”。选择这个工作区后，标准文件、变量、Python 控制台、Agent 标准计算工具与远端 worker 使用该目录。附件上传也通过工作区接口发送到所选目录。

错误路径或失联会明确报错，禁止静默改用本地。远程 Python 需满足 worker 运行条件；不假定服务器安装了本机的科学计算库。测试替身不能代替真实 SSH 验收。已有临时密码需要重新填写，路径验证成功后才建立工作区。

历史独立变量/文件/图库页面和旧 Discovery 引擎保留旧作用域；远程任务应使用统一工作台、新任务中心及新科研证据模块。旧 Discovery 报告不是新证据门控已经通过的证明。

## 模型与隐私

普通用户选择快速、均衡、深度。连接设置保存实际 Provider、模型、URL 和密钥。角色模型可用 `text/reasoning/code/vision/embedding`，例如：

```json
{
  "text":{"provider":"ollama","model":"your-local-model","api_base":"http://127.0.0.1:11434/v1"},
  "code":{"provider":"custom_openai","model":"your-code-model","api_base":"https://your-provider.example/v1","credential_ref":"code-key"}
}
```

示例模型名与域名是占位，不能直接连通。先在凭据入口保存 `code-key`。视觉与嵌入还有独立设置，其显式字段优先于角色配置。

默认不强行传 temperature，模型能力记录可明确启用。OpenAI 兼容请求收到参数不支持错误时，有限次删除 temperature 或改用 max_completion_tokens。已输出内容后不重放请求或切换备用模型。无效备用连接写日志并跳过；不以 mock 作为真实模型故障后的成功降级。

上下文按保守字符预算裁剪，保留最近目标与完成的工具调用关系；不是精确 token 计数或语义摘要器。本地隐私策略只允许文本/视觉/嵌入模型访问回环地址。外部 API 嵌入会传送文本，默认使用本地关键词检索；本包没有本地神经嵌入权重。

## 任务、审批与恢复

- 普通聊天 Run 使用原有事件存储；任务中心使用独立持久队列，模型节点调用相同 RunService。
- DAG 提供 model/tool/condition/approval/output 节点，通过 `depends_on` 控制串并行。条件节点用前置结果的字面包含规则，不执行任意表达式。
- 工具按工作区权限和 Agent 授权执行。审批中心提供真实工具审批；工作流审批节点独立保存。
- 节点成功后保存 Checkpoint。后端重启时，运行中的任务转 interrupted，用户检查外部操作后恢复。恢复不重放已成功节点；当前未完成节点可能已经产生部分外部操作。
- 同一工作区的共享计算内核串行执行，避免多个 Agent 或控制台互相污染变量。不同工作区使用不同计算作用域。
- 显式幂等键去重任务/消息，不代表任意外部系统“恰好执行一次”。连接中断、强制终止和 Shell 外部进程需检查实际状态。
- 科研门控为 needs_review 时，先在科研与证据中心补充和复核，再从检查点继续更新任务状态。

## MCP 与渠道

MCP 创建后默认停用。配置命令/参数或 HTTP URL、允许工作区/Agent、必要的 env/header 凭据引用。启用后“测试并发现工具”会启动真实子进程或发起 HTTP 握手；“工具测试”会真实执行，界面要求检查参数和确认。

`mcpServers` JSON 导入时，env/header 值经 DPAPI 加密再保存引用。stdio 服务是本机进程，配置来源需可信；不是自动进入 Docker。MCP OAuth 需要在原服务完成授权，当前没有内嵌完整 OAuth 登录流程。

WebChat 是本地适配层；Telegram 使用 Bot API。Webhook 必须有共享密钥，陌生联系人拒绝，默认只读，主动外发需开启且逐次确认。微信、企业微信、飞书、QQ、OpenClaw 显示需要外部适配器，没有伪造扫码或连接成功。

## 代码隔离

常规本机 Python/Shell 权限等同运行用户，工作区路径校验不构成操作系统沙箱。对不可信代码显式选择 `sandbox_python`。它需要已安装 Docker、可用 daemon 和预先准备的官方 `python:3.12-slim` 镜像；不自动拉取，不可用时拒绝主机回退。

容器仅绑定当前本地工作区，断网、只读根文件系统、非 root、去 capabilities、限制 CPU/内存/PID/时长。绑定目录允许代码读写项目文件；沙箱不保护绑定目录中的数据。此工具不支持 SSH 工作区，未进行本机真实 Docker 容器验收。

## 备份与恢复

设置 → 版本与迁移支持脱敏配置导出/导入、设置版本回滚、平台 DB 在线备份。产物恢复会先快照当前文件，再按原路径精确恢复历史内容。

平台数据库灾备流程：停止素问 → 复制当前 `.omicslab` 到另一备份目录 → 将选定备份 DB 放回 `suwen/platform.db`（保留原文件和相关 WAL/SHM，不在运行时替换）→ 确认所选备份时间及数据 → 重新启动。配置 DB 不包含外部大文件；`suwen/blobs`、受管理 Skills、原会话和 `runtime/events.db` 应随整个数据目录备份。DPAPI 凭据密文依赖 Windows 账户，跨设备迁移需重新输入密钥。

## 模块与 API

| 模块 | 文件 | 主要接口 |
|---|---|---|
| Model Gateway | `suwen/models.py` | scoped 模型准备、上下文、故障切换与用量 |
| 配置/凭据/存储 | `configuration.py` / `vault.py` / `store.py` | config、credentials、configuration export/import、backup |
| 任务与调度 | `tasks.py` / `service.py` | tasks、task control、debate、registry/schedule |
| 知识与记忆 | `knowledge.py` | knowledge、search、upload、reembed |
| 扩展 | `mcp.py` / `extensions.py` | registry、mcp discover/test、skills install、channels webhook/send |
| 生物与证据 | `biomedical.py` | biomedical、research、claims verify/review |
| 产物/视觉/诊断 | `service.py` | artifacts、reviews、diagnostics、layout |
| HTTP | `server/routes_platform.py` | 统一前缀 `/api/platform`，有 scope 的接口先校验工作区 |

接口错误不回退其他工作区；配置导入先逐项验证，再备份与写入。UI 调用真实服务，额外公共能力以 API 文档和实现清单为准。

---

本文件对应 Suwen 2.0.0。
