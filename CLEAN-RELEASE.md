# 素问 1.0.0 源码与发布边界

本分支从已提交的历史基线继续开发，产品版本统一为 1.0.0。Git 历史中的 3.4.0、2.1.1 和更早版本作为历史记录保留，不能与本轮验收声明混用。

## 源码范围

- `desktop/`：Electron、TypeScript Agent Harness、MCP/Skill 客户端、托盘生命周期、打包脚本与自动化测试。
- `omicslab/`：既有科研工作台、Python Worker、SSH 执行后端、科研 Skills、科研页面与兼容接口。
- `integrations/dsh/`：独立 DSH 兼容插件，作为可选集成保留，不声称包含在当前 Windows 安装包内。
- `tests/`：Python 单元、集成与安全回归。
- `docs/verification/release-1.0/`：面向公开复核的精炼证据；机器专属原始日志不进入 Git。

## 不进入源码包

源码发布不包含 API Key、SSH 密码或私钥、用户会话、数据库、缓存、`node_modules`、编译产物、安装目录或机器专属 Trace。安装包作为 GitHub Release 二进制资产单独上传。

## 发布前验证

- Python 与 TypeScript 全量测试、类型检查和差异格式检查通过。
- 固定 22 项真实模型任务使用同一任务集与模型完成前后对照。
- 正式页面、打包应用与托盘运行真实 Electron E2E；MCP 测试实际发现并调用工具，Skill 测试实际安装和执行。
- 实际 SSH 主机覆盖文件、搜索、编辑、Shell、Python、Skill、断线重连、凭据复用与本地隔离。

准确计数、安装包 SHA-256、性能结果和未验证项见 [1.0 验收报告](docs/verification/release-1.0/REPORT.md)。安装包未签名；干净虚拟机、长期耐久、跨重启/休眠、实际私钥/系统 SSH Agent、第二台物理主机与远程 stdio MCP 不作为本版本的已通过项。
