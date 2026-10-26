# 架构改造记录

执行权仍由现有 SQLite WAL Store / Engine 拥有：任务 DAG、租约、fencing、心跳、暂停/恢复、有限重试、取消、预算和最终提交均复用。默认聊天的 model activity 内包含模型协议循环，不另建调度器。

```text
正式科研 UI → 已认证 HTTP/SSE → Python RunService（会话/展示投影）
  → DesktopHarness Adapter → 已认证 named pipe → 既有 Engine / Store
  → model activity → ModelRuntime 配置快照
  → model decision → ToolRegistry → Search / MCP / Skill / granted file
  → structured observation → model decision → Verify → fenced completion
  → 事件/正文快照 → Python SSE → 正式 UI
```

简单问答只发一个模型请求；复杂请求根据模型实际提出的工具序列记录 Plan→Act→Observe→Verify。没有为了普通检索引入多 Agent 讨论，也未删除原专家、辩论、裁判、科研工作流或 Python Worker。

统一 Registry 拒绝重名；普通 Tool 为搜索/读取/数据库，MCP 负责动态发现和跨进程工具调用，Skill 负责可审查的版本化指令及 manifest.run，Workflow 继续由既有研究活动/DAG 负责。默认工具串行执行（并发 1），外层活动并发仍由 Engine 控制。预算覆盖每次模型和工具请求，工具重复上限 2 次，模型回合与工具总次数均有界。

上下文先走既有 prepareContextAsync；循环内只在超预算时截断较早的工具 observation，保留调用/结果配对和原始产物。每轮 checkpoint 保存协议历史、来源和 hash；重启后的付费调用仍需既有副作用核查，不声称已实现任意指令位置的无损自动续跑。

Trace ID 包含 task/step/fence；事件记录模型请求、Token、工具调用、时长、错误、来源 hash、验证结果及产物引用。不记录 API Key，不保存模型私有 reasoning_content；必要的 provider reasoning 仅保留在当前请求内存中。最终 UI 显示实际工具状态，不把加载 Skill 或连接 MCP 当成执行成功。

## 公开实现参考及取舍

DSH 参考固定为 **0.2.1-rc.3 / `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`**，2026-10-25 从官方仓库 shallow clone 到临时目录。没有安装或启动 DSH，也没有导入整个依赖树。

| 审查对象 | 参考实现 | 本项目采用方式 |
|---|---|---|
| Cordis 生命周期 | [cordis-host-runner](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/extensions/cordis-host-runner/src/index.ts) | 借鉴作用域资源清理；暂不把已持久化 Engine 改成 Cordis，避免破坏运行恢复与权限边界 |
| Agent Loop | [agent-loop/agent.ts](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/agent-loop/src/agent.ts) | 借鉴逐步工具激活、结果回写、停止/恢复边界；以现有 activity 内协议循环实现 |
| Registry | [core/tools](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/core/tools/src/index.ts) | 名称冲突失败、每任务独立注册表；参数校验直接复用 Ajv |
| 检索 | [web service](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/web/web/src/index.ts) | Search/Fetch seam、显式 provider 和失败诊断；本项目使用 Bing RSS / DuckDuckGo，未假设用户有第三方搜索 key |
| MCP | [mcp-client](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/mcp/mcp-client/src/index.ts) | 借鉴命名空间、连接生命周期和工具实际发现；复用本项目已测的 stdio client，补 HTTP/session/parser |
| Skills | [tool-skill](https://github.com/deepseek-ai/deepseek-harness/blob/22ddee3792402c3e70ec5f86a63c3e3e895a2f60/packages/skill/tool-skill/src/index.ts) | 元数据目录与内容加载分离；现有安装器、扫描器、Worker 复用 |
| 事件/Client 扩展 | agent/status、session/tool result 和 Cordis Host/Client seam | 保持素问现有 stream schema；通过 Adapter 向正式 UI 投影，不引入第二个前端运行时 |

[OpenAI Agents SDK 的运行循环文档](https://developers.openai.com/api/docs/guides/agents/running-agents)用于核对“模型→工具→结果→继续→最终输出”的协议语义。没有直接替换为 SDK runner：本项目已有持久化 Engine、独立 daemon、付费副作用核查和两种模型协议，未经全量迁移验证直接换掉会扩大风险。[Ajv](https://ajv.js.org/guide/getting-started.html)则作为成熟依赖实际集成，版本固定且随包附许可证。

本轮不宣称已迁移 DSH Client 插件系统、完整 MCP 协议版本协商、所有旧科研 Skill 的统一执行、嵌入式语义检索或 OS 沙箱。这些界限见未解决清单。

2026-10-26 增量：为 GitHub 仓库元数据增加有严格 owner/repo 匹配的 API→网页来源 Adapter，同时保留 retrievedUrl；中文引用边界不再吞入括号。没有放宽任意链接引用权限。原生页面补会话 epoch、显式新建状态和结构重建后的流式补丁；Electron 窗口拥有者在异步完成及 closed 回调前检查存活，应用退出时停事件泵与重连。原始失败和最终证据分别保存，报告脚本从真实任务事件恢复失败 Trace，固定任务不变。
