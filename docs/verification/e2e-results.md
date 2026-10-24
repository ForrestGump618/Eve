# Research E2E verification — real daemon RPC, real Python worker, deterministic fixture model

- Date (UTC): 2026-10-24 (final deterministic run 18:37:23Z; live-gated run 18:37:34Z)
- Scope: headless daemon RPC surface of SuWen Desktop vNext (`dist/src/daemon.js`), the real
  `worker/research_worker.py` process, and the real record store. The Electron UI is out of scope.
- Daemon version: 3.2.0 · Node v24.14.0 · win32 x64 (Windows 10.0.26200) · Python 3.11.9 (`python` on PATH,
  worker protocol `suwen-research-worker/2`, worker version 2.0.0).
- Model: **deterministic local OpenAI-compatible SSE fixture model** served from `127.0.0.1`
  (`provider=openai`, `model=suwen-e2e-fixture`, fake key). **No vendor API and no real API key are used.**
- Runner: `desktop/scripts/e2e-research.mjs` (single self-contained file; fixtures in
  `desktop/scripts/fixtures/research-e2e/`).

## Exact commands

```powershell
cd "C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop"
npm run build                      # tsc && node scripts/copy-assets.mjs  (exit 0 on the verified build)
node scripts/e2e-research.mjs      # deterministic suite; exits non-zero if any deterministic case fails
node scripts/e2e-research.mjs --live   # also runs the live public-database checks (SUWEN_E2E_LIVE=1 == --live)
```

Optional flags: `--dist <dir>` (build directory, default `dist`), `--keep` (keep temp `--home`, legacy home,
datasets and print their paths), `--out <dir>` (report root, default `release/e2e-research`).

The script spawns the real daemon exactly like `scripts/e2e-rpc.mjs`:

```
node <desktop>/dist/src/daemon.js --home <temp home> --worker <desktop>/worker/research_worker.py
  env: ELECTRON_RUN_AS_NODE=1, SUWEN_LEGACY_HOME=<temp legacy home>
```

It reads `<temp home>/connection.json` (`{pipe, token}`), connects to the named pipe, and exchanges
one-line JSON requests `{token, method, params}` → one line `{result}` or `{error}` (no request ids).
The fixture model, the Telegram Bot API stub and the webhook stub are served by one local
`node:http` server on `127.0.0.1:<ephemeral port>`. Child processes, the temp home, legacy home and
datasets are cleaned up in `finally` unless `--keep` is passed. Reports/artifacts are kept.

## Results

| Run | Cases | PASS | FAIL | SKIP | Deterministic failures | Exit |
|---|---|---|---|---|---|---|
| deterministic | 22 | 19 | 0 | 3 | 0 | 0 |
| with `--live` | 21 | 21 | 0 | 0 | 0 | 0 |

Reports (JSON + daemon stdout/stderr + fixture model call log):

- deterministic: `desktop/release/e2e-research/2026-10-24T18-37-23-560Z/` (`report.json`, `daemon.log`,
  `model-calls.jsonl`; 71 fixture-model calls, duration 10.8 s)
- live: `desktop/release/e2e-research/2026-10-24T18-37-34-807Z/` (`report.json`, `daemon.log`,
  `model-calls.jsonl`; 73 fixture-model calls, duration 13.7 s)

The three deterministic SKIPs are the live-gated database cases; they are not failures and do not affect
the exit code. Every deterministic case runs against the real daemon/store/worker; only the model and
network peers are local fixtures.

### Per-case results (deterministic run, 2026-10-24T18-37-23-560Z)

| # | Case | Status | Evidence (see `cases[].evidence` in `report.json`) |
|---|---|---|---|
| 1 | `boot` — daemon health, doctor, research worker handshake | PASS | daemon v3.2.0 pid=628, `mode=user-background`, `ready=true`; doctor 11 checks (`daemon`/`store`/`python`/`researchWorker`/`home` pass, model/mcp/skills/channels/artifacts/migration warn before setup); worker `status=ok`, python 3.11.9, protocol `suwen-research-worker/2`, ops health/describe/flowSummary/datasetProfile/discoveryScan/runScript |
| 2 | `gate-model` — research capabilities fail closed before a model is configured | PASS | `research.knowledge` and `research.hypothesis` both rejected with the localized model-required error `请先配置并解锁模型；离线后台演示和数据库检索无需模型。` (no task created) |
| 3 | `configure-model` — configure the deterministic local fixture model | PASS | `configure {provider:'openai',baseUrl:'http://127.0.0.1:<port>/v1',model:'suwen-e2e-fixture',apiKey:…,contextWindow:32768,maxOutput:4096}` → `{ok:true,…}`; `health.configured=true`; doctor `model=pass` |
| 4 | `project` — project + empty research graph baseline | PASS | `project.create` → id; `research.graph {projectId}` → `{graph:null,recordId:null,records:[]}` |
| 5 | `knowledge-live` — real public-database knowledge flow | SKIP | live-gated (see live run below) |
| 6 | `hypothesis` — generate/critique/rank + human selection | PASS | 2 hypothesis records `hyp-633273cc…`, `hyp-bb740f24…` ranked with scores 0.61/0.82, critique persisted; `hypothesis.select {id}` returned `{selected:true}` and exactly one record stayed selected (task `hypothesis-5cde890c4662`) |
| 7 | `debate` — 2-round debate, per-role evidence, referee synthesis | PASS | 7 `note` evidence records with `source=debate`, titles `Debate round <r> propose|critique|revise (<role>)` and `Debate round 3 synthesize (chair)`; synthesis `structured` has `consensus/disagreements/evidenceGaps/nextSteps`; no record/payload carries a verdict/adjudicator field; task `debate-d869c86df3dc` |
| 8 | `methods` — methods scaffold, license/test metadata, skill lifecycle | PASS | task `methods-cc9ba31abce1`; scaffolded skill `skill-e2eMethodmvmqqz5x-d2291466` with `license=MIT`, `entry=entry.py`, `test.status:not_run`; `methods_test` step passed; RPC `skill.test` → `passed` (`exit=0`); `disable`/`enable`/`remove` reflected in `skill.list` |
| 9 | `research-worker` — worker passthrough for real data | PASS | `create {kind:'research'}` steps: `datasetProfile {path:<data.csv>}` → 6 rows / 4 columns profile; `flowSummary {path:…/omicslab/data/demo.fcs}` → FCS 3.1, 6000 events, 5 channels, spillover matrix + Otsu populations |
| 10 | `runScript-sandbox` — sandboxed runScript via the research activity | PASS | `create {kind:'research'}` op `runScript` python `exit=0`, stdout read the injected `input.txt`; sandbox `run-<id>` created under `<home>/sandbox` |
| 11 | `analysis` — analysis profile+run+artifact, train/test leakage | PASS | task `analysis-d18f8548657a`: profile of `data.csv`, run score `0.5` (worker prints `{"metrics":{"score":0.5}}`), `leakageCheck {status:'checked',overlap:false}` (train 4 rows/test 2 rows, distinct files), JSON artifact `5d0edbda…` read back via `artifact.read`; handler rejected identical `trainPath===testPath` (`analysis task input.trainPath and testPath must not be the same file…`) **and** the runtime rejected distinct paths with identical content (`…files have identical content (train/test leakage)`); model verify returned `{pass:true}` |
| 12 | `discovery` — design → approval gate → result import → analyze → feedback | PASS | task `discovery-bc3a6adf7635`; design created experiment `exp-74bc84d0cf77a882b0a1ea04931a268f` (`status=proposed`, `simulated=false`); `experiment.result` before approval rejected (`Experiment must be approved before importing a result (status=proposed)`); `experiment.approve` → `approved`; `experiment.result {value:1.25,units:'fixture-units',simulated:false}` → `completed`, persisted `resultKind=real`; both approval steps (`discovery_approval`, `discovery_import`) confirmed over RPC; verdict evidence `kind=experiment`, `payload.verdict=supported`, citation `experiment:<id>`, `payloadSha256` 64 hex; hypothesis status `supported`; feedback created follow-up hypothesis `origin=discovery-feedback`; `research.graph {taskId}` contains a `discovery-feedback` milestone |
| 13 | `autonomy` — bounded research graph + human approval + execute/verify/update | PASS | task `autonomy-e569fb99c420`: plan 2/8 nodes (kinds `analysis`,`research`; `budget.maxNodes=8`), graph status `planned`; autonomy approval confirmed; 2 rounds of execute/verify/update executed nodes (high-risk kinds required the approval dependency); final graph status `complete`, `worldState.phase=complete`, `verifiedNodes=2`, 2 checkpoint milestones |
| 14 | `mcp` — MCP registry with a real stdio server fixture | PASS | `mcp.add {name,transport:'stdio',command:<node exe>,args:[mcp-server.mjs],readOnly:true}` → server; `mcp.health` → `status=ok` and `tools` contains `e2e_ping` (readOnlyHint true); `mcp.tools` refresh returns the input schema; `mcp.remove` removes it |
| 15 | `skill-install` — local SKILL directory lifecycle | PASS | `skill.inspect` allowed, `skill.install {confirm:true}` → `e2e-fixture-skill-a00173b7f4e0` (MIT, `test.status:not_run`); invalid directory (SKILL.md without manifest) rejected by the static scan; no record created |
| 16 | `skill-test` — declared SKILL test in the worker sandbox | PASS | `skill.test` → `passed`, `detail=exit=0 …`, worker result contains sandbox path, input file hashes and versions python 3.11.9 |
| 17 | `channels` — Telegram + webhook: secrets, health, send, inbox, read-only guard | PASS | `secrets.set {refs:{'e2e-telegram-bot':…}}`; telegram `channel.save {readOnly:false,config:{botRef,chatId:'1',baseUrl:<fixture>}}`; `channel.test` → `ok`, `detail='bot @suwen_e2e_fixture_bot'` after the fixture served `GET /bot<token>/getMe`; `channel.send` → `message_id=42` after `POST /bot<token>/sendMessage` (chat_id `1` asserted); `channel.inbox` contains the outbound message; a default `readOnly:true` channel rejects send (`… is read-only; save it with readOnly:false before sending`); webhook channel health `ok` and send `message_id=wh-msg-1` |
| 18 | `rsi` — RSI benchmark, review, promote, rollback | PASS | `rsi.run {kind:'routing'}` → run `82d67370-e4b8-4d8b-bb3f-18d68f101b7c`, baseline+candidates evaluated on the same 8 seeded eval cases, `status=review`, 6 candidates with metrics/regressions, chosen candidate; `rsi.review {decision:'approve'}` → `canary`; `rsi.promote {confirm:true}` → `promoted`, active strategy id superseded with version+1; `rsi.rollback` → `rolled_back`, baseline strategy restored as active |
| 19 | `cancel` — durable task cancellation | PASS | `delay` task `db940ebb-c180-4cfc-b712-b61740ce0f73`, `control {action:'cancel'}` → `status=cancelled`; `snapshot` artifacts=0 and `evidence.list {taskId}` empty |
| 20 | `import` — legacy home inspect/apply/rollback with secret exclusion | PASS | `import.inspect` saw the synthetic legacy home (conversations 1, settings 1, memory 1, `excluded` count 1 = `auth.json`) and warned `settings.json contains 1 secret-named key(s) that will NOT be imported: api_key`; `import.apply {kinds:['conversations','settings']}` → job `import-2da9ab25…`, `status=completed`, counts `{imported:2,skipped:0,failed:0,filesCopied:2}`, backup dir with `manifest.json` and the raw conversation copy (no `auth.json`); `conversation.get` returned the imported record with `legacy.sourcePath/sourceSha256/backupPath/jobId`; the sentinel secret string is absent from the whole store home outside the by-design migration backup; `import.rollback` removed 2 records, job `rolled_back`, backup kept; `conversation.get` then fails |
| 21 | `live-knowledge` — real PubMed/Europe PMC knowledge flow | SKIP | live-gated |
| 22 | `live-uniprot` — real UniProt query | SKIP | live-gated |

Earlier runs of this same harness failed in `methods`, `analysis`, `discovery`, `autonomy`, `skill-install`
and `rsi`; all of those pass on the final build after the Lead fixes listed in the defect register below.

## Live-gated results (executed once, 2026-10-24T18:37:34Z–18:37:47Z UTC)

`node scripts/e2e-research.mjs --live` → 21/21 PASS (0 skip, 0 fail), report
`desktop/release/e2e-research/2026-10-24T18-37-34-807Z/report.json`.

- `live-knowledge` — `research.knowledge {question:'CRISPR base editing off-target effects in human cells',
  databases:['pubmed'], limit:3}` → task `knowledge-5261827de52a` completed; 3 literature evidence records
  (`source=pubmed`, `payloadSha256` 64-hex, citation, payload, ISO `retrievedAt=2026-10-24T18:37:45.841Z`),
  1 model artifact. Real records returned:
  - “Precision Genome Engineering in Human Disease: Expanding Therapeutic Roles of CRISPR Technologies.” —
    https://pubmed.ncbi.nlm.nih.gov/42756827/
  - “Clustered Regularly Interspaced Short Palindromic Repeats (CRISPR)-Based Genome Editing in Inherited
    Cardiovascular Diseases…” — https://europepmc.org/article/PMC/PMC13654590
  - “CRISPR-Cas9 in Cancer Therapy: Overcoming Delivery Barriers and Off-Target Effects for Clinical
    Translation.” — https://pubmed.ncbi.nlm.nih.gov/42798792/

  The `knowledge_extract` model step is produced by the local fixture model (it cites the real live
  `sourceIds`); it is a transport/plumbing assertion, not a scientific digest.
- `live-uniprot` — direct `create {kind:'uniprot', input:{query:'TP53'}}` through the bundled database MCP
  server → task `4fecc0c5-bd6d-42af-a9dc-36064e850a6a` completed; output 862 chars, UniProt release
  `2026_03`, retrievedAt 2026-10-24T18:37:47.413Z, 3 results including `P04637` / `P53_HUMAN`
  (Cellular tumor antigen p53), 1 artifact.

## Defects found by this harness (all fixed by Lead, all re-verified here)

The deterministic suite was first run on the pre-fix build on 2026-10-24 and failed 5 areas; two further
gaps surfaced while fixing them. Each entry below is preserved in `report.json → defectRegister` with the
pre-fix error string, a reproduction and the post-fix case status (`fixed:true` on the final build).

| ID | Defect | Pre-fix repro / error | Fix (src, Lead) | Post-fix evidence |
|---|---|---|---|---|
| D1 | `activities/research.ts` `executeScript` and `domain/tools.ts` `SkillRegistry.test` called `worker.runScript` without `sandboxRoot` (only the `python` activity supplied it) | `research.methods {name}` → `methods_test` failed `err="'sandboxRoot' must be a non-empty absolute path string"`; same for `skill.test` and `analysis_run` | inject `sandboxRoot=<daemon home>/sandbox` in both call sites | `methods`, `analysis`, `skill-test`, `runScript-sandbox`, `autonomy` all PASS |
| D2 | `analysis_profile` sent `{datasetPath}` to the worker, which requires `path` | `research.analysis {datasetPath}` → `analysis_profile` failed `"'path' must be a non-empty absolute path string"` | send `{path: datasetPath}`; a source-only profile now fails fast with `analysis profile requires datasetPath…` (asserted as a `failed` task in the analysis case) | `analysis` PASS incl. explicit source-only rejection |
| D3 | `hypothesis.select` persisted only `selected:true`, never `status:'selected'`, so `ranked → testing` was rejected by the transition table and `research.discovery` could never start | after `hypothesis.select` → `research.discovery {design:{simulated:false}}` → `discovery_design` failed `hypothesis status transition 'ranked' -> 'testing' is not allowed` | `hypothesis.select` also persists `status:'selected'` | `hypothesis`, `discovery` PASS |
| D4 | `daemon.ts` built `createToolServices` without a runner, while `RsiEngine.evaluate` throws when no runner is injected | `rsi.run {kind:'routing'}` → error `rsi evaluation requires an injected runner`; side effects: active baseline strategy + draft run + seeded eval cases persisted | daemon injects a real bounded runner (one fixture/vendor model call per eval case, JSON answer compared with the persisted eval-case expectation, cost=tokens*1e-6) | `rsi` PASS: run reaches `review`, promote/rollback work |
| D5 | `conversations.ts` `normalizeConversation` dropped `legacy`, so import provenance was unreadable over RPC | after `import.apply`, `conversation.get` returned `legacy:null` | view now returns the imported `legacy` block unchanged | `import` PASS (`legacy.sourcePath/sourceSha256/backupPath/jobId`) |
| D6 | `runMethodsScaffold` persisted only `tests:['test_sample.py']`; `SkillRegistry.test` reads `manifest.test{language,script}` → every methods-scaffolded skill declared no test command | `research.methods` → `skill.test {id:'skill-e2eMethod…'}` → `Skill … declares no test command` | manifest also persists `test:{language:'python',script:'test_sample.py',timeoutMs:120000}` | `methods` PASS (`skill.test` → `passed`, `exit=0`) |
| D7 | The methods-scaffolded skill record stored `dir` but no `installedPath`; `SkillRegistry.installedPath()` fell back to `<home>/skills/<recordId>` while the activity writes `<home>/skills/<name>-<sha8>` | `skill.test {id}` → `ENOENT: no such file or directory, scandir '<home>/skills/skill-e2eMethod…'` | record persists `installedPath: dir` (same value) and `installedPath()` enforces containment inside the managed skills root | `methods` PASS: RPC `skill.test`/`enable`/`disable`/`remove` all work on the scaffolded skill |

## Requirements coverage (task coverage list)

1. **Knowledge research** — model gate (PASS), handler-level rejection without model (PASS), full flow via
   real PubMed/Europe PMC in the live run (PASS, 3 findings with citations/payloadSha256/artifact).
2. **Hypothesis** — generate/critique/rank records (dedupe keys, scores, critiques) + human selection with
   exclusivity (PASS).
3. **Debate** — 2 rounds × (propose/critique/revise) + chair synthesis; per-role/round evidence records;
   structured referee fields; no unconditional verdict persisted (PASS).
4. **Methods** — scaffold with license/source/test status `not_run`, `methods_test` → passed, RPC
   `skill.test` → passed with worker evidence, disable/enable/remove (PASS).
5. **Analysis** — temp train/test CSV + worker `datasetProfile`, `runScript` metric `score=0.5`, artifact
   sha256 + `artifact.read`; train/test overlap rejected at handler level (same path) **and** at runtime
   (identical content, distinct paths) (PASS).
6. **Discovery** — `discovery_design` → approval gate → `experiment.approve` → `experiment.result`
   (simulated:false, value) → analyze evidence → feedback hypotheses updating `researchGraph` (PASS).
7. **Autonomy** — plan ≤8 nodes, approve high-risk nodes, execute/verify/update rounds,
   `research.graph` exposes worldState/milestones/nodes/status (PASS).
8. **Tools** — local stdio MCP fixture add/health/tools/remove; local SKILL fixture install/test and
   invalid-directory rejection (PASS).
9. **Channels** — Telegram config `{botRef,chatId:'1'}` + `secrets.set` + health against a local Bot API
   stub (path `/bot<token>/getMe` asserted), send (`sendMessage`, message_id 42), inbox, read-only guard;
   webhook health/send (PASS).
10. **RSI** — baseline+candidate metrics on the same eval set, `rsi.run`/`review`/`promote`/`rollback`,
    `rsiRun`/`strategy` records (PASS after D4 fix).
11. **Durable + import** — cancel a running task with no artifacts; `import.inspect/apply/rollback` on a
    synthetic legacy home, secret-named settings keys excluded, backup kept, rollback deletes created
    records (PASS).

## Limitations / disclosure

- The model is a **deterministic local fixture** speaking the OpenAI-compatible SSE protocol; it is not a
  vendor model, no real credentials exist in this run, and model quality/reasoning is not exercised. The
  provider request/stream path, retries, context preparation and JSON-contract validation are exercised.
- The research worker, daemon, store, named-pipe transport, records, artifacts and child-process lifecycle
  are real. Real public databases were contacted **only** in the `--live` run above (2026-10-24).
- No clean VM / fresh-user run: this was executed on the developer workstation with `node_modules` and a
  system Python 3.11 present.
- The legacy workbench UI is out of scope (this machine lacks fastapi for the legacy server); only the
  headless daemon RPC surface is verified.
- Channel fixtures are local HTTP servers shaped like the Telegram Bot API and a generic webhook; no real
  Telegram/Slack/Discord/email delivery is attempted.
- The RSI evaluator injected by the daemon is a real bounded evaluation path using fixture-model calls; it
  is not a vendor benchmark.
- The live `knowledge_extract` digest is generated by the fixture model (it cites the real live
  `sourceIds` but is not a scientific summary).
- Temp homes/datasets are removed after each run; reports are kept under `desktop/release/e2e-research/`.
  Pass `--keep` to inspect the temp home, connection file and sandbox artifacts.

## Fixtures

- `desktop/scripts/fixtures/research-e2e/mcp-server.mjs` — newline-delimited JSON-RPC stdio MCP server:
  `initialize` (`protocolVersion:'2025-03-26'`), `tools/list` (`e2e_ping`, `readOnlyHint:true`), `tools/call`
  returning one text content entry with JSON; unknown methods → `-32601`; notifications ignored.
- `desktop/scripts/fixtures/research-e2e/skill/` — `SKILL.md`, `skill.json` (name `e2e-fixture-skill`, v1.0.0,
  MIT, `test:{language:'python',script:'test_skill.py'}`) and `test_skill.py` printing JSON and exiting 0.
- `desktop/scripts/fixtures/research-e2e/invalid-skill/` — `SKILL.md` only (no manifest) → must be rejected.
- `desktop/scripts/fixtures/research-e2e/analysis-score.py` — reads the sandbox `train.csv`/`test.csv` and
  prints `{"metrics":{"score":0.5},"trainRows":4,"testRows":2}`.
