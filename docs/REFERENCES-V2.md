# 开源参考与实现边界

以下为阅读和设计参考，不表示安装、嵌入或完整复刻了这些系统。本次新增界面、SVG 图标、运行模块和方法技能独立编写，没有直接移植这些项目源码。上游许可证并不因本项目 Apache-2.0 而改变。

| 来源 | 参考内容 | 素问的具体取舍 |
|---|---|---|
| [Biomni](https://github.com/snap-stanford/Biomni) 与 [工具注册表](https://github.com/snap-stanford/Biomni/blob/main/biomni/tool/tool_registry.py) | 生物工具检索、可执行分析、环境与评测意识 | 轻量本地工具目录+实际代码执行+来源/指标门控；没有打包完整 E1/数据湖 |
| [Paper2Agent](https://github.com/jmiao24/Paper2Agent) | 论文方法到可复用工具与技能 | 预装自编方法手册，要求源论文、仓库、环境与回归证据；自动完整工程化尚未提供 |
| [AI Co-Scientist 研究](https://arxiv.org/abs/2502.18864) | 多角色假设生成与批判 | 有限轮讨论 DAG、裁判与反质疑提示；不冒充未开放原始系统 |
| [Robin](https://github.com/Future-House/robin) | 文献、假设、实验与反馈 | 预装方法手册，标出上游环境和第三方 API 依赖 |
| [Empirical Research Assistance](https://arxiv.org/abs/2509.06503) | 计算实验与可执行评估 | 预装方法手册，强调指标比较与验证；没有宣称包含完整上游搜索器 |
| [Dify](https://github.com/langgenius/dify) | 模型管理、可视工作流、RAG 与可观测能力分区 | 采用多级能力中心与独立 DAG，保留轻量原生前端，未引入其后端或依赖 |
| [Open WebUI](https://github.com/open-webui/open-webui) | 普通用户对话入口和高级配置组织 | 简单思考模式、连接入口、渐进展开高级选项；未复制品牌和组件 |
| [OpenHands](https://github.com/OpenHands/OpenHands) | 运行时、工作区与隔离环境的区分 | 真实 SSH 路由与可选 Docker 工具；明确本机内核不等于隔离沙箱 |
| [VS Code Remote SSH](https://code.visualstudio.com/docs/remote/ssh) | 主机+远程目录的工作区心智模型 | 绑定现有 SSH profile 与 root，不在断连后切回本机 |
| [shadcn/ui](https://github.com/shadcn-ui/ui) / [OpenChamber](https://github.com/openchamber/openchamber) | 设计变量、焦点与层次、整合工作台 | 自编原生 CSS/JS，低饱和配色、留白、统一控件和工作台 |
| [MCP transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) | stdio 与 Streamable HTTP、初始化与会话头 | 实际 JSON-RPC 客户端；仅声明实现的协议子集 |
| [Europe PMC REST](https://europepmc.org/RestfulWebService) / [UniProt API](https://www.uniprot.org/help/api) | 可追溯文献与蛋白注释 | 真实 API 查询，来源元数据与科学结论验证分开 |

用户提供的[知乎文章](https://zhuanlan.zhihu.com/p/1916045864771786659)在环境中返回 403；Biomni 相关设计转而依据官方仓库，未假装读到该文章的完整内容。
