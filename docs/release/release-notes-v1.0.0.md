# Eve 1.0.0

Eve 1.0.0 是科研桌面智能体的统一发布基线。本版本保留现有 Agent Loop、持久任务、工作区、技能图、多智能体协作和证据门禁，完成正式界面、安装器、科研写作/绘图技能与公共数据接口收口。

## 新增与改进

- 固定接入 K-Dense-AI/scientific-agent-skills 提交 `5f2bc0341354fd5590aef76a533ada1e1e5b4e62` 中的论文写作、出版图、示意图、引文管理、投稿模板和同行评审技能。
- 六项技能已安装到全局 Codex 并通过结构校验，同时保留在 Eve 共享技能库；技能继续按需读取，不整体注入上下文。
- Agent 提示词和中文检索增加论文、引文、投稿、出版图与示意图意图，新技能仍需经过检索和执行反馈进入主路径。
- UniProt 主接口异常时增加有界 EBI Proteins 回退，支持 accession、gene、organism/taxid 查询；PubMed 保留 Europe PMC → NCBI 回退。
- 统一中性灰、单一强调色和语义状态色；压缩聊天气泡、空状态与提示语；原始 JSON、工具参数和长输出默认折叠。
- Windows 安装与卸载器使用与主程序一致的自绘界面，提供“仅为我”和“所有用户”安装范围，不展示管理员概念。
- 安装路径在普通与提权实例双重校验，拒绝相对路径、UNC、目录穿越和越界 Program Files 路径。
- 补充生产依赖审计、SBOM、静态安全扫描、打包 smoke、实时数据库 smoke、安装生命周期和性能证据。

## 验证

- Python：911 passed, 2 skipped, 1 upstream warning。
- 桌面：267 项，266 passed, 1 skipped, 0 failed。
- 真实 Edge 前端：10/10 套件通过。
- 打包态 smoke：10/10；实时 PubMed/UniProt smoke：11/11。
- 安装生命周期：10/10。
- `npm audit --omit=dev`：0 vulnerabilities。
- CycloneDX SBOM：294 个组件。
- 静态安全扫描：0 HIGH / 322 LOW，20 个测试夹具已登记。

## 发布资产

- `Eve-Setup-1.0.0-win-x64.exe`
- 大小：142,895,973 bytes
- SHA-256：`a52dd5ea28909391055759a605580413c093f05ba17694429b94075eb17f0627`
- Blockmap、SBOM、依赖审计、安全扫描、生命周期、smoke、性能和验收包随 Release 发布。

安装包未签名，Windows SmartScreen 可能提示未知发布者。完整证据、复现命令和未验证边界见 [1.0.0 验收报告](../verification/eve-1.0.0-release/README.md)。
