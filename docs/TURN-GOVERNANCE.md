# 自动回合治理与流式输出

素问 1.0 / Eve 1.0.0 的统一 Harness 不设置隐藏的单轮模型请求或工具调用次数上限，也不按“相同调用三次”或“无进展五次”强制终止。这个决定来自对 ClawsGO 1.1.3 发行包静态逆向后得到的能力边界：可以确认每轮在独立子进程运行、同会话新轮会终止旧轮、取消与连接看门狗存在；发行包没有公开或暴露可验证的固定模型/工具迭代阈值。实现细节见 [ClawsGO 1.1.3 逆向记录](verification/clawsgo-1.1.3-rea.md)。

## 每一次工具结果都回传模型

`ToolRegistry.execute` 是本机、SSH、MCP 与平台工具的统一边界。每轮创建独立的 `TurnGuard`，它记录步骤、调用、Token 和经过时间供诊断使用，但不会因为工具名与参数相同、工具输出相同或短循环序列而拒绝下一次请求。工具 handler 实际执行后，成功或失败结果都会作为 `tool` 消息回到模型；空结果会被判为失败。

目录不存在、权限不足、远端不可用或普通工具异常会附带可读的恢复提示。模型可以依据新观察选择父目录、其他工具或明确报告阻塞；相同调用再次执行时也会得到新的真实观察，而不是伪造的缓存成功。

## 资源边界仍然生效

| 边界 | 行为 |
| --- | --- |
| 显式取消 | 用户取消或同会话新轮接管时终止当前执行；Windows 子进程树使用 `taskkill /T /F`，POSIX 先 `SIGTERM`，3 秒后升级为 `SIGKILL` |
| 本轮时长 | Python 兼容 AgentLoop 的 `TurnPolicy.seconds=900` 在模型请求和工具执行前检查；桌面统一 Harness 通过 durable runtime 使用 630 秒回合墙钟。达到边界后以 `turn_deadline` 受控停止 |
| Token 预算 | Python 兼容 AgentLoop 默认 120,000；桌面统一 Harness 使用 240,000。两者都优先使用 Provider 返回用量；Python 路径达到 80% 时压缩工具结果和输出预算，达到上限后以 `token_budget` 受控停止 |
| 单步超时 | 每个模型或工具步骤由 durable runtime 的 `timeoutMs` 与租约控制；桌面统一 Harness 的交互模型步骤为 600 秒。超时不会被标记成功 |
| 上下文窗口 | 按模型窗口动态预留输出，压缩旧观察并保留 `callId`、路径、摘要和 `read_tool_result` 恢复入口 |
| 检查点 | 工具计划执行前和观察回传后持久化；恢复时不会盲目重放结果未知的副作用 |
| 工作流预算 | 研究 DAG 可显式声明 `maxCalls`、`maxTokens`、`maxWallMs`、`maxCost`；这是用户/模板可见的任务图预算，不是交互回合的隐藏循环计数器 |

这些边界不会把未完成的工作标记为成功。受控停止在运行层记为 `interrupted`，保留输出、检查点和诊断，可恢复继续；最终答案仍需通过非空、必需工具已执行及引用来源检查。

## 流在写入轨迹前聚合

`streaming.merged_stream` 位于 Provider 与 `AgentEvent` 之间。相邻 `reasoning`、`text` 增量按通道累积，以句子、约 120 毫秒窗口或块大小触发发送。发送时保留尾部缓冲，避免最后一个词单独形成事件；通道切换、用量、工具调用、完成、异常和 EOF 前刷新尾部，保持顺序及文本内容。完整的短回答仍允许很短，不会为了凑长度添加文字。

每次只保留一个待完成的 Provider 读取；刷新计时器不会反复取消读取。推理通道检测重复六遍且总长度至少 96 字符的短周期，检测到后在流内部截断。另有 30 秒无增量、120 秒单请求和 64,000 字符上限。这些是传输健康边界，不是模型或工具迭代次数限制。收到 `done` 后不继续等待 Provider。退出时取消读取并关闭生成器，清理等待本身也有时间上限。

模型流被截断时不执行未完成的工具调用；保存可用文本和推理，生成明确的停止说明，然后正常返回运行层。周期检测是保守启发式，可能截断重复的有效推理；它不会据此声称任务完成或科学结论已验证。

## 内置策略随每轮自动生效

旧设置文件中的 `max_iterations` 字段仅保留历史设置反序列化兼容，默认值为 0；API 响应不返回它，运行时不读取它作为执行依据，更新接口拒绝手动设置。平台旧 `max_tokens/max_cost/max_iterations/warn_ratio` 配置从有效配置中滤除，历史记录不删除。设置页仅保留并发与可选费用统计价格，价格未配置不表示服务免费。

Token 统计不能预测外部服务的精确账单；Provider 未报告用量时，估计值和流长度/时长保护共同限制运行。这不是服务商侧的费用硬限制。工具自身的超时、审批、后台任务和科学流程参数仍由各自服务管理。

## 停止原因可审计

所有正常、受控停止、模型错误、用户取消和运行异常都记录 Stop Reason。会话保存 `meta.stop_reason`；轨迹有 `stop_reason` 事件；运行记录与最终 `done` 事件保留原因。非正常完成还附带最近已尝试调用的脱敏摘要和恢复策略。

常见码包括 `completed`、`token_budget`、`turn_deadline`、`stream_degenerated`、`stream_idle`、`stream_deadline`、`stream_output_limit`、`llm_error`、`cancelled` 和 `runtime_error`。`duplicate_tool_call`、`tool_cycle`、`output_stagnation`、`step_budget`、`tool_budget` 与 `no_progress` 是旧版本兼容码，当前统一回合不会再由重复或次数策略生成。

受控停止在 AgentLoop 内正常返回；运行层记为 `interrupted`，保留输出和会话，可继续处理。工作流与父任务不会将它当成成功完成的研究节点。一次工具拒绝后若成功恢复并最终回答，仍记为正常完成。

## 验证与参考

回归位于 `tests/test_turn_governance.py`、`desktop/test/agent-loop.test.ts` 与 `tests/test_runtime.py`。它们用可控 Provider 驱动真实 AgentLoop/ToolRegistry，验证超过旧 24 步/48 工具边界的任务可以完成、相同调用与循环序列仍能观察、取消与时长边界、流聚合与关闭、Token 边界、跨回合重置，以及停止原因持久化。

本次按 DeepSeek Harness 的运行时防护原则独立实现，并参考 Argus 的 [预算执行与显式结算](https://github.com/microsoft/ArgusAgent/blob/main/packages/runtime/src/budgetedPi.ts)、[运行中用量观察](https://github.com/microsoft/ArgusAgent/blob/main/argus/adapters/agent_cli_backend/_budget_monitor.py) 和 [流进度聚合](https://github.com/microsoft/ArgusAgent/blob/main/argus/adapters/stream_progress.py)。参考的是资源控制与事件边界设计，未引入其 Manager/Planner/Engineer/Reviewer 运行体系或复用上游基准成绩。
