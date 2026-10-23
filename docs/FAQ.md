# 常见问题（FAQ）

本页回答安装、配置、数据和科研使用中最常见的问题。命令与默认值取自 2.0.0 的安装指南、运行说明和代码；更完整的背景见文末的相关文档。

## 安装与启动

### Q1. 支持哪些操作系统和 Python 版本？

Windows 10/11、macOS 12+ 和主流 Linux 发行版均可运行。Python 要求 **3.10+**，推荐 3.11。当前维护环境只在 Windows 10/11 + Python 3.11 上做过完整实测；macOS / Linux 的 bash 脚本已提供但尚未实测，遇到问题请提交 Issue。

### Q2. 怎样最快跑起来？

Windows 在项目根目录运行 `.\启动工作台.ps1`，首次可先运行 `.\scripts\bootstrap.ps1` 安装依赖；浏览器打开 <http://127.0.0.1:8766>。其他平台或手动环境：

```bash
python -m pip install -e .
python -m omicslab serve --workspace . --home .omicslab --port 8766
```

也可以运行 `./scripts/bootstrap.sh` 建虚拟环境。完整步骤（含 venv、执行策略、内核解释器）见 [安装指南](INSTALL.md)。

### Q3. 没有外网能安装吗？

可以。在有网且同 OS、同 Python 版本的机器上执行 `pip download -d wheels ".[bio]"`，把 `wheels/` 与项目目录拷到离线机器，再用 `pip install --no-index --find-links wheels -e . --no-build-isolation` 安装。离线时若要连本地模型，可使用 Ollama（例如 `ollama pull qwen2.5:7b`），并保持服务只监听回环地址。细节见 [安装指南 §5](INSTALL.md#5-离线安装)。

### Q4. 默认端口是多少？打不开怎么办？

`omicslab` 命令行默认监听 `127.0.0.1:5077`；Windows 的 `启动工作台.ps1` 默认传入 `8766`（可用 `-Port` 修改）。端口一致即可，访问 `http://127.0.0.1:<端口>`。端口被占用时换一个端口，例如 `--port 5078`；服务只监听本机，不需要改防火墙。

### Q5. 界面显示“无可用 provider”怎么办？

说明还没有配置模型凭据。打开 **设置 → 智能模型 → 管理模型连接与 API Key**，填写实际 Provider、模型和 Key 后做连接测试；没有凭据时系统会明确使用 mock 测试模式，而不是假装调用真实模型。也可以按 Provider 对应的环境变量配置（例如 `DEEPSEEK_API_KEY`）。

## 模型与密钥

### Q6. mock 模式是什么？会把 mock 当真实结果吗？

mock 是离线测试用的本地 Provider（模型名 `mock-model`），用于在没有 Key 时仍能走通界面和流程。界面会明确标识 mock；真实模型调用失败时**不会**把 mock 当作成功降级，运行结果也不会被标成真实模型产出。

### Q7. API Key 存在哪里？安全吗？

凭据保存在数据目录的 `auth.json`，Windows 上可使用 DPAPI 保护（密文绑定当前 Windows 账户，换设备后需要重新输入）。密钥不应写进普通配置文本，也不要提交到 Git。备份数据目录时注意 `auth.json` 的保管。

### Q8. 为什么设置了环境变量，界面里还是没有模型？

环境变量只在启动服务的那个进程/终端里生效；修改后需要重启后端。另外，如果设置页里保存了显式连接配置，会优先于环境变量。先运行 `python -m omicslab env`（或 `doctor`）确认检测到的 Provider 与 Key。

## SSH 工作区与隔离

### Q9. 为什么 SSH 密码重启服务后要重输？

SSH 密码默认**只保存在当前进程内存**，不会写入磁盘。安装了 `keyring` 后，勾选“记住密码”才会交给系统凭据库持久化；界面和 `GET /api/ssh/diagnostics` 会显示凭据后端是 `memory` 还是系统凭据库。从旧进程复制的 SSH 档案不包含内存中的临时密码。

### Q10. 远端主机断开后，会静默改用本机目录吗？

不会。工作区绑定的是本地目录或 SSH 根目录；远端不可达、路径错误或认证失败都会明确报错，不会切回本机目录继续执行。这也是 SSH 工作区与“把文件拷到本机”的主要区别。

### Q11. 本机 Python 和 Docker 沙箱有什么区别？

常规 Python/Shell 工具的权限等同于运行服务的用户，工作区路径校验**不是操作系统沙箱**。需要隔离不可信代码时，显式选择 `sandbox_python` 工具：它要求本机已安装 Docker、daemon 可用，并预先准备官方 `python:3.12-slim` 镜像（不会自动拉取）。容器断网、只读根文件系统、非 root 并限制资源，只绑定当前本地工作区；该工具不支持 SSH 工作区，Docker 不可用时拒绝回退到主机执行。

## 数据与维护

### Q12. 数据默认存在哪里？

不传 `--home` 时，数据目录默认是 `~/.omicslab`（可由 `OMICSLAB_HOME` / `OMICSLAB_DATA_DIR` 覆盖）。项目里的 `启动工作台.ps1` 与运行说明使用仓库内的 `.omicslab/`。目录中有 `settings.json`、`auth.json`、`workspaces.json`、`runtime/events.db`、`suwen/platform.db`、`suwen/blobs/`（产物快照）、受管理技能与 `backups/`。

### Q13. 怎样备份或彻底重置？

先停止素问，再整体复制数据目录（含 `suwen/`、`runtime/events.db` 与工作区文件）；恢复时把备份放回原路径，不要在服务运行时替换数据库。彻底重置等于删除数据目录并重新启动，会丢失设置、会话、任务与产物快照；如果数据目录里有需要的密钥，请先导出凭据或重新填写。

### Q14. PDF 知识源为什么导入失败？

PDF 解析依赖可选的 `pypdf`，它不在核心依赖中：`python -m pip install pypdf` 后重启服务。Markdown、文本、代码、CSV 和 Word 不需要额外依赖；扫描件或需要 OCR 的 PDF 目前不支持。

### Q15. 为什么 Python 包名和 `.omicslab` 目录没有改成 suwen？

为了兼容已有配置、旧 API 和既有数据目录：升级后旧设置、会话和脚本可以继续使用。命令行同时提供 `suwen` 与 `omicslab` 两个入口（本仓库安装完成后即可使用）；版本号、界面和文档统一为 Suwen 2.0.0。

## 使用与科研

### Q16. 关闭浏览器后，后台任务会停止吗？

不会。关闭浏览器不影响正在运行的后端；但**后端进程必须保持运行**，服务退出后任务不会继续。后端重启时，运行中的任务会标记为 `interrupted`，检查外部操作状态后可从 Checkpoint 恢复；恢复不会重放已成功的节点。

### Q17. 计算成功是否等于科研结论成立？

不是。科学任务的计算成功与科学结论成立分别记录：没有足够证据的运行会标记 `needs_review`，需要人工在科研与证据中心复核。模型、模型共识和视觉模型都不能自动签署科学复核；数值检查也不以模型意见作为通过依据。

### Q18. 怎样新增一个技能或 Agent？

技能放在 `<skill-root>/<name>/SKILL.md`，技能根目录优先级为 `$OMICSLAB_SKILL_ROOTS` → 包内置 `omicslab/skills/` → 当前工作区 `skills/`（同名先者胜）。Agent 是带 YAML frontmatter 的 Markdown 文件，可放在包内置 `agents/`、工作区 `agents/` 或 `$OMICSLAB_TEMPLATES_DIR`。字段规范与示例见 [扩展指南](EXTENDING.md)；技能目录见 [内置技能库](SKILLS.md)。

### Q19. 项目借鉴了 Biomni 等开源项目，许可证怎么处理？

Suwen 本身以 Apache-2.0 发布；参考项目各自按其许可证提供，不因被参考而成为本包的依赖，也没有打包完整的 Biomni E1、数据湖或上游评测环境。逐项借鉴点与边界见 [参考项目与许可证](REFERENCES-V2.md) 和 [科研证据设计](BIOMEDICAL-EVIDENCE.md)。

### Q20. 如何报告问题或参与改进？

先运行 `python -m omicslab env` 和 `GET /api/runtime/diagnostics`，再附上版本、操作系统、复现步骤和相关日志提交 Issue。安全漏洞请按 [SECURITY.md](../SECURITY.md) 私下报告；贡献流程见 [CONTRIBUTING.md](../CONTRIBUTING.md)。想参与路线图上的工作，先看 [ROADMAP.md](ROADMAP.md)。

---

本文件对应 Suwen 2.0.0。
