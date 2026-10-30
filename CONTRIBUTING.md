# 参与贡献 / Contributing

感谢你愿意为 **素问 Suwen** 出力！无论是报告问题、改进文档、提交代码，还是新增 Agent / Skill，都同样重要。

- [行为准则](CODE_OF_CONDUCT.md) 适用于所有社区空间。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，**不要**开公开 issue。
- 本项目以中文为主，但英文同样欢迎：issue、PR、commit message 用中文或英文都可以。

## 你可以怎么帮忙

| 方式 | 入口 |
| --- | --- |
| 报告 Bug | [Bug 报告模板](.github/ISSUE_TEMPLATE/bug_report.yml) |
| 提功能建议 | [功能建议模板](.github/ISSUE_TEMPLATE/feature_request.yml) |
| 改进文档 | 直接修改 `docs/` 或根目录 Markdown，见下方「文档贡献」 |
| 新增 Agent / Skill | 只需添加 Markdown 文件，见 [扩展指南](docs/EXTENDING.md) |
| 修代码 / 加测试 | 按本指南准备环境后提交 PR |

## 开发环境

要求：Git，以及 **Python ≥ 3.10**（项目在 Windows + Python 3.12 上完成 2.0.0 的全量验证，见 [docs/VALIDATION-V2.md](docs/VALIDATION-V2.md)；macOS / Linux 可以使用，但维护者的验证覆盖较少）。

### 快速开始（推荐）

Windows PowerShell：

```powershell
git clone https://github.com/ForrestGump618/Eve.git
cd suwen
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned   # 仅当前用户，允许执行本地脚本
.\scripts\bootstrap.ps1 -Extras dev
```

macOS / Linux：

```bash
git clone https://github.com/ForrestGump618/Eve.git
cd suwen
chmod +x scripts/*.sh
./scripts/bootstrap.sh --extras dev
```

`bootstrap` 脚本会在仓库根目录创建 `.venv`、升级 pip，并以 editable 模式安装本项目。**跑测试必须带 `dev` extra**（提供 pytest / pytest-asyncio）；默认安装只包含运行依赖。需要单细胞 / 空间分析库时再追加 `bio`，例如 `-Extras "dev,bio"` 或 `--extras "dev,bio"`。

### 手动安装（等价方式）

```bash
python -m venv .venv
# Windows: .venv\Scripts\python.exe
# macOS/Linux: .venv/bin/python
<venv-python> -m pip install --upgrade pip
<venv-python> -m pip install -e ".[dev]"
```

### 启动开发服务

```powershell
.\scripts\dev.ps1        # Windows，默认端口 5077
```

```bash
./scripts/dev.sh         # macOS / Linux
```

`dev` 脚本会检测 CLI 是否支持 `--reload`，支持则自动开启热重载，否则退回普通启动。也可以直接运行：

```bash
python -m omicslab serve --port 5077
```

用 `python -m omicslab env`（别名 `doctor`）做环境自检；`--json` / `--strict` 便于脚本与 CI 使用。完整安装说明见 [docs/INSTALL.md](docs/INSTALL.md)。

## 运行测试

```bash
python -m pytest -q
```

- 只跑单个文件：`python -m pytest tests/test_tools.py -q`。
- 测试**完全离线**：LLM 使用 `mock` provider，SSH / 视觉 / MCP / Docker 等使用伪连接或 mock 传输，不需要真实模型 Key、SSH 主机、Docker 或网络。
- 新增或修改行为时请补充测试；测试目录为 `tests/`，pytest 配置在 `pyproject.toml`（`testpaths = ["tests"]`、`asyncio_mode = "auto"`）。
- 2.0.0 记录的全量回归结果为 **439 passed**（Windows + Python 3.12，见 [docs/VALIDATION-V2.md](docs/VALIDATION-V2.md)）；不同平台与依赖版本可能略有差异，以本机实际输出为准。
- CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 Ubuntu（Python 3.10 / 3.11 / 3.12）与 Windows（Python 3.12）上运行 `python -m pytest -q`，提交 PR 前建议先在本地跑通。

## 代码约定

仓库刻意保持「零前端构建」与「核心依赖最小化」，改动时请沿用现有风格。

**Python**

- 标准库优先。新增运行依赖前请先开 issue 讨论，并说明为何无法用标准库 / 现有依赖实现；核心依赖见 `pyproject.toml`，`bio` 为可选分析依赖。
- 模块以 `from __future__ import annotations` 开头并使用类型标注；面向用户的日志与注释用中文，公开文档可中英双语。
- FastAPI 路由集中在 `omicslab/server/`（`routes*.py`），业务逻辑放在对应领域模块；错误响应使用统一信封 `{"error": {"message", "code", "detail"}}`。
- 副作用要显式：不新增启动时外联、遥测或 CDN 请求；文件访问使用工作区相对路径并经过既有路径校验。
- 凭据处理：API 只返回 `has_key` 等布尔值，明文 Key / 密码 / 私钥不得进入响应、日志、SSE 或会话文件。

**前端**

- 原生 HTML / CSS / ES Modules，位于 `omicslab/web/`，**没有打包步骤**；不要引入需要构建的框架或 CDN 依赖。
- 保持相对导入与现有目录结构一致。本机装有 Node.js 时，可用 `node --check <file>` 对改动的 JS 做语法检查（项目的验证记录也使用该方式）。
- 界面改动请同时检查明 / 暗主题与窄窗口布局。

**格式与编码**

- 所有文本文件使用 **UTF-8 无 BOM、LF 换行**；提交前请确认编辑器遵守 [.editorconfig](.editorconfig) 与 [.gitattributes](.gitattributes)。
- 不要提交 `.venv/`、`.omicslab/`、`auth.json`、`settings.json`、`.env*`、`*.pem`、`*.key` 或工作区数据；`.gitignore` 已覆盖这些路径。

## 扩展：Agent 与 Skill

最常见的贡献不需要改核心代码——Agent 和 Skill 都是带 YAML frontmatter 的 Markdown 文件：

- Agent：`omicslab/agents/*.md`（内置）或 `<workspace>/agents/*.md`（工作区）。
- Skill：`omicslab/skills/<name>/SKILL.md`（内置）或 `<workspace>/skills/`。
- 字段与优先级见 [docs/EXTENDING.md](docs/EXTENDING.md)；改完可跑 `python -m pytest tests/test_skills.py -q` 校验 frontmatter。
- 新增内置 Skill 请标注来源、依赖、权限与适用边界；不要复制未授权的第三方内容。

## 文档贡献

- 文档总索引见 [docs/README.md](docs/README.md)；安装、架构、API 的权威文档分别是 [docs/INSTALL.md](docs/INSTALL.md)、[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)、[docs/API.md](docs/API.md)；实现状态以 [docs/SUWEN-V2-CHECKLIST.md](docs/SUWEN-V2-CHECKLIST.md) 为准。
- 修改命令、配置、截图或界面流程时，请同步更新相关文档与截图。
- 文档以中文为主，`README.en.md` 为英文版本；新增或修改内容时保持两边结构对应，避免只改一边。
- 相对链接请指向真实存在的文件，不要留下占位链接；代码块请标注语言。

## Commit 与 PR

- 建议使用 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 风格，但**不强制**：`feat:` / `fix:` / `docs:` / `test:` / `refactor:` / `chore:`。
- 一个 PR 聚焦一件事；较大的改动请先开 issue 说明动机与方案，避免返工。
- 提交前自检：
  - `python -m pytest -q` 通过；
  - 未提交密钥、密码、`.omicslab/` 数据或私有绝对路径；
  - 界面改动附截图，并检查明 / 暗主题；
  - 文档与代码保持一致。
- PR 描述请按 [PULL_REQUEST_TEMPLATE](.github/PULL_REQUEST_TEMPLATE.md) 填写，并关联对应 issue（例如 `Closes #123`）。

## Issue 规范

- 先搜索已开启 / 已关闭的 issue 与文档，避免重复。
- Bug 报告请包含：版本（`python -m omicslab --version`）、操作系统、Python 版本、复现步骤、期望与实际结果、脱敏后的日志。日志请先删除 API Key、密码、私有路径与个人数据。
- 功能建议请描述「要解决的问题」而不只是「要一个按钮」，并说明你的使用场景。
- 一个 issue 只谈一件事；善用代码块、截图与最小复现。
- 维护者响应为 **best-effort**，这是个人 / 小团队项目，没有 SLA；请耐心等待，也欢迎直接提 PR。

## 语言与沟通

- 中文、英文都欢迎，用你表达最顺的语言即可。
- 讨论请对事不对人；不同意见请给出可验证的依据与最小复现。
- 违反 [行为准则](CODE_OF_CONDUCT.md) 的内容会被移除，必要时限制参与。
