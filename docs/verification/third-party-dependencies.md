# Third-Party Dependencies, Licenses and Supply Chain (R092/R094)

Date: 2026-10-25 (Asia/Shanghai) · Auditor: docs-audit (D)
Scope: TARGET_ROOT `desktop-vnext` — the new Electron desktop app (`desktop/`), the preserved Python baseline, and the bundled legacy workbench. Evidence files are under `docs/research/evidence/`. Only facts present in the repository are stated; nothing was re-installed or re-audited online during this audit.

## 1. Runtime dependency inventory (new desktop app)

From `desktop/package.json` and `desktop/package-lock.json` (pinned):

| Package | Version | Scope | License (declared) | Evidence |
|---|---|---|---|---|
| `js-tiktoken` | 1.0.21 | production (bundled Node runtime) | MIT; tokenizer vocabulary derived from `tiktoken` (MIT) | `desktop/package.json`; `desktop/NOTICE`; `third-party-licenses/inventory.json`; SBOM `js-tiktoken@1.0.21` SHA-512 `6e23a3ff…7ea` |
| `base64-js` | 1.5.1 | transitive (bundled) | MIT | `third-party-licenses/inventory.json` |
| `Electron` | 45.0.0 | runtime (Chromium/Node) | MIT plus bundled Chromium/Node dependency licenses (`LICENSES.chromium.html` shipped by Electron, not re-licensed) | `third-party-licenses/inventory.json`; `build-environment.json` packagedRuntime |
| Node.js runtime | 24.22.0 (packaged) / 24.14.0 (build) | runtime | Node.js license (shipped by Electron) | `build-environment.json`, `desktop-test.log`, `windows-build.log` |
| Chromium | bundled in Electron 45 | runtime | Chromium/BSD-style notices shipped in Electron runtime | `desktop/NOTICE` |

## 2. Build / development dependencies (not shipped)

| Package | Version | Use | License |
|---|---|---|---|
| `typescript` | 7.0.2 | compile | Apache-2.0 |
| `electron-builder` | 26.18.0 | NSIS packaging | MIT |
| `@types/node` | 24.12.0 | types only | MIT |
| `playwright-core` | 1.64.1 | packaged E2E harness | Apache-2.0 |

`npm audit --omit=dev` evidence (`docs/research/evidence/runtime-npm-audit.json`, generated for the prototype build): **0 vulnerabilities** across 306 total (prod 3, dev 304, optional 43, peer 13) with info/low/moderate/high/critical all 0. This is an npm advisory snapshot at build time, not a guarantee for future advisory databases.

## 3. Preserved Python baseline and legacy workbench

- Root `LICENSE`: **Apache-2.0** (11,357 B) — preserved with original copyright/notice for the Python implementation (`omicslab/`), per R092.
- New desktop code: MIT (`desktop/LICENSE`, "Copyright (c) 2026 SuWen contributors").
- `desktop/NOTICE` states: new desktop code MIT; parent Python retains Apache-2.0; **no KongMing code/assets/skills/binaries distributed**; **no DeepSeek Harness code bundled**; optional compatibility workbench is original Apache-2.0 Python source under `resources/legacy` with its LICENSE; Python interpreter and its packages are **not bundled** (user supplies interpreter).
- Runtime Python dependencies (declared in `pyproject.toml`): fastapi >=0.110, uvicorn[standard] >=0.27, jupyter_client >=8.6, ipykernel >=6.29, httpx >=0.27, nbformat >=5.10, python-multipart >=0.0.9, pyyaml >=6.0, rich >=13.7, prompt_toolkit >=3.0, websockets >=12.0, paramiko >=3.4, qrcode >=8.0,<9; optional bio: numpy >=1.26, pandas >=2.1, matplotlib >=3.8, scanpy >=1.10, anndata >=0.10; dev: pytest >=8.0, pytest-asyncio >=0.23. The Python distribution declares Apache-2.0 itself; transitive Python license texts are not bundled because Python/packages are not shipped.

## 4. License / notice artifacts present in repo

| Artifact | Path | State |
|---|---|---|
| Desktop MIT license | `desktop/LICENSE` | present |
| Third-party notice summary | `desktop/NOTICE` | present |
| Third-party inventory (JSON) | `desktop/third-party-licenses/inventory.json` | 4 entries (js-tiktoken, base64-js, Electron, Python compat source) |
| base64-js license text | `desktop/third-party-licenses/base64-js-LICENSE` | present |
| CycloneDX SBOM | `docs/research/evidence/runtime-sbom.cdx.json` | CycloneDX 1.5, `suwen-desktop@3.0.0-preview.1`, MIT, tool npm CLI 11.9.0; component `js-tiktoken@1.0.21` with SHA-512 |
| npm advisory snapshot | `docs/research/evidence/runtime-npm-audit.json` | 0 vulnerabilities |
| Python baseline license | root `LICENSE` (Apache-2.0) | present |

SBOM reproduction script is declared in `desktop/package.json` (`sbom` script) and used by CI (`.github/workflows/suwen-windows.yml`).

## 5. Supply-chain controls observed (R094)

| Control | State | Evidence |
|---|---|---|
| Dependency version pinning | `package-lock.json` committed; exact versions in CI (`npm ci`) | `desktop/package-lock.json`; workflow |
| SBOM generation | available as npm script + CI step | `package.json`, workflow |
| Advisory scan | npm audit snapshot: 0 vulns (prod) | `runtime-npm-audit.json` |
| Code-signing status | **Honest disclosure: build is UNSIGNED** (`signExecutable: false`), SmartScreen warning documented; no fake signature claims | `desktop/package.json`; `docs/progress.md`; `docs/release-notes-vnext.md`; `build-environment.json` (`signed:false`) |
| Downloaded-executable permission | Skill install contract requires explicit `confirm:true` + static checks before enable; daemon rejects unregistered step kinds | `desktop/src/shared/contract.ts`; `docs/architecture/vnext-contract.md` |
| Dangerous commands default | approvals/policy machinery exists; no blanket shell exposure in vNext UI (no UI wiring yet) | `desktop/src/security.ts`, `daemon.ts` approval step |
| Installer hash publication | **NOT AVAILABLE in TARGET** — no `SHA256SUMS`, no `.exe` artifact (prototype only). CI produces `SHA256SUMS` when run | `docs/release/windows-installer-verification.md` (PENDING_LEAD) |

## 6. Gaps and honest limitations

1. **No installer artifact or checksum in this workspace** — supply-chain verification of the release can only be completed after the Windows CI (or Lead) produces the NSIS installer and `SHA256SUMS`. Status: PENDING_LEAD.
2. **No code signing certificate**; unsigned build is disclosed, not fixed. SmartScreen risk is real for end users.
3. **SBOM scope is runtime JS/Node only** (`js-tiktoken`, Electron metadata); it does not enumerate Chromium/Node third-party packages shipped inside the Electron runtime. No SBOM for the Python baseline (not shipped) and no `pip-audit`/`safety` result in the repo.
4. **License audit is not comprehensive/legal**: the repo has notices and inventory, but no per-transitive-license report for Electron/Chromium. Python dependency licenses rely on the user-supplied environment.
5. **No signature verification of downloaded skills** (planned static checks only) and no marketplace trust chain (R061/R062 gaps).
6. `runtime-npm-audit.json` was produced for the prototype package set; re-run `npm audit` in TARGET after dependency changes for release.

## 7. Reproduce / re-verify (when artifact exists)

```powershell
cd desktop
npm ci
npm run sbom -- --omit=dev
npm audit --omit=dev --json | Out-File ..\docs\research\evidence\runtime-npm-audit.json
npm run dist:win
Get-FileHash release\SuWen-Setup-*.exe -Algorithm SHA256 | Format-List > release\SHA256SUMS
```

Then update this file and `docs/release/windows-installer-verification.md` with the real artifact path, bytes and SHA-256 (do not copy the prototype numbers as if they were the TARGET build).

## 7. 上游项目 / 参考系统清单（非依赖，未打包代码）

> 范围说明：本节回应任务书要求列出 DSH、Kimi Code、Biomni、Paper2Agent、ERA、Robin、Co-Scientist、Kosmos、
> pubmed-mcp-server、lifesciences-research 等上游。事实来源仅限本仓库已有审计文档：
> `docs/research/deepseek-harness-audit.md`、`docs/research/upstream-commits.md`、`docs/REFERENCES-V2.md`、
> `docs/research/branding-exceptions.md`、`docs/progress.md`。**本轮审计没有下载、安装或重新联网核验任何上游**；
> 凡仓库内无许可证记录的条目一律写 `NOT_REVIEWED`，不推断为 MIT/Apache。

| 上游 | 版本/快照（仓库证据） | 许可证（仓库证据） | 代码是否被捆绑 | 真实连通/凭据需求 | 状态与证据 |
|---|---|---|---|---|---|
| DeepSeek Harness (DSH，官方) | master/HEAD `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`；tag `dsh-v0.2.1-rc.3` = `1f81c047fc48fa190a683e469daa699857e9afe8`；ZIP SHA-256 `088b7edccadb5577c7cf3898aa899de6a4efab15dc2e7cc80e43a6f8a8df65d3`（50,937,370 B） | **MIT**（`Copyright (c) 2026 DeepSeek`，LICENSE 实读；THIRD_PARTY_NOTICES 另含 Apache-2.0/MPL-2.0 等） | **否**：`desktop/NOTICE` 明示无 DSH 代码；决策 III“独立实现”；`docs/architecture/reuse-decision.md` | 仅静态源码审计；无 API/账号需求；未执行任何上游脚本/测试 | `docs/research/deepseek-harness-audit.md`、`upstream-commits.md`（审计完成，无集成） |
| KongMing（用户提供的 2.3.3 安装包） | 安装包 260,716,184 B；SHA-256 `fea1c4f21ebd79e3e6a63922f4e64320a5cd5ea697d9863c3462c0165da38b3c` | 未声明/未审查（私有分发；R081 禁止反向工程与集成） | **否**：仅静态包元数据观察（`desktop/NOTICE` 明示不分发其代码/资源/技能/二进制） | 未执行安装器、未启动进程；无账号 | `docs/research/kongming-*.md`；`docs/research/evidence/{package-metadata.json,installer-inventory.txt,payload-inventory.txt}` |
| Kimi Code（Moonshot CLI） | 未引入/无快照 | `NOT_REVIEWED` | 否 | 仓库仅有“Kimi”作为 **模型 Provider**（OpenAI 兼容适配，`install.md`/COMPARISON 提及）；Kimi Code CLI 未安装、未审查 | 无代码证据 → `NOT_REVIEWED`（不计完成） |
| Biomni（snap-stanford/Biomni） | 无快照（仅设计参考） | `NOT_REVIEWED`（仓库仅说明“参考”，未列 LICENSE） | 否；未打包 E1/数据湖（`docs/REFERENCES-V2.md`、`docs/BIOMEDICAL-EVIDENCE.md`） | 需要上游 Python 环境与（可选）模型/API；本轮无 | 参考设计已用于 skill `biomedical-discovery`（自编）；`BLOCKED_EXTERNAL`（上游环境未安装） |
| Paper2Agent（jmiao24/Paper2Agent） | 无快照（登记册 R053 记为 MIT 目标） | **MIT（登记册声明；本轮未复核 LICENSE 文件）** | 否；skills 中为自编 `paper2agent` 方法手册（`docs/SKILLS.md:206`） | 需要论文/仓库/环境与回归执行；完整自动化未实现 | 部分：方法手册存在；安装/自动工程化 `NOT_STARTED`（R113） |
| ERA（Empirical Research Assistance，arXiv:2509.06503） | 论文引用，无代码快照 | 不适用/`NOT_REVIEWED`（未引入代码） | 否 | 上游“程序搜索器”未提供 | 仅方法参考（`docs/REFERENCES-V2.md:11`）→ `BLOCKED_EXTERNAL` |
| Robin（Future-House/robin） | 无快照（仅参考） | `NOT_REVIEWED` | 否；skills 中为自编 `robin` 方法手册（`docs/SKILLS.md:211-213`） | 需要上游环境/FutureHouse 第三方 API | `BLOCKED_EXTERNAL`；完整环境未安装（`docs/ROADMAP.md:79`） |
| AI Co-Scientist（Google，arXiv:2502.18864） | 论文引用，无代码 | 不适用（论文；未引入代码） | 否 | 无 | 设计参考：有限轮讨论 DAG（`docs/REFERENCES-V2.md:9`）→ `NOT_STARTED` 为主 |
| Kosmos（Edison Scientific） | 无快照/无仓库内 URL | `NOT_REVIEWED` | 否 | 商业 API/账号（未配置） | `docs/progress.md` 列为未完成项；无代码证据 → `BLOCKED_EXTERNAL` |
| pubmed-mcp-server（npm/MCP） | 仓库内未固定该包版本 | `NOT_REVIEWED` | 否 | 真实 PubMed 调用可用（Europe PMC 实际通过） | 仓库实际调用的是 **Europe PMC REST + UniProt MCP**（`live-mcp-results.json`）；pubmed-mcp-server 未引入 → `NOT_REVIEWED` |
| lifesciences-research（MCP server） | 无快照 | `NOT_REVIEWED` | 否 | 未配置 | 无代码/配置证据 → `NOT_REVIEWED` |
| 其他设计参考（Dify、Open WebUI、OpenHands、VS Code Remote SSH、shadcn/ui、OpenChamber、MCP transports 规范、Europe PMC REST、UniProt API） | 见 `docs/REFERENCES-V2.md` 链接 | 各自上游许可证；本轮未逐一复核 | 否（仅设计参考，未复制源码/品牌） | Europe PMC/UniProt：真实 HTTP 调用通过（无凭据）；其余仅阅读 | `docs/REFERENCES-V2.md`；真实调用证据 `docs/research/evidence/live-mcp-results.json` |

## 8. 供应链结论与缺口

1. **随包分发的运行时依赖**（Electron/Node 运行时、`js-tiktoken`、`base64-js`、可选 legacy Python 源）已在第 1/3 节和下表登记；npm 生产依赖 advisory 快照为 0 漏洞（原型构建时，非长期保证）。
2. **上游参考项目均未捆绑代码**；DSH 为 MIT 静态审计（决策 III 独立实现），KongMing 仅静态包观察且按 R081 禁止集成。
3. **无法完成的验证**（`BLOCKED_EXTERNAL`/`NOT_REVIEWED`）：真实外部模型账号、Biomni/Robin/ERA/Kosmos 等上游环境与 API、Kimi Code CLI、pubmed-mcp-server/lifesciences-research 安装、各上游许可证逐项复核（本轮无网络重装）。
4. 发布前需由 Lead 决定：是否为可选的科研上游（Biomni/Robin/ERA）建立锁定版本与 SBOM 条目；若继续以“方法参考、不捆绑”为边界，应保持本文件与 `docs/REFERENCES-V2.md` 的表述一致。
5. 未执行项不得计入 R092/R094 完成度：R092 的“LICENSE/NOTICE/第三方许可清单/SBOM”已具备；R094 的“上游逐项签名/哈希核验、许可证全量复核”仍为 `UNVERIFIED`。

