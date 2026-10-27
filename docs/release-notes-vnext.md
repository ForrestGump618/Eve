# 素问 SuWen：项目审计与阶段交付

2026-10-24 · 第一阶段可安装预览版 **3.0.0-preview.1**。已按附件完成有证据的审计与一批实际实现；**不是完整附件的全部验收完成**。

## 直接交付

- 安装包：`SuWen-Setup-3.0.0-preview.1-win-x64.exe`，129,363,809 字节（约 123.4 MiB）。
- SHA-256：`f263af7bb412ccbb2fb3a8f1798d35d2a7210997954e68669ed110b62a55514c`。
- 安装包未签名，Windows 可能显示 SmartScreen 提示。已核验 NSIS 压缩完整性与 SuWen 应用元信息；没有在本机运行安装器冒充干净环境安装验收。
- 源码工作目录：`C:\Users\Qingyuan Zhuang\Documents\Codex\2026-10-23\c-users-qingyuan-zhuang-documents-deepseek-2\outputs\omicslab`；实现分支 `suwen-vnext-durable`；回退基线 `suwen-vnext-baseline-20261024`（8cabac3）。
- 新源码在 `desktop/`，主构建产物在 `desktop/release/`，并复制到项目 `dist/`。源代码与报告归档随本次交付提供。

## 审计结论

现有项目实际是 Python/FastAPI + 原生网页工作台，并无原有 Electron/TypeScript 工程。此次保留原代码、配置兼容和用户数据，另建桌面壳与独立后台，不执行破坏性迁移。现有 Python 源码继续保留 Apache-2.0，新写桌面代码为 MIT，附第三方许可。

外部项目 2.3.3：用户提供的 260,716,184 字节安装包 SHA-256 为 `fea1c4f21ebd79e3e6a63922f4e64320a5cd5ea697d9863c3462c0165da38b3c`。实测是未签名 NSIS 安装器，内含 Electron ASAR；包元数据声明 Vue、ACP、RDKit 等。仅做静态元数据/结构检查，未执行或复制其闭源 JS、图标、技能或二进制。界面、长程任务、恢复等动态行为全部保留“未知”。

DeepSeek 官方上游固定在 `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`。实际代码与文档表明默认 workflow/jobs 不等价于附件要求的持久执行；采用独立实现为主、未来适配为辅。没有把社区同名项目当成官方，也没有捆绑上游代码。

## 已实现与实际验证

- 五工作区、中英切换、流式聊天、任务执行记录、模型设置和诊断。OpenAI-compatible/Anthropic 两协议通过本地 HTTP fixture 验收，尚未用外部付费账号验证。
- 独立 OS 进程后台、鉴权 named pipe、SQLite WAL、DAG、lease/fencing、检查点、工件哈希、取消/暂停/恢复及未知副作用人工核查。
- 独立 ContextManager：已知模型 tokenizer、未知模型保守估算，70/82% 压缩阈值；原始日志哈希链、结构化摘要、来源/产物/DAG/审批/环境引用、版本回滚、工作线程分词。十轮约 20 万 token 历史压缩测试通过；显式约束/证据/用户原文保留率100%，不宣称所有语义无损。
- 固定只读 MCP 子进程：公开 Europe PMC/PubMed 与 UniProt 两路真实调用成功，最终打包程序内也完成调用；数据附 ID、检索时间及版本。
- 可选 Python 固定统计样例真实运行；完整原科研工作台可从兼容入口打开，使用新独立 home、默认 mock 和独立配置。HTTP/WebSocket 逐请求鉴权，窗口无 Node 权限，停止后 Python/Jupyter 子进程清理通过。
- 原项目完整测试 **482 通过**；桌面测试 **48 通过、0跳过**；打包后 Electron **10 组 E2E 通过**；中英界面 **8 组 DOM 验收通过**。真实窗口关闭后，后台完成30秒任务并能原PID重新接入。
- 当前 Node 运行依赖 advisory 扫描为0；有 SBOM、许可文本、构建环境、测试日志及品牌兼容例外清单。这不是全面安全/合规审计结论。

## 仍未完成

隔离 外部项目 动态测试、干净 Windows 安装/升级/卸载、8/24/72小时耐久/断电/重启测试尚未执行。未配置外部模型账号；费用与所有模型 token 的精确硬预算、OS资源硬隔离、Windows Service/远端worker仍未完成。Paper2Agent、Biomni/ERA/Robin/Kosmos 的完整验收、全部旧工具接入新执行器、自动数据导入及完整 RSI 晋级回滚仍需后续实现。新旧任务的恢复语义不同，不对兼容工作台承诺新durable机制。

详细的逐项完成/未知/未完成清单与源码证据保存在 `docs/progress.md`、`desktop/acceptance-matrix.md` 和 `docs/research/`；本次归档均包含这些文件。

## 使用

运行安装包后，在设置中填写自己的模型地址、模型名及密钥。聊天和 MCP 无需 Python；固定分析/兼容工作台需要选择带依赖的 Python。关闭窗口会保留后台；设置中的“完全退出后台”会安全停止工作。登录自启需用户自行启用，未安装系统服务。旧数据不会自动迁移或覆盖。
