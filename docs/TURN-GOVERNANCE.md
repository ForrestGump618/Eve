# 自动回合治理与流式输出

素问 2.1.1 修复重复工具导致运行失败、流式输出碎片化，以及依赖手动设置额度和迭代上限的问题。保护位于工具调度和模型流管道内，模型输出或提示词不能关闭这些检查。

## 工具失败后能够恢复

`ToolRegistry.execute` 是统一的执行前边界，本机、SSH、MCP 与平台工具经过相同守卫。每轮共享一个 `TurnGuard`，每次新回合重新创建，历史会话和工作区累计用量不会耗尽下一轮的额度。

- **精确重复**：对工具名、排序后的参数和路径表示做规范化；保存结果摘要指纹与可观测状态。状态未变化的第二次调用在工具体执行前返回 `duplicate_tool_call`。并发中相同调用另以 `duplicate_inflight_call` 拒绝。
- **循环序列**：在有界历史中检查长度 2–6 的序列重复两遍，返回 `tool_cycle`。单个调用去重通常会更早阻止循环。
- **输出停滞**：同一工具在不同参数下连续返回相同结果或错误三次后，下一次调用返回 `output_stagnation`。连续无进展达到六次，停止下一次模型请求并生成诊断。
- **状态变化**：本机文件读取记录目标及父目录的时间与大小；受支持的成功写入、代码执行、记忆修改等操作推进状态版本。SSH 不额外发起探测请求，使用本轮已观察的状态变化。未知工具的副作用不能自动解除守卫；重新发起回合可重新检查外部变化。

拒绝是 `ok=false` 的正常工具结果，包含 `code`、`executed=false`、规范化的已尝试参数、计数器、历史结果指纹和恢复策略；不会因为一次重复就抛异常或终止整个任务。

目录不存在时，首次错误即附带 `path_not_found` 与父目录的 `list_files` 建议；路径不安全时回退到当前工作区根目录。后续应根据实际 `entries` 选路，找不到则明确报告缺失。连接或超时错误归为 `remote_unavailable`，权限错误归为 `permission_denied`，禁止无变化重试。运行时不自动替换用户要求的目录，也不绕过审批执行建议。

例如 `list_files({"path":"mast0912"})` 失败后，原样请求会被拒绝，`list_files({"path":"."})` 仍可执行；模型可据根目录的真实目录项给出缺失结论。如果持续忽略替代策略，六次无进展后受控停止，保存已尝试参数和诊断。

## 流在写入轨迹前聚合

`streaming.merged_stream` 位于 Provider 与 `AgentEvent` 之间。相邻 `reasoning`、`text` 增量按通道累积，以句子、约 120 毫秒窗口或块大小触发发送。发送时保留尾部缓冲，避免最后一个词单独形成事件；通道切换、用量、工具调用、完成、异常和 EOF 前刷新尾部，保持顺序及文本内容。完整的短回答仍允许很短，不会为了凑长度添加文字。

每次只保留一个待完成的 Provider 读取；刷新计时器不会反复取消读取。推理通道检测重复六遍且总长度至少 96 字符的短周期，检测到后在流内部截断。另有 30 秒无增量、120 秒单请求和 64,000 字符上限。收到 `done` 后不继续等待 Provider。退出时取消读取并关闭生成器，清理等待本身也有时间上限。

模型流被截断时不执行未完成的工具调用；保存可用文本和推理，生成明确的停止说明，然后正常返回运行层。周期检测是保守启发式，可能截断重复的有效推理；它不会据此声称任务完成或科学结论已验证。

## 内置策略随每轮自动生效

以下是代码默认值，不是设置页中的用户调参项目：

| 边界 | 默认规则 |
| --- | --- |
| `agent/pre-step` | 最多 24 次模型请求；拒绝第 25 次 |
| `tools/pre-execute` | 最多 48 次工具请求；拒绝也计数，超限不执行工具体 |
| Token 用量 | 本轮累计 120,000；优先累计 Provider 返回的用量，缺失时使用明确标识的本地估计 |
| 自动降级 | 达到 80% 后，下一次输出缩至最多 1,024 Token，历史工具结果裁至 2,000 字符 |
| 无进展 | 连续六次失败、重复或拒绝后提前停止 |
| 本轮时长 | 900 秒；在模型请求和工具执行前检查 |

工具额度触发后，在步骤、Token 和时长仍允许时保留一次禁用工具的最终回答机会。若模型仍请求工具，代码继续拒绝并收尾。步骤或 Token 已达硬边界时，不再为收尾发出额外模型请求，直接生成诊断。

旧 `max_iterations` 设置仅保留反序列化兼容，不再作为执行依据；更新接口拒绝手动设置。平台旧 `max_tokens/max_cost/max_iterations/warn_ratio` 配置从有效配置中滤除，历史记录不删除。设置页仅保留并发与可选费用统计价格，价格未配置不表示服务免费。

Token 统计不能预测外部服务的精确账单；Provider 未报告用量时，估计值和流长度/时长保护共同限制运行。这不是服务商侧的费用硬限制。工具自身的超时、审批、后台任务和科学流程参数仍由各自服务管理。

## 停止原因可审计

所有正常、受控停止、模型错误、用户取消和运行异常都记录 Stop Reason。会话保存 `meta.stop_reason`；轨迹有 `stop_reason` 事件；运行记录与最终 `done` 事件保留原因。非正常完成还附带最近已尝试调用的脱敏摘要和恢复策略。

常见码包括 `completed`、`duplicate_tool_call`（工具拒绝）、`tool_cycle`、`output_stagnation`、`step_budget`、`tool_budget`、`token_budget`、`no_progress`、`turn_deadline`、`stream_degenerated`、`stream_idle`、`stream_deadline`、`stream_output_limit`、`llm_error`、`cancelled` 和 `runtime_error`。

受控停止在 AgentLoop 内正常返回；运行层记为 `interrupted`，保留输出和会话，可继续处理。工作流与父任务不会将它当成成功完成的研究节点。一次工具拒绝后若成功恢复并最终回答，仍记为正常完成。

## 验证与参考

新增的回归位于 `tests/test_turn_governance.py`，运行状态回归位于 `tests/test_runtime.py`。它们用可控 Provider 驱动真实 AgentLoop/ToolRegistry，验证目录恢复、执行前拦截、并发与状态变化、周期与停滞、流聚合与关闭、降级、额度边界、跨回合重置，以及停止原因持久化。完整测试输出见 [验证记录](VALIDATION-2.1.1.txt)。

本次按 DeepSeek Harness 的运行时防护原则独立实现，并参考 Argus 的 [预算执行与显式结算](https://github.com/microsoft/ArgusAgent/blob/main/packages/runtime/src/budgetedPi.ts)、[运行中用量观察](https://github.com/microsoft/ArgusAgent/blob/main/argus/adapters/agent_cli_backend/_budget_monitor.py) 和 [流进度聚合](https://github.com/microsoft/ArgusAgent/blob/main/argus/adapters/stream_progress.py)。参考的是资源控制与事件边界设计，未引入其 Manager/Planner/Engineer/Reviewer 运行体系或复用上游基准成绩。
