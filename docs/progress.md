# SuWen vNext — actual progress / 2026-10-24

Delivered **3.0.0-preview.1**, a first implementation slice. The full attachment is **not yet accepted as complete**. Work was performed after source/static package/upstream audit, on `suwen-vnext-durable` with rollback tag `suwen-vnext-baseline-20261024` at `8cabac3`. Existing ignored user state was not opened, replaced or migrated.

## Completed and verified

- Source audit: baseline is Python/FastAPI and ES Modules, not Electron. Preserve this code and its data contracts. Fix an independently reproduced job status/exit-code race; full original Python suite now **482 passed, one dependency deprecation warning**, 36.52 seconds.
- KongMing static identity, unsigned PE resources, NSIS payload/ASAR inventory and package metadata. No installer/app execution, private-source recovery, asset copying or backend probing. Dynamic behavior remains unknown.
- Official DeepSeek Harness pinned source review at `22ddee3792402c3e70ec5f86a63c3e3e895a2f60`; independently implement core durability (III), retain future adapter option (II). No upstream source bundled.
- New MIT desktop: Electron main + sandboxed preload/renderer, restrictive local CSP, schema-checked IPC and sender checks; original icon and SuWen executable metadata; five workspaces, complete Chinese/English labels, stable composer, bounded visible history, streamed text, event panels and redacted support export.
- Detached Node daemon: authenticated current-user named pipe; SQLite WAL/FULL/foreign keys/busy timeout; versioned migrations and backups; state/event/checkpoint/artifact transactions, CAS, leases/fencing/heartbeat/reclamation, DAG, durable timers, explicit controls, bounded retries and uncertain-effect reconciliation. Model credentials lock queued work without consuming attempts.
- ContextManager/CompactionService: real known-model tokenizer plus tool/schema/output reserves, explicit conservative unknown-model estimates, 70/82% thresholds, append-only source hash chain, structured source-linked summaries, large tool output artifacts, complete tool groups, coverage checks, versions/manual compaction/rollback and restart replay. Tokenization runs in serialized worker threads. Ten ~201k-token rounds reduced to ~2.0–2.8k; explicit test constraints/evidence/user text retained 100%, **not a claim of semantic losslessness**.
- OpenAI-compatible and Anthropic protocol adapters verified with real local HTTP fixture servers, including malformed/incomplete streams, errors, UTF-8, cancellation and usage. No external paid-account success claimed. Credentials only persist through OS encryption; no silent provider fallback.
- Fixed read-only MCP stdio server/client: actual public Europe PMC/PubMed and UniProt searches succeeded, including from the final packaged daemon using inherited Windows system proxy. Results preserve source IDs, DOI, retrieval time and UniProt release. No third-party upstream MCP server installation claimed.
- Optional Python fixed statistics worker: actual public [2,4,4,6,9] sample, input hash and interpreter version. Full original research workbench accessible in a separate sandboxed compatibility window, per-process Bearer authentication on all HTTP/WS, new isolated home/default mock, no copied credentials. Tests prove server and Jupyter kernel cleanup. Legacy task semantics remain distinct from the new durable engine.
- New desktop automated suite: **48 passed, zero skipped**, approximately 80.4 seconds in final full run. Real packaged Electron E2E: **10 checks passed**, including UI exit/background 30-second timer, same-daemon reopen, live MCP, fixed Python and authenticated legacy window. Separate bilingual DOM QA: **8 groups passed**. Logs retained under research/evidence.
- Real Windows x64 NSIS installer produced, archive integrity checked, original icon/metadata verified; unsigned. Node runtime npm advisory scan reported zero current production advisories; runtime SBOM and license texts recorded. Existing Python source remains Apache-2.0; no relicensing of third-party assets.

## Unfinished acceptance gates / next work

1. KongMing isolated dynamic matrix and clean Windows install/upgrade/uninstall require a VM/snapshot/test account. No available isolated environment was found; host execution was not substituted.
2. Actual elapsed 8/24/72-hour fault injection, reboot/sleep/power loss/disk full and measured recovery rates remain unperformed. Short real SIGKILL tests do not establish endurance.
3. Real external model-account verification requires user-supplied endpoint/credentials; current protocols passed local fixtures. Money limits, failure-side provider charges and all proprietary tokenizers are not exact prepaid guarantees. CPU/memory/disk OS quotas, Windows Service, remote/Temporal workers remain incomplete.
4. Complete new-executor bridge for all legacy scientific workflows, third-party Skill/MCP supply-chain lifecycle, Paper2Agent installation/test, Biomni/ERA/Robin/Kosmos/co-scientist integration and full RSI review/canary/promotion/rollback remain incomplete. Existing functionality is preserved and reachable through compatibility mode, not re-validated as new scientific integrations.
5. No automatic legacy data import is performed. A backup-driven explicit import UI and exhaustive legacy migration tests remain required. Compatibility namespaces/distribution/storage IDs/history/copyright are listed in branding-exceptions.md.
6. Versioned summaries cover explicit harness facts and extracted source lines; arbitrary natural-language semantics and scientific conclusions still require review. Proposal/critique/revision uses configured model calls, not independent experimental validation. Full virtualization, all model/tool streaming envelopes and unlimited history UI remain outside this preview.

See desktop/acceptance-matrix.md, architecture/feature-provenance-matrix.md and research reports. Do not describe this preview as full vNext completion or a universally reliable long-running research system.

## 3.1.0 update — 2026-10-25

Delivered desktop **3.1.0** on `suwen-vnext-durable`. The full attachment is still **not accepted as
complete**; the items below are the Lead-measured evidence set for this increment. Details and
reproduce commands: `docs/verification/integration-and-e2e.md`,
`docs/release/windows-installer-verification.md`, `docs/migration/feature-parity-matrix.md`,
`docs/requirements/master-requirements.csv`.

### Verified in TARGET

- Typecheck `npx tsc -p tsconfig.json --noEmit` exit 0; `npm run build` exit 0.
- Unit/integration `npm test`: **150 tests, 148 pass, 0 fail, 2 skipped**, **28.3 s**, exit 0. Skips:
  Windows symlink `EPERM` (research-worker test) and missing optional legacy Python deps.
- RPC E2E against a real detached daemon over the authenticated named pipe:
  `node scripts/e2e-rpc.mjs --dist dist --live` → **42 passed / 0 failed**, ~7 s. Includes **real**
  public-database calls: Europe PMC/PubMed query `CRISPR base editing` (first hit **PMID 42878939**,
  *In-vivo CRISPR/Base-Editing "One-Shot" Therapies Targeting PCSK9.*) and UniProt `TP53`
  (first hit **Q9Y2B4 / T53G5_HUMAN**, release **2026_03**), responses stored as durable artifacts
  with `sha256`; doctor (11 checks), registries, research graph, artifact path guard, cancel, Python
  sandbox and clean shutdown also covered.
- Packaged Electron smoke (`SUWEN_SMOKE_PACKAGED=1 node scripts/electron-smoke.mjs`) on the **final
  build**: **8/8 checks**, exit 0, **106 s** on `release/win-unpacked/SuWen.exe` — detached daemon +
  authenticated pipe, context-isolated renderer, safeStorage-encrypted config, streamed/committed
  fixture chat, UI-close keeps daemon, **30 s durable timer completes after UI exit** (`attempts=1`),
  reopen attaches same daemon and restores history, packaged Python worker sandbox exits 0. Legacy
  Python workbench was recorded **unavailable on this machine** (Python lacks `fastapi`) — not a pass;
  packaged live-MCP step skipped by its `SUWEN_SMOKE_LIVE` gate (live DB coverage comes from RPC E2E).
- UI QA `node scripts/ui-dom-qa.mjs`: **19 passed / 0 failed / 10 warnings** (warnings = the five
  intentional main-process bridge methods); `node --check desktop/ui/app.js` exit 0;
  `ui/actions.json` **142 actions**, contract **79 RPC methods**, five workspaces and research/MCP/
  Skill/Channel/RSI panels present.
- Python research worker **v2.0.0** (`suwen-research-worker/2`, pure stdlib): tests **22 / 21 pass /
  1 skip**; real demo.fcs metrics (FSC-A mean 50357.318211, SSC-A 30390.826209, FL1-A 734.915157,
  FL2-A 363.630725, FL3-A 788.096841; Otsu gates 3199/1979/1612/653/1279); `runScript` sandbox
  timeouts/output caps/env allowlist/file digests now committed as durable artifacts.
- Real NSIS installer rebuilt from **frozen final code** in TARGET:
  `desktop/release/SuWen-Setup-3.1.0-win-x64.exe`, **129,425,145 bytes**, SHA-256
  `e1a1062cbacaf978f6b60f2a825d2e2e769c231048a65983113e8e434ba07ac4`, built
  `2026-10-24T17:41:52Z`, unpacked `SuWen.exe` 249,801,728 bytes / SHA-256
  `cfe87f2de046e0ab8d58f4ddb4c9898407f67129ef353bdacfef35376a3bb397`, **UNSIGNED**.
  Build needed `npmmirror` mirrors after a direct GitHub timeout. Layout inspected
  (`resources/app`, `resources/worker`, `resources/legacy`).
- **Final-artifact host lifecycle passed 14/14** (`docs/verification/artifacts/installer-lifecycle.json`,
  2026-10-24T17:45:22Z, `installerSha256` = E1A1062C…): silent install 18 s, exe 249,801,728 B,
  uninstaller present, HKCU `SuWen 3.1.0` / FileVersion 3.1.0 / ProductVersion 3.1.0.0 / ProductName
  SuWen, installed app running after 12 s, authenticated named-pipe daemon health version 3.1.0
  `mode=user-background`, daemon survives closing the installed UI (same pid, uptime 13.6 s),
  same-version reinstall 24 s, silent uninstall 11 s, install dir removed, user data preserved,
  registry entry removed.
- **Cross-version upgrade `3.0.0-preview.1 → 3.1.0` passed 8/8**
  (`docs/verification/artifacts/upgrade-path.json`, 2026-10-24T17:46:42Z): old install with registry +
  FileVersion 3.0.0-preview.1, upgrade install, registry/exe become 3.1.0, upgraded app starts with
  daemon health 3.1.0, uninstall, install dir removed. Only this upgrade path exists/was tested.
  Both are **host probes**, not clean-VM runs; environment caveat: the developer shell inherits
  `ELECTRON_RUN_AS_NODE=1`, so probes removed it from the launching shell only — the shipped app is
  not modified (test-environment caveat, not a product defect). **Clean-VM lifecycle remains unverified.**
- Branding scan: **983 raw hits in 143 files, 0 requiring change**; all retained hits documented
  legacy-compat data paths/fields (`docs/research/branding-exceptions.md`); no old brand in UI titles,
  installer display name, appId `org.suwen.desktop`, package `suwen-desktop` or shortcuts.
- Legacy data: `import.inspect` read-only scan of the real `C:\Users\Qingyuan Zhuang\.omicslab`
  reports **9 importable item groups**; `import.apply` backs up first and is idempotent;
  `import.rollback` verified by 5/5 unit tests. The user's real legacy data was **not modified**.

### Still unproven / PENDING (do not claim as passed)

1. Short-window chaos artifact: **12/12 checks passed in 52.2 s**
   (`docs/verification/chaos-results.json`, finished 2026-10-24T17:34:35.821Z, `result: passed`) —
   s1 python-worker SIGKILL retry (attempts 2, 15,173 ms, 1 artifact); s2 daemon SIGKILL mid-python
   restored (attempts 2, same operationId, 1 artifact, 26,508 ms); s3 committed steps not replayed;
   s4 cancel → 0 artifacts; s5 provider 429→500→200 with 2 human approvals. **No 8/24/72-hour,
   reboot, sleep/hibernate, power-loss or disk-full run was performed**, and provider faults are
   injected by a local fixture, not a real vendor.
2. Clean-Windows-VM install/start/upgrade/uninstall lifecycle: **not run**. The final-artifact
   host probe passed 14/14 and the cross-version upgrade 8/8 (see the verified section above), but a
   clean machine without Node/Python/prior SuWen data is still PENDING_LEAD.
3. GitHub Actions execution of `.github/workflows/suwen-windows.yml` (never run). `SHA256SUMS`
   is now generated: `desktop/release/SHA256SUMS` and `docs/release/SHA256SUMS.txt`.
4. Code signing / SmartScreen trust — BLOCKED_EXTERNAL (no certificate).
5. Real external model accounts — protocols verified only against local HTTP fixtures.
6. Paper2Agent/Biomni/ERA/Robin/Kosmos external integrations, 23 legacy skills in the new registry,
   workspaces/SSH/terminal/kernel/trajectories, model routing — NOT_STARTED.
7. OS-level CPU/memory/disk quotas and remote/Temporal workers not implemented.

Status vocabulary and requirement-level mapping: `docs/requirements/master-requirements.csv`
(current: 60 IMPLEMENTED_PASS / 8 UNVERIFIED / 3 NOT_STARTED over 71 rows). Nothing in this section
changes the rule that only an `IMPLEMENTED_PASS` row with TARGET evidence counts as complete.
