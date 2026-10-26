# 3.4.0 清理副本与 Git 上传记录

本目录由已提交的 `9dff54c` 独立克隆，再复制原工作区尚未提交的 19 个 DSH 源码、测试及文档文件。原目录的文件、Git 分支和暂存区没有修改。

## 内容

- `desktop/`：3.4.0 桌面源码、内置技能、测试与构建脚本。
- `omicslab/`：Python 工作台 2.1.1、科学能力及 DSH 后端源码。
- `integrations/dsh/`：独立 DSH bundle 0.3.0；并未包含在此前已验收的 Windows 安装包中。
- `tests/`、`docs/`：回归测试、许可证、开发文档和保留的历史验收证据。历史记录不当作当前版本通过声明。

不包含 `.omicslab`、个人会话、API Key、用户配置、数据库、node_modules、编译 dist、缓存或旧安装包。普通 Git 只上传源码；132MB 安装包保留在交付文件夹的 Windows/ 中。

## 本清理副本重新验证

- `desktop/npm run typecheck`：通过。
- `desktop/npm test`：244 项，243 通过、1 跳过、0 失败。
- `python -m pytest tests -q -p no:cacheprovider`：520 通过。
- `node --check integrations/dsh/index.js` 及 `science-client.js`：通过。

测试使用临时依赖链接，结束后已移除；本机原始日志在交付文件夹 Validation/，不作为源码提交。已发布前一轮的正式 UI、RPC、文件/技能和窗口验收证据保留在 docs/verification/product-340-20261026/。

真实模型验收仍受 HTTP 429 阻断；此次整理没有新增真实厂商成功结果。Windows 安装包仍是此前已验收的 3.4.0：SHA-256 `5ade11a8e56f031ea8493ac0e263a477f74d05cd75e2f8dc7d4e494e7767ddc3`。

## 从源码运行

需要 Python 3.10+、Node 24.14+ 和 npm。项目根目录运行 `python -m pip install -e .`，随后在 desktop 执行 `npm ci`、`npm run build`，最后运行项目根目录 `./启动工作台.ps1`。运行产生的依赖与用户数据受 .gitignore 排除，不应提交凭据。

上传目标为既有仓库 ForrestGump618/suwen 的 `codex/clean-release-3.4.0` 分支；没有覆盖 main 或强制改写远程历史。
