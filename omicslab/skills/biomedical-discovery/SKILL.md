---
name: biomedical-discovery
description: Biomni 风格的工具检索、知识检索、代码执行与强制证据复核流程。
when_to_use: 生物医学数据分析、蛋白或文献查询、机制假设与发现验证。
---

# 生物医学发现与证据门禁

参考来源：https://github.com/snap-stanford/Biomni 。版本：suwen-biomedical-1。素问独立实现工具检索与执行链路，完整 Biomni E1、原始工具全集与数据湖未默认安装。上游组件可经 MCP 服务管理接入；必须检测依赖与许可证后使用。

1. 明确任务和数据。用 bio_tool_search 检索实际可用工具，避免将工具目录中的名称当作已安装的软件。
2. 用 bio_literature_search 查询 Europe PMC，或用 bio_protein_lookup 查询 UniProt。保留来源 ID、DOI / PMID、查询参数与检索时间。文献元数据不证明该论文支持某个具体机制。
3. 纯 DNA 质量检查可以使用确定性的 bio_sequence_check；复杂计算用 run_python_code，在当前本机或 SSH 工作区执行。不得把本地服务端环境当成 SSH 环境。
4. 为每项生物学发现调用 bio_record_claim，明确 kind 为 evidence、inference 或 hypothesis，并关联真实来源 ID。
5. 将实际计算指标写成 JSON，再调用 bio_verify_claim 检查预先声明的规则。检查会读取文件、计算摘要并验证来源状态，不能直接传入“验证通过”的模型标签。
6. 只有数值检查通过时，状态也仍为 checks_passed_needs_human。科学结论需要核对原始数据、统计方法、混杂、样本独立性、多重检验、外部支持和因果推断边界。
7. 最终报告区分“执行已完成”和“科学证据已复核”。证据不足时保留待复核门禁，提供下一步验证方法，不隐去冲突或负结果。

权限：外部查询遵守网络授权，Python / 文件遵守工作区授权；临床敏感数据不得未经脱敏发送给外部模型或公共检索服务。
