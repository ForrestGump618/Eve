# 根因报告

## 模型协议与编排

1. **无工具调用协议**：`desktop/src/providers.ts` 原请求只有 messages/max_tokens，SSE 只拼接 content；`desktop/src/activities/model.ts` 只调用一次 `model.call`。真实基线 22 项均无工具事件，全部被状态机标为 completed。修复增加原生 OpenAI/Anthropic 工具协议、碎片参数组装、调用 ID、tool_result 回传和有限协议循环。
2. **错误检索路由**：`desktop/ui/app.js::sendMessage/chatSteps` 把“检索”统一判断为 research，将整个中文问题截断后当 PubMed 查询；普通网页检索没有工具。修复让自动聊天通过统一工具循环选择网页/数据库，科研模式要求生成实际查询；保留显式辩论和研究工作流。
3. **工具结果并未参与下一次模型决策**：聊天只有文字模型调用，没有 Act→Observe。修复后回归测试断言下一次请求包含实际工具结果和对应调用 ID，工具错误也以结构化 observation 回传。
4. **成功条件只有“返回文字”**：旧代码接受“我不能联网”的回答作为成功。修复对所请求动作、非空结果、检索来源和引用 URL 做检查，允许一次修正，否则失败；截断输出不成功。当前验证是有限的机械检查，不是通用语义证明。
5. **模型配置竞态**：多轮调用每次读取全局配置；修改设置或另一会话可能切换当前模型。现在每任务绑定内存中的配置快照，正式 UI 可原子传入 modelConfig，凭据从任务定义中剥离，绝不持久化。
6. **429 被当作未知副作用**：旧模型错误无法区分 HTTP 拒绝与网络断流，会进入 waiting_approval。现在明确拒绝的 HTTP 状态是 definitive，429 有一次有界重试，持续失败保持失败。网络/5xx 的潜在计费仍保留核查语义，不盲目重放。

## 正式科研页面

7. **入口割裂**：`desktop/src/main.ts` 默认仅加载原生控制台；完整科研工作台必须再手动安装/打开。现在默认直接打开已认证的科研工作台，优先复用 Python，必要依赖自动准备；原生控制台保留 `--native`。
8. **provider 名称不兼容**：桌面桥使用 `custom-openai/custom-anthropic`，Python `Settings.resolve_llm` 只接受 `custom_openai/custom_anthropic`。配置值传递测试原先只验证原字符串，因此没有发现真实聊天失败。`desktop/worker/legacy_server.py` 现在规范化名称，配置回归同步检查真实规范名称。
9. **正式页面仍走旧聊天循环**：`omicslab/server/state.py` 的 RunService 调用 Python AgentLoop。新增 `omicslab/runtime/desktop_harness.py` Adapter，通过已认证管道把默认 lead 聊天交给同一个 TS Engine；Python 只投影会话和事件，显式专家/科研功能保留。没有在 Adapter 中再实现模型/工具循环。
10. **已结束工具卡仍转圈**：正式页面需要 tool_result.id，初版 Adapter 只发送 tool_call_id。界面验收发现后补齐 ID，并补卡片结束断言。完整工具产物现在执行后立即在租约保护下登记，失败时也能查原始输出。
11. **未认证根页面行为与测试不符**：真实基线单元用例发现根页面返回 200 而测试期望 401。现有 Electron 隔离 session 可为全部请求带认证，因此去掉静态路由的匿名绕过，HTTP/WS 全路径认证。

## MCP / Skills

12. **合法 MCP 结果遭拒**：原 `mcp-client.ts` 和 `domain/tools.ts` 都只接受单个 text 块内的 JSON。统一 `mcp-result.ts` 支持纯文本、多块和 structuredContent，拒绝 isError 与空结果。
13. **HTTP 生命周期不全**：原实现缺少 initialized 通知和会话 header，并取 SSE 第一行而非匹配响应。`McpHttpSession` 现在发送初始化通知、会话/协议 header，按 ID 选择 SSE 响应，限制读取大小和时间，关闭 session；stdio/HTTP 均支持分页发现。参数交由固定版本 Ajv 校验，不继续维护自制 Schema 子集。
14. **Skill 测试被当任务成功**：`skill.test` 即便 status=failed 仍返回正常 activity envelope。现失败会使步骤失败；实际任务使用单独 manifest.run，先发现元数据再加载并执行。版本/hash、依赖和 enabled 状态均验证。现有子进程隔离不是 OS 安全沙箱。

## UI / 持久化

15. **真实上翻被自动滚动保护吞掉**：400ms 时间保护在持续流式渲染中不断续期，用户 scroll 事件也被忽略。现在同时检查目标位置，wheel 向上明确解除跟随；基线漂移 14363.3px，修复后 0px。
16. **输入框随大内容移出视口**：flex 布局缺少固定可收缩边界。修复主区域/聊天/时间线 min-height 和 flex basis，消息不收缩。万段输出基线 composerΔ=1078px，修复后 0px。
17. **取消后晚到答案可能写入会话**：原模型 activity 在 Engine 完成前先 append。现在会话镜像与有租约保护的 Store.complete 同事务提交，取消/暂停后的结果不可追加；回归覆盖晚到结果。
18. **长对话全量重建及异步切换覆盖**：两个 UI 都加有界历史窗口；正式页面加载会话加 epoch 检查。流式正文保留缓冲/帧渲染，快照可替换中间工具轮文本，取消失败不展示虚假完成。
19. **管道 UTF-8 分块可能损坏中文**：Node RPC 客户端和 daemon socket 改为 setEncoding('utf8')，使用流式解码而非逐块 Buffer.toString。
20. **首段快照跳过渐进 Markdown**：首段在 DOM 建立前已到达时，painted 初始化为已有正文，首轮渲染被相等检查跳过。现强制首次渐进渲染；34 项工作台 E2E 从 33/34 恢复到 34/34。
21. **过期页面 mount 清空新页面**：路由虽然有 mountToken，但过期实例 destroy 仍共享同一个 root。现在每次 mount 拥有独立 DOM 根；聊天模型/历史初始化期间输入暂不可编辑，ready 后开放，避免初始化与输入竞争。E2E 也明确等待顶层聊天页，避免误把首页内嵌聊天当作切换完成。

## 2026-10-26 恢复额度后的新增复现

22. **引用边界误判**：首轮恢复测试为 21/22。DSH 任务实际成功搜索，且读到了官方 API 和 README，但中文全角括号被吞入 URL；修正回合的仓库网页地址又因只登记 API URL 被拒。`citationUrls` 补中文边界；`fetchedSource` 只接受 GitHub 仓库 API 返回且与请求 owner/repo 精确匹配的 html_url，保留 retrievedUrl。不允许其他站点、issue API 或伪造地址扩大引用集合。单元测试及真实 GitHub API 抓取见 github-canonical-live.json；随后完整固定任务为 22/22。
23. **失败任务 Trace 在基准汇总中丢失**：失败 activity 没有 output，runner 原先只读取 output.trace，误报 missingTools，工具成功率也漏算失败任务内调用。现在从持久化事件恢复 Trace ID 和工具事件；原始历史报告保留，comparison.json 的历史工具计数按事件重新汇总。不会把失败任务改成通过。
24. **结构重建后首段 Markdown 未刷新、节流尾部不 flush**：renderChat 建立新节点后未调用补丁；最后一个事件是结构事件时，直到下一批 token/poll 才渲染。另一个路径先记 painted，再延迟块渲染，定时器因文本相同而跳过。现在节点替换后立即应用已到文本，允许未完成的稳定块刷新；workbench-progressive-reproduced.json 保留 33/34 失败，修复后 34/34。
25. **新会话被较晚返回的旧数据恢复**：loadConversations 每次发现空 conversationId 就选择最近历史；refreshConversationRecord 也未核对返回时的当前选择。连续测试复现“新建”后恢复旧会话、持久化检查读到前两项合法回复。现在只有未经用户选择的首次加载可自动选择，get/list 和 open 用会话 epoch 约束；新建清理旧检查面板与滚动意图。真实 IPC 竞态 4/4，连续长流后新建只保存一条助手回复。
26. **关闭窗口后的主进程异常**：用户截图后，在旧打包程序按“先销毁原生窗口、后关闭正式页面”复现完全相同 TypeError，位置 dist/src/main.js:246。原 closed 回调直接 win?.close()，可选链没有检查对象是否已销毁。现在关闭时清空窗口引用，回调捕获所属窗口并检查存活；HTTP 回调固定 contentsId，退出时停事件泵/重连，异步启动完成后再次检查窗口状态。window-lifecycle-reproduced.json 保留异常堆栈；修复回归覆盖四种退出顺序。
27. **UI 测试驱动掩盖异常退出且并发等待条件错误**：流式脚本即使 findings 非空也退出 0；并发 B 的显示名没有 TAG=，轮询却用 TAG= 查找，平白等待 120 秒。现在用真实 task ID 等待，发现异常返回非零；未降低产品断言。

模型能力本身不是基线的主要根因：同一模型在最终固定任务完成 22 项。外部 429 已由用户确认额度上限，本次恢复后未发生。DuckDuckGo 网络不可用、部分官网抓取失败仍被记录；最终 48 次工具成功、8 次中间错误，按同名工具后续成功统计恢复 6/8，其他任务采用已有证据完成，不伪装为工具成功。
