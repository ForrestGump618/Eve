# 安装指南（INSTALL）

本指南对应 Suwen 2.0.0（Python 包名为 `omicslab`）。

本文覆盖从零安装、可选依赖、离线（无网络）安装、内核解释器选择与 Windows 终端注意事项。

---

## 1. 前置条件

| 项目 | 要求 |
|---|---|
| Python | **3.10+**（推荐 3.11；3.12 也可用，但部分生物信息包可能滞后） |
| 操作系统 | Windows 10/11、macOS 12+、主流 Linux 发行版 |
| 磁盘 | 基础安装 ≈ 200 MB；`[bio]` 全套 ≈ 1.5–2 GB |
| 网络 | 安装时需要访问 PyPI；离线安装见 [§5](#5-离线安装) |

> **当前验证状态（2.0.0）**：Windows 10/11 + Python 3.11 上实测通过 —— `pytest` 439 项、`scripts/smoke.py` 端到端自检、`scripts/publish.ps1` 产物校验、wheel 安装与 `omicslab env doctor`。记录见 [2.0.0 验证记录](VALIDATION-V2.md)。macOS / Linux 的安装与发布脚本以 bash 编写，但本仓库维护环境没有对应主机，尚未实测；如遇问题请提交 issue。SSH 远端主机与真实模型调用不在自动化验证范围内（见 [ARCHITECTURE §8](ARCHITECTURE.md#8-测试策略)）。

检查版本：

```powershell
python --version        # Windows
python3 --version       # macOS / Linux
```

如果低于 3.10：

- **Windows**：从 [python.org](https://www.python.org/downloads/) 安装时勾选 **Add python.exe to PATH**；也可用 `winget install Python.Python.3.11`。
- **macOS**：`brew install python@3.11`。
- **Linux**：优先用发行版包管理器（`sudo apt install python3.11 python3.11-venv`）或 `pyenv`。

---

## 2. 标准安装

### 2.1 Windows（PowerShell）

```powershell
cd suwen

# 允许本地脚本执行（仅当前用户，安全）
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned

# 一键安装：建 .venv → 升级 pip → pip install -e .
.\scripts\bootstrap.ps1

# 想一次装上生信依赖（scanpy / anndata 等）：
.\scripts\bootstrap.ps1 -Extras bio,dev

# 只建 .venv、不装依赖（离线准备或手动安装时用）：
.\scripts\bootstrap.ps1 -NoInstall

# 启动（CLI 默认监听 127.0.0.1:5077）
.venv\Scripts\python.exe -m omicslab serve --port 5077

# 也可以直接运行根目录的启动脚本（默认端口 8766）：
# .\启动工作台.ps1
```

### 2.2 macOS / Linux（bash）

```bash
cd suwen

chmod +x scripts/*.sh          # 首次需要
./scripts/bootstrap.sh

# 可选：带 extras / 只建 venv
./scripts/bootstrap.sh --extras bio,dev
./scripts/bootstrap.sh --no-install

.venv/bin/python -m omicslab serve --port 5077
```

### 2.3 手动安装（等价于脚本）

```powershell
# Windows
python -m venv .venv
.venv\Scripts\python.exe -m pip install --upgrade pip
.venv\Scripts\python.exe -m pip install -e .
```

```bash
# macOS / Linux
python3 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -e .
```

> `-e`（editable）安装让源码改动立即生效，适合开发。只想用不想改？去掉 `-e`：`pip install .`。

### 2.4 验证安装

```powershell
.venv\Scripts\python.exe -m omicslab --version
.venv\Scripts\python.exe -m omicslab env
```

```bash
.venv/bin/python -m omicslab --version
.venv/bin/python -m omicslab env
```

`env` / `doctor` / `env doctor` 三种写法等价，会逐项检查并给出修复建议：

| 检查项 | 期望 |
|---|---|
| Python 版本 | ≥ 3.10 |
| 核心依赖 | fastapi / uvicorn / jupyter_client / ipykernel / httpx / nbformat / pyyaml … 均可导入 |
| 内核解释器 | `resolve_kernel_python()` 能找到可执行文件 |
| 工作区 | 可读写 |
| LLM | 已检测到可用 Provider 与 Key（否则提示配置方法） |
| 可选依赖 | `scanpy` 等（bio）是否就绪；终端无需额外依赖 |

### 2.5 从发布包安装（wheel）

想直接用、不建虚拟环境？把 wheel 装进任意 Python 3.10+ 环境即可（wheel 在 `dist/` 下，用 `scripts/publish.ps1` / `scripts/publish.sh` 构建）：

```powershell
python -m pip install dist\omicslab-2.0.0-py3-none-any.whl
python -m omicslab serve --port 5077
```

```bash
python -m pip install dist/omicslab-2.0.0-py3-none-any.whl
python -m omicslab serve --port 5077
```

> wheel 自带 Web 静态资源、技能包与智能体模板，装完即可运行；生物信息分析包（scanpy 等）按需另装 `omicslab[bio]`。

---

## 3. 可选依赖（extras）

| Extra | 内容 | 适用场景 |
|---|---|---|
| **`bio`** | numpy / pandas / matplotlib / scanpy / anndata | 单细胞、空间、转录组、绘图（绝大多数分析） |
| **`dev`** | pytest / pytest-asyncio | 跑测试、开发、打包发布 |

```powershell
# Windows：常用组合
.venv\Scripts\python.exe -m pip install -e ".[bio,dev]"
```

```bash
# macOS / Linux
.venv/bin/python -m pip install -e ".[bio,dev]"
```

> 内置终端与 `run_shell` 不需要额外依赖：Windows 使用系统 PowerShell / cmd，macOS / Linux 使用系统 shell。

> **SSH 相关**：`paramiko` 已包含在核心依赖里，安装后即可创建 SSH 档案、执行远端命令、使用远端 PTY 终端与 SSH 工作区。
> 「记住密码」依赖系统凭据库（`keyring`，非核心依赖）：装了就把密码交给系统凭据库持久化，
> 没装则只在当前进程内存中保留，重启服务后需要重新输入（界面与 `GET /api/ssh/diagnostics` 会明示）。

> **运行库**：`runtime/events.db` 使用 Python 内置 `sqlite3`（WAL 模式），无需额外安装或启动数据库服务。

> 只想先跑通界面？基础安装即可；缺 `scanpy` 时 Agent 会提示安装命令，不会崩溃。

---

## 4. Jupyter 内核解释器

SuWen 的「共享内核」是一个独立的 Python 进程。它**不一定**是 Web 服务进程本身，以下规则决定用哪个解释器：

### 4.1 解析顺序

```text
1. settings.json 的 kernel_python            （Web 设置页 / PATCH /api/settings）
2. 环境变量 OMICSLAB_KERNEL_PYTHON
3. 启动 SuWen 的进程解释器（sys.executable）
4. <workspace>/.venv/... 或 <cwd>/.venv/... 下的 python
```

> 注：代码中 kernel_python 若指向不存在的文件会直接报错并提示，这是为了避免「静默用错解释器」。

### 4.2 什么时候需要手动指定

- 你的分析环境在 **conda / mamba** 里：

```powershell
$env:OMICSLAB_KERNEL_PYTHON = "C:\Users\me\miniconda3\envs\bio\python.exe"
```

```bash
export OMICSLAB_KERNEL_PYTHON="$HOME/miniconda3/envs/bio/bin/python"
```

- 项目用单独的 `venv`（例如 `D:\envs\suwen`）：

```json
// ~/.omicslab/settings.json
{
  "kernel_python": "D:\\envs\\suwen\\Scripts\\python.exe"
}
```

或 Web：**设置 → 高级 → 内核 Python**。

### 4.3 让内核能 import 分析包

内核用的解释器必须装有对应依赖。两种做法：

```powershell
# A. 装进 SuWen 自己的 venv（推荐）
.venv\Scripts\python.exe -m pip install -e ".[bio]"

# B. 若内核指向 conda 环境，在 conda 环境里装
conda activate bio
pip install scanpy anndata
```

验证：

```bash
curl -s -X POST http://127.0.0.1:5077/api/kernel/execute \
  -H "Content-Type: application/json" -d '{"code":"import scanpy; print(scanpy.__version__)"}'
```

或直接在界面对话框输入「检查内核里 scanpy 的版本」。

### 4.4 内核重启

改了 `kernel_python` 后需要重启内核（Web：内核面板 → 重启；或 `POST /api/kernel/restart`），变量会清空。

> 1.2.0 起内核按**工作区作用域**独立（`main` / `ws:<工作区 id>` / 子任务 `task:<task_id>`）。
> 改了解释器后，主工作区可用 `POST /api/kernel/restart`；其它工作区用
> `POST /api/kernels/{scope}/restart`（scope 可写 `ws:<id>` 或工作区 id）。新工作区首次执行时自动按新解释器启动内核。

---

## 5. 离线安装

适用于内网 / 无外网机器。

### 5.1 在有网机器上准备 wheel 包

```powershell
# 与目标机器「同 OS + 同 Python 版本」的机器上执行
mkdir wheels
.venv\Scripts\python.exe -m pip download -d wheels -e ".[bio]"
# 若目标机器没有编译工具，加 --only-binary=:all:
.venv\Scripts\python.exe -m pip download -d wheels --only-binary=:all: ".[bio]"
```

> 把整个项目目录（含 `pyproject.toml`）拷到有网机器，或直接 `pip download omicslab` 若已发布到包索引。

### 5.2 把 `wheels/` + 项目目录拷到离线机器

```powershell
# 离线机器
cd suwen
python -m venv .venv
.venv\Scripts\python.exe -m pip install --no-index --find-links wheels -e . --no-build-isolation
```

常见坑：

- **`--no-build-isolation`**：离线环境无法临时下载 setuptools/wheel，必须用本地已安装的构建后端。
- **平台不匹配**：Linux 上下的 wheel 在 Windows 装不上 —— 在目标平台准备，或使用 `--only-binary=:all:` 并确保该包有对应平台 wheel。
- **`[bio]` 里的 scanpy 依赖较重**：若离线包不全，先只装基础依赖，分析包单独补。

### 5.3 完全离线运行

SuWen 本身无 CDN、无遥测。要连 LLM 也离线，使用本机 Ollama：

```powershell
ollama pull qwen2.5:7b
# 设置页：Provider = Ollama，Model = qwen2.5:7b
```

---

## 6. Windows 注意事项

### 6.1 执行策略

首次运行 `.ps1` 可能被拦截：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

或单次绕过（不推荐长期使用）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
```

### 6.2 终端 / `run_shell`

- 内置终端（`/ws/terminal`）**不需要额外依赖**：服务端用 `subprocess` 启动本机 shell（优先 `pwsh`，其次 `powershell.exe`，最后 `cmd.exe`），再通过 WebSocket 桥接输出/输入。
- 带 `?profile_id=<SSH 档案 id>` 时，同一终端会切到**远端真 PTY**（paramiko `invoke_shell()`），支持窗口大小同步与 Ctrl+C；SSH 页提供入口。
- 终端等价于本机 shell（或远端登录 shell），仅在可信环境开放；共享机器上不要暴露服务（没有内置登录）。
- `run_shell` 工具同样调用本机 shell，受 `shell_timeout_s` 与工作区限制。

### 6.3 长路径

Windows 默认路径长度限制 260。深层数据目录可能触发 `OSError`：

```powershell
# 管理员 PowerShell，一次性开启
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name LongPathsEnabled -Value 1 -PropertyType DWORD -Force
```

### 6.4 中文路径 / 编码

- 项目路径含中文一般可用；如遇工具读写异常，优先把工作区放到纯英文路径（如 `D:\data\pbmc`）。
- 控制台乱码：`chcp 65001` 切 UTF-8，或使用 Windows Terminal。

### 6.5 防火墙 / 端口

服务默认只监听 `127.0.0.1`，不需要放行防火墙。若改 `host` 为 `0.0.0.0` 供局域网访问，请自行承担风险（**没有内置登录鉴权**）。

---

## 7. 更新与卸载

```powershell
# 更新源码后重装（editable 模式下通常无需重装，依赖变更时执行）
git pull
.venv\Scripts\python.exe -m pip install -e ".[bio]"
```

```bash
# 卸载
pip uninstall omicslab
# 删除虚拟环境与用户数据（谨慎：会删掉会话与图表）
rm -rf .venv ~/.omicslab
```

**备份**：`~/.omicslab`（设置、密钥、会话、运行库、工作区注册表、记忆、图表）+ 工作区。`auth.json` 含密钥，备份时注意保管。

> 1.2.0 新增：`runtime/events.db`（运行与事件，可重放）、`workspaces.json`（工作区注册表）、
> `ssh.json` / `ssh_known_hosts.json`（SSH 档案与主机指纹）、`registry/index.json`（函数索引，可随时重建）。
> 升级自 1.1 时这些文件会自动创建；旧的 `trajectories/**` 保留只读兼容。

---

## 8. 常见安装问题

| 现象 | 原因 / 解决 |
|---|---|
| `python: command not found` | Python 未加入 PATH；Windows 重装时勾选 Add to PATH，或用 `py -3.11` |
| `No module named venv` | Linux 缺 `python3-venv`：`sudo apt install python3.11-venv` |
| `pip install` 卡在 building wheel | 缺编译工具。Windows 装 [Build Tools for Visual Studio](https://visualstudio.microsoft.com/visual-cpp-build-tools/)；或尽量用 `--only-binary=:all:` |
| SSL / 代理报错 | 设置 `HTTPS_PROXY` / `HTTP_PROXY`，或 `pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org ...`（仅内网镜像场景） |
| `externally-managed-environment` | 系统 Python 受保护，用 venv（本项目脚本已默认用 venv） |
| 端口 5077 被占用 | `--port 5078`，或查占用进程：`Get-NetTCPConnection -LocalPort 5077` |
| 启动后设置页显示「无可用 provider」 | 未配置 Key；见 [常见问题 Q5](FAQ.md) |
| 内核能起但 import scanpy 失败 | 内核解释器与分析环境不是同一个，见 [§4](#4-jupyter-内核解释器) |
| `bootstrap.ps1` 提示禁止运行 | 执行策略问题，见 [§6.1](#61-执行策略) |
| SSH 连接失败 / 超时 | 检查主机/端口/用户名与网络；`GET /api/ssh/diagnostics` 可看连接池、凭据后端与最近命令；先 `POST /api/ssh/profiles/{id}/test` 试连 |
| 勾选「记住密码」重启后仍要重输 | 未安装 `keyring`，密码只在内存；`pip install keyring` 后重新保存（界面会显示凭据后端 `memory`） |
| 页面刷新后看不到当前运行进度 | 1.2.0 会按 `after_seq` 自动续传；若仍异常，看 `GET /api/runtime/diagnostics` 与 `runtime/events.db` 是否有写入 |
| 升级后旧会话/轨迹还在吗 | 在；旧 `trajectories/**` 只读兼容，会话文件原样保留，新运行写入 SQLite |

更多问题：先跑 `python -m omicslab env`（或 `doctor`），再查 `~/.omicslab/logs/server.log`。

---

本文件对应 Suwen 2.0.0。
