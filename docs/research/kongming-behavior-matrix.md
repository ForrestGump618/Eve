# 外部项目 behavior matrix

All runtime observations require an isolated Windows VM, snapshot and test account. Static package content is not a runtime test.

| Scenario | Status | Required evidence |
|---|---|---|
| Ordinary/streaming chat | Unknown | Test conversation, screen and event timings |
| Complex planning and multi-step tools | Unknown | Self-initiated task trace |
| Cancel/pause/resume | Unknown | Before/after state and side effects |
| Close/reopen window, background work | Unknown | Process tree plus committed task progress |
| Network interruption/API 429/5xx | Unknown | Controlled test endpoint and recovery trace |
| Long context/compaction | Unknown | Known constraints and source retention after multiple rounds |
| Long tasks and crash recovery | Unknown | Checkpoints, process kills and elapsed recovery |
| Upload/index research material | Unknown | Public sample, provenance and retrieval |
| Multiple agents | Unknown | Independent observable task outputs |
| Skill/MCP extension | Unknown | Explicit configured extension and health/tool call |
| Packaging and runtime boundaries | Observed statically | NSIS, Electron ASAR/main/preload/renderer inventory |

Do not infer internal lease, compaction or task lifetime from UI resource names.
