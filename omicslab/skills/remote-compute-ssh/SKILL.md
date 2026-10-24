---
name: remote-compute-ssh
description: "通过已配置 SSH profile 安全使用远程算力：勘察环境、传输数据、提交长任务（tmux/nohup/Slurm）、轮询状态与取回结果，含审批、完整性校验、超时与注入防护。"
when_to_use: "任务超出本机算力（GPU、大内存、集群队列）或数据已在远程服务器时；需要上传数据/脚本到远程、运行长任务、再取回小体量结果时。"
version: "1.0"
---

# 远程算力（remote-compute-ssh）

## 何时用 / 何时不用
- **用**：本机内存/GPU 不足；数据在机构集群；单次运行 >10 分钟；需要 Slurm/PBS 排队。
- **不用**：本机 `run_python_code` 几十秒能跑完；远程只是「看起来更专业」。远程的代价是调试慢、数据搬运、审批与安全风险。
- 远程任务优先用 `submit_background_job` 在本地跑长任务；只有确实需要远程环境/GPU 才上 SSH。

## 安全红线（优先级最高）
1. **不回显凭据**：密码/私钥/口令只存在于设置页配置的 profile；不得写入代码、日志、报告或对话。若工具输出疑似含密钥，立即停止并报告。
2. **先勘察再执行**：任何写操作前先 `ssh_remote_info` + `ssh_exec` 只读命令确认身份、路径、磁盘、环境。
3. **审批是硬门槛**：`ssh_exec`、`ssh_upload` 需要用户审批；被拒时不要绕道（例如改用本地伪造结果），改为说明需要什么权限。
4. **下载上限 200MB**：超限会被拒绝。远程先聚合/压缩成小结果；大文件拆分或让远程分析只回传摘要。
5. **防注入**：不要把用户输入直接拼进 shell；参数用单引号包裹并转义，或先传到脚本再执行。不允许 `eval` 未审查内容。
6. **不覆盖不删除**：上传/生成前确认目标路径不存在；删除/移动前必须 `ls` 确认绝对路径。

## 工具速查
| 工具 | 用途 | 注意 |
|---|---|---|
| `ssh_list_profiles()` | 列出已配置 profile 与主机别名 | 只返回非敏感信息 |
| `ssh_remote_info(profile_id)` | 主机名、系统、CPU/内存/GPU、家目录 | 第一步必做 |
| `ssh_exec(profile_id, command, timeout_s=120)` | 执行同步命令 | 长任务放后台；超时留足 |
| `ssh_upload(profile_id, local_path, remote_path)` | 上传数据/脚本 | 需审批；先查 remote 是否存在 |
| `ssh_download(profile_id, remote_path, local_path)` | 取回结果 | ≤200MB；先算 sha256 |

## 标准工作流
### 1. 勘察（只读）
```text
ssh_list_profiles()
ssh_remote_info(profile_id="gpu-01")
ssh_exec(profile_id="gpu-01", command="hostname; whoami; df -h ~; nvidia-smi -L 2>/dev/null | head", timeout_s=60)
```
确认：登录的是预期主机、家目录有空间、GPU 型号/数量符合任务、Python/conda 环境存在。

### 2. 环境核对
```text
ssh_exec(profile_id="gpu-01",
  command="python -V; python -c 'import sys; print(sys.executable)'; which conda || true; nproc",
  timeout_s=60)
```
> 远程 Python 与本地不同：包版本、CUDA 驱动、文件系统路径都要在脚本里显式打印，写进结果元数据。

### 3. 传输数据（先小后大）
```text
ssh_exec(profile_id="gpu-01", command="test -e ~/work/expr.h5ad && echo EXISTS || echo MISSING")
ssh_upload(profile_id="gpu-01", local_path="data/expr.h5ad", remote_path="~/work/expr.h5ad")
```
- 上传前本地算 `sha256`，上传后在远程 `sha256sum` 对比；不一致就重传，不要直接开跑。
- 路径含空格/中文时使用引号；`~` 展开在远程执行，本地路径不展开。
- 大数据优先只传必要列/子集；能在本地压缩就先压缩。

### 4. 提交长任务（后台 + 日志）
不要用前台命令等 30 分钟。用 tmux/nohup 或集群调度：
```text
ssh_exec(profile_id="gpu-01",
  command="mkdir -p ~/work/logs && cd ~/work && tmux new-session -d -s rsi 'python run_analysis.py > logs/round1.log 2>&1'",
  timeout_s=30)
ssh_exec(profile_id="gpu-01", command="tmux ls; tail -n 20 ~/work/logs/round1.log", timeout_s=30)
```
Slurm 示例（按集群实际改写）：
```text
ssh_exec(profile_id="cluster", command="sbatch --job-name=rsi ~/work/run.slurm", timeout_s=30)
ssh_exec(profile_id="cluster", command="squeue -u $USER; tail -n 20 ~/work/slurm-*.out", timeout_s=30)
```
- 脚本里必须写：输入路径、输出路径、随机种子、包版本、失败即非零退出。
- 不要用 `nohup ... &` 后立即关连接而不确认进程仍在；tmux/screen 更稳。

### 5. 轮询与失败处理
```text
ssh_exec(profile_id="gpu-01", command="tmux ls 2>/dev/null; tail -n 30 ~/work/logs/round1.log", timeout_s=30)
```
- 轮询间隔 ≥30s，别高频刷；超过 `timeout_s` 的同步命令要改成后台。
- 失败先看日志最后 30 行与退出码；不要盲目重跑（可能重复写结果）。
- 网络中断后先检查进程/锁文件，再决定重跑还是续跑。

### 6. 取回结果与校验
```text
ssh_exec(profile_id="gpu-01", command="cd ~/work && tar -czf results_round1.tar.gz results/ && sha256sum results_round1.tar.gz && ls -lh results_round1.tar.gz", timeout_s=60)
ssh_download(profile_id="gpu-01", remote_path="~/work/results_round1.tar.gz", local_path="data/remote/results_round1.tar.gz")
```
- 下载后本地校验 sha256；解压前先看 tar 内容（`tar -tzf`）。
- 结果文件命名带轮次/时间戳，避免覆盖上一轮。
- 远程临时文件在确认下载成功后清理；清理前列出绝对路径。

## 本地校验与记录（run_python_code）
```python
import hashlib, pathlib, json
p = pathlib.Path("data/remote/results_round1.tar.gz")
h = hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else None
meta = {"file": str(p), "sha256": h, "bytes": p.stat().st_size if p.exists() else 0,
        "profile": "gpu-01", "remote_path": "~/work/results_round1.tar.gz"}
pathlib.Path("results").mkdir(exist_ok=True)
pathlib.Path("results/remote_provenance.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2))
print(meta)
```
把 `remote_provenance.json` 写进报告的可复现清单：主机别名（非地址）、远程路径、命令、时间、sha256。

## 检查清单
- [ ] 已 `ssh_remote_info` 确认主机/用户/空间/GPU。
- [ ] 远程 Python 解释器与包版本已打印并记录。
- [ ] 上传/下载均校验 sha256，路径无覆盖。
- [ ] 长任务在 tmux/Slurm 中运行，日志可追。
- [ ] 命令参数做了引号/转义，无用户输入直接拼接。
- [ ] 未在输出中出现任何密码/私钥/令牌。
- [ ] 下载文件 ≤200MB，或已聚合为小结果。
- [ ] 结果带回轮次与时间戳，失败路径有日志。
- [ ] 审批被拒时有替代方案说明，没有伪造结果。

## 常见陷阱
1. **前台跑长任务**：`ssh_exec` 超时中断，任务状态不明；用 tmux/nohup。
2. **路径假设错误**：远程家目录/conda 环境与本地不同；先 `pwd`/`which python`。
3. **覆盖已有结果**：上传/生成前不检查目标，导致上一轮数据丢失。
4. **不校验传输**：网络截断的大文件能打开一半，分析结果全错。
5. **把密码写进命令**：出现在 shell 历史/日志/对话里；只用 profile。
6. **下载超大结果**：>200MB 被拒后反复重试；应在远程聚合。
7. **命令注入**：用户提供的文件名直接拼进 shell；用引号/白名单。
8. **集群排队忘记资源**：申请 1 卡跑 8 卡任务或反之；先看 `sinfo`/队列说明。
9. **把远程 mock/失败当成功**：进程退出码非 0 但日志里有结果文件，仍应判失败。

## 验证方法
- **身份验证**：`hostname/whoami` 与预期一致；`ssh_remote_info` 的 GPU/内存与任务需求匹配。
- **完整性**：两端 sha256 一致；解压后文件数与清单一致。
- **可复现**：远程命令、脚本、环境、种子记录在 `remote_provenance.json`。
- **审计**：重跑同一条只读勘察命令，确认环境未被他人改变。
- **失败演练**：故意给错路径，确认流程在跑分析前就报错，而不是产出空结果。

## 交接
- 远程任务编排与排障 → `remote-compute-engineer`；结果分析 → 对应领域 skill。
- 远程产出进入证据链前 → `evidence-critic` 检查 provenance 是否完整。
