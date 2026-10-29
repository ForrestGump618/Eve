# 文献雷达与技能图

## 数据流

1. `LiteratureCoordinator` 按工作区启动后台日循环；它不创建第二套任务调度器。
2. Europe PMC、OpenAlex、bioRxiv 与 arXiv 并行检索，单个来源失败只产生 warning。
3. 元数据、摘要和引用先做去重、类型识别、相关度与跨学科桥接评分，再检索更早的先验工作计算接地新颖性。
4. 入选文献进入精读，生成反思、方法步骤、实验想法和孤立技能候选。
5. 技能候选默认停用；只有用户审核并在真实任务中使用成功后，执行反馈才会强化技能图中的连接。

## 用户入口

- 「文献 → 雷达」：检索研究论文、综述、方法或立场文章，设置日期、来源、最低兴趣度和跨学科权重。
- 「文献 → 朋友圈」：查看每日文献动态并评论；评论回流到对应文献的记忆节点。
- 「文献 → 待审」：审核反思和技能候选。
- 「文献 → 主动分享」：发送到对话、继续讨论或填写原因驳回。
- 「投喂 PDF」：支持 PDF 上传或当前工作区内的路径；重复文件按内容摘要去重。

## API

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `POST` | `/api/literature/search` | 检索与排序 |
| `POST` | `/api/literature/ingest` | JSON 路径或 multipart PDF 投喂 |
| `GET` | `/api/literature/status` | 今日指标、最近循环、队列状态 |
| `POST` | `/api/literature/run` | 手动执行今日循环 |
| `GET` | `/api/literature/reflections` | 待审反思 |
| `GET/POST` | `/api/literature/feed`、`/feed/{id}/comments` | 文献动态与评论 |
| `POST` | `/api/literature/feedback` | 兴趣反馈与负向过滤 |
| `GET` | `/api/literature/proactive` | 主动消息队列 |
| `POST` | `/api/literature/proactive/{id}/send` | 转为对话 |
| `POST` | `/api/literature/proactive/{id}/dismiss` | 带原因驳回 |
| `POST` | `/api/literature/proactive/{id}/reply` | 直接回复 |

所有路径接受 `scope=<workspace_id>`，并在执行前检查工作区授权。

## 辅助模型

设置中的 `auxiliary_profiles` 按任务标签路由：

- `literature.embedding`
- `literature.extraction`
- `literature.classification`
- `reflection.reasoning`
- `skill.extraction`

标签未配置时回退到角色模型或全局默认。凭据只保存引用名，不写入设置对象。

## 技能图

`Platform.skill_graph` 是唯一入口：

- 词法匹配产生种子节点。
- 反向感知的 Personalized PageRank 沿依赖边回溯，返回有界、依赖闭合的技能束。
- 成功执行强化实际共用的边；失败或放弃不强化。
- 新文献技能先成为停用节点，不会立即进入主动检索。
- 删除文件只会停用节点，历史执行证据保留。

## 生命周期与边界

- 每日额度、冷却时间、分享强度和自动做梦均在设置中配置。
- 功能关闭、冷却或额度不足只延期有效消息；只有消息过期或关联对象失效才标记为 stale。
- `review` 与技能启用只能由用户确认，后台循环不能修改课题或启动科研任务。
- PDF 解析只处理工作区内、具有文本层且未越过 junction/reparse point 的文件。
- 新颖性评分依赖可检索到的先验工作；找不到先验工作时会明确标记未评分，不生成可信的虚构数值。

## 验证

- `tests/test_literature.py`
- `tests/test_skill_graph.py`
- `tests/frontend-literature.mjs`
- `tests/frontend-dashboard.mjs`

真实浏览器测试使用 Edge 和本地 loopback fixture；它们验证页面、请求和交互，不代表真实模型科研质量或外部数据库全面可用性。
