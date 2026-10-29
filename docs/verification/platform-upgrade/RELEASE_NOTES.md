# Eve 1.1.0

Eve 1.1.0 将科研技能、自主子智能体、RSI 与 Sage、设置能力、侧边栏、终端背压和界面收口整合到一个 Windows x64 工作台。

## 主要变化

- 队长智能体按复杂度自主提出团队方案；批准后由持久子智能体按依赖执行和讨论，成员在侧栏中查看并可直接续聊。
- 团队数据以摘要卡展示，原始 JSON 不再占用聊天正文。
- 科学技能按需加载；目录发现 373 个技能，其中 40 个 Google DeepMind Science Skills、65 个声明脚本。
- RSI 明确为科研发现、桌面策略调参和 Proteus 冻结源码进化三层；Sage 仅作为可选验证增强内核。
- 设置页支持温度、上下文、输出、Token 参数、模态、容许参数、备用模型和逐工具权限；默认权限全部开放。
- 聊天气泡同条件高度降低 9.85%，代码默认折叠，增加用户消息快速定位、会话归档和检索。
- 文件、Git、终端、Artifact、子智能体进入侧栏；终端固定 4096 包基准的渲染写入由 4096 次合并至 30 次。

## 验证

- Python：831 passed, 1 skipped
- TypeScript：302 passed, 1 skipped
- 前端集成：40 passed
- 打包态 smoke：10/10
- 安全扫描：0 HIGH
- 科学审计：17 个能力域、3 个场景、351 个资源哈希一致

完整报告：https://github.com/ForrestGump618/suwen/blob/eve-v1.1.0/docs/verification/platform-upgrade/README.md

## 安装包

- `Eve-Setup-1.1.0-win-x64.exe`
- 144,273,806 bytes
- SHA-256：`670dc02e964c1ca7a9f31067f56576085951e1a24fd056d1b2d4ce05e64f0d96`

安装包未签名，Windows SmartScreen 可能显示提示。

## 已知边界

本轮没有验证真实计费模型账号、干净 Windows VM、代码签名、长期 SSH/耐久、全部 live 科学服务、逐句引用语义或湿实验。详细边界见发布报告。
