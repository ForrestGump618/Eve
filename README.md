# 素问 Suwen

**面向日常工作与科研的本地 AI Agent 工作室。**

本版本在原 OmicsLab 项目的独立副本中升级。提供 SSH 工作目录、现代明暗界面、持久任务、可扩展工具与贯穿执行流程的科研证据门控。Python 包名 `omicslab`、旧 API 和 `.omicslab` 数据目录保留，以兼容已有配置。

> 版本 **2.0.0** 是可运行的单机平台基座。V2 的 24 类需求范围较大，具体子项分为已实现、部分实现、待实现和外部依赖限制，详见 [逐项实现清单](docs/SUWEN-V2-CHECKLIST.md)。界面不会把缺失的上游组件或模拟模型标为验证成功。

## 启动

Windows PowerShell：

```powershell
.\启动工作台.ps1
```

默认打开 <http://127.0.0.1:8766>。首次部署可先运行：

```powershell
.\scripts\bootstrap.ps1
```

或使用已有 Python 3.10+ 环境：

```powershell
python -m pip install -e .
python -m omicslab serve --workspace . --home .omicslab --port 8766
```

安装发行包后也可使用 `suwen serve`，旧命令 `omicslab serve` 保持有效。PDF 知识源解析需另装 `pypdf`。科学计算库按项目需要安装，未自动下载大型 Biomni 环境或模型权重。

## 开始使用

1. **设置 → 智能模型 → 管理模型连接与 API Key**：连接实际模型。无凭据时使用明确标识的 mock 测试模式。
2. **SSH → 已有连接 → 作为工作区打开**：填写远程目录，验证后作为工作目录。也可从工作台新建本地或远程工作区。
3. **工作台**：聊天、文件、计算和变量使用当前工作区；远端不可达时返回错误，不会改用本机目录。
4. **任务中心 / 工作流**：创建不依赖浏览器窗口的任务，检查节点状态、人工审批与 Checkpoint。后端必须保持运行。
5. **科研与证据**：检索来源、登记证据/推断/假设、读取真实指标文件并执行独立检查，最后人工复核。

从旧进程复制的 SSH 档案不包含仅存在于进程内存的密码；新实例需要重新输入。密钥与密码不要填写在普通配置文本中，使用对应凭据入口。

## 本版本可用能力

- 统一的素问品牌、低饱和明暗主题、多级设置、字体/密度/强调色/快捷键、工作区面板布局。
- 快速/均衡/深度模式，独立文本/推理/代码/视觉/嵌入配置，模型参数兼容处理、上下文压缩、受限故障切换与估算用量。
- SQLite 持久任务、DAG 依赖、并行分支、审批节点、取消/暂停/检查后恢复、间隔定时任务。
- 工作区知识与选择性记忆，关键词/中文二元词 + 可选嵌入 API，来源定位、去重、过期和配置版本。
- 真实 MCP stdio / Streamable HTTP 握手、能力发现和工具调用，服务/工作区/Agent 授权。
- 可审核的本地/Git Skill 安装、禁用/启用、版本与回滚；预装科研方法技能。
- WebChat / Telegram 适配层、联系人白名单、只读默认权限、Webhook 认证、去重与限流。
- 文献与蛋白数据库查询、DNA QC、结论登记、数值规则验证及证据门控。
- 产物摘要快照、版本、差异 API 与精确恢复，日志、诊断、备份、Windows DPAPI 凭据。
- 可选断网 Docker Python 执行工具；本机常规 Python 内核仍具有主机权限。

## 科研能力的边界

借鉴 [Biomni](https://github.com/snap-stanford/Biomni) 的工具检索、规划与代码执行模式，接入 Europe PMC、UniProt 和独立数值验证。**没有声称安装完整 Biomni E1 或数据湖，也没有复现其上游评测成绩。** 预装 Paper2Agent、Co-Scientist、Robin、ERA 是带来源和依赖说明的自编方法技能，不等于完整安装这些上游系统。

科学任务的计算成功与科学结论成立分别记录。没有足够证据的运行标记 `needs_review`；模型、模型共识和视觉模型均不能自动签署科学复核。

## 文档

- [V2 实现与缺口清单](docs/SUWEN-V2-CHECKLIST.md)
- [运行、架构与 API 说明](docs/SUWEN-V2-GUIDE.md)
- [Biomni 思路与证据验证设计](docs/BIOMEDICAL-EVIDENCE.md)
- [测试与实测记录](docs/VALIDATION-V2.md)
- [原始 V2 需求](docs/SUWEN-V2-REQUIREMENTS.md)
- [SSH 工作区升级说明](docs/UPGRADE-1.3.md)
- [开源参考与独立实现说明](docs/REFERENCES-V2.md)

## 验证

```powershell
python -m pip install -e '.[dev]'
python -m pytest -q
```

本次全量回归：**439 passed**。外部模型、真实 SSH、Docker 容器、完整第三方渠道与上游科研环境的验收范围见验证记录。

## 许可证

项目沿用 [Apache-2.0](LICENSE)。本次新增代码、界面、图标和方法技能独立编写；参考项目按各自许可证提供，不因参考而成为本包依赖。
