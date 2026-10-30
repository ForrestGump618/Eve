# 获取帮助 / Support

素问 Suwen 是本地优先的开源项目（Apache-2.0），由维护者与社区志愿者以 **best-effort** 方式支持。提问前请先花几分钟自查，这通常比等回复更快。

## 先看文档

| 我想…… | 看这里 |
| --- | --- |
| 安装、升级、配置 Python 环境 | [docs/INSTALL.md](docs/INSTALL.md) |
| 了解整体架构与安全模型 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 查 HTTP / SSE / WebSocket 接口 | [docs/API.md](docs/API.md) |
| 写自定义 Agent / Skill | [docs/EXTENDING.md](docs/EXTENDING.md) |
| 看 2.0 实现与验证状态 | [docs/SUWEN-V2-CHECKLIST.md](docs/SUWEN-V2-CHECKLIST.md)、[docs/VALIDATION-V2.md](docs/VALIDATION-V2.md) |
| 快速上手 | [README.md](README.md) |
| 文档总索引 | [docs/README.md](docs/README.md) |

## 提问渠道

- **Bug 或功能建议**：请使用 [issue 模板](https://github.com/ForrestGump618/Eve/issues/new/choose)，它们会提示你附上必要信息。
- **开放式问题、使用心得、方案讨论**：欢迎使用 [GitHub Discussions](https://github.com/ForrestGump618/Eve/discussions)（若已启用）。
- **安全问题**：**不要**开公开 issue，请按 [SECURITY.md](SECURITY.md) 私下报告。
- **贡献代码或文档**：先读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 提问前请自查

- 搜索已有 issue（含已关闭的）与文档，避免重复提问。
- 用 `python -m omicslab env` 自查环境；报 Bug 时附上版本（`python -m omicslab --version`）、操作系统、Python 版本与脱敏日志。
- 尽量提供最小复现：从哪个页面、点了什么、期望与实际结果分别是什么。
- **发送日志或截图前删除 API Key、密码、私钥、私有路径与个人数据。**

## 项目不提供支持的范围

- 第三方模型服务、MCP 服务器、SSH 主机、Docker 镜像与上游科研数据源本身的可用性与正确性；
- 公网部署、多用户 / 多租户改造、企业级 SLA 或商业支持；
- 环境安装问题（Python、CUDA、Docker、系统权限等）的现场排查，但欢迎在 issue 中描述，社区可能有人遇到同样问题；
- 科研结论的审阅或结果担保——素问是分析工作台，不替代统计与领域专家判断。

## 响应预期

维护者会尽力阅读并回复 issue / PR，但这是个人 / 小团队项目，没有 SLA，也不保证每个问题都能解决。带上清晰复现与环境的报告，最有可能得到快速回应。

## 参与贡献

即使不写代码，也可以帮忙：复现问题、补充文档、改进中文 / 英文翻译、分享使用案例、给 issue 分类。具体见 [CONTRIBUTING.md](CONTRIBUTING.md)。
