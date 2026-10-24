# Performance baseline — SuWen Desktop vNext (round 3)

Status: **measured on this host** (real compiled daemon + real Python research worker). Numbers are
single-machine measurements, not a long-term stability claim.

- Script: `desktop/scripts/performance-baseline.mjs` (new in round 3)
- Raw artefact: `docs/verification/artifacts/performance-baseline.json`
- Command: `cd desktop && node scripts/performance-baseline.mjs --out ../docs/verification/artifacts/performance-baseline.json`
- Run timestamp: 2026-10-24T18:09:30Z (Asia/Shanghai 2026-10-25 02:09)
- Dist built at that moment by the round-3 working tree (post-round-2 `npm run build`, `dist/src/daemon.js` present)

## 1. Environment

| Field | Value |
| --- | --- |
| OS | Windows 11 10.0.26200 (win32) |
| CPU | Intel Core i7-14700HX, 28 logical CPUs |
| RAM | 34,124,718,080 B (~34.1 GB) |
| Node (harness host) | v24.14.0 |
| Electron runtime | not measured in this script (Electron 45.0.0 packaged) |
| Python | 3.11.9 (`D:\Develop\python\python.exe`) via `python` on PATH |
| Daemon dist | `desktop/dist/src/daemon.js` |
| Python worker | `desktop/worker/research_worker.py` v2.0.0, protocol `suwen-research-worker/2` |

## 2. Daemon start-to-ready (authenticated named pipe, `health` answered)

| Metric | Samples | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| cold start (first run after fresh temp home/daemon) | 3 | **391.4 ms** | 401.1 ms | 401.1 ms |
| warm start (second/third identical runs) | 2 | **374.1 ms** | 389.9 ms | 389.9 ms |

Measurement = spawn detached daemon (`ELECTRON_RUN_AS_NODE=1`, temp `--home`) → wait for
`connection.json` → authenticated `health` RPC. Includes process start, SQLite open/migration path
and pipe setup.

## 3. RPC burst: 60 durable tasks + event/stream reads

| Metric | Samples | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `create` (durable task commit) | 60 | **0.82 ms** | 1.30 ms | 2.14 ms |
| `events.stream` (incremental) | 10 | **1.49 ms** | 3.66 ms | 3.66 ms |
| `snapshot` (last 100 tasks) | 1 | 6.38 ms | — | — |

Batch content: `events.stream` returned 90 events / 26,467 bytes at cursor granularity used by the
main process. After the burst: `harness.sqlite` main file 4,096 B; **WAL 3,271,312 B**; SHM 32,768 B —
i.e. writes are in WAL (expected with `journal_mode=WAL`), checkpointing not forced by the benchmark.
Daemon RSS: **79,872 KB** (~78 MB) at the end of the burst.

## 4. Python research worker (real FCS analysis)

| Metric | Value |
| --- | --- |
| `health` round trip (process warm) | 523.0 ms |
| `describe` round trip | 1.94 ms |
| `flowSummary` on `omicslab/data/demo.fcs` (120,811 B, 6,000 events, 5 channels) | **20.9 ms**, `ok=true` |
| channels | FSC-A, SSC-A, FL1-A, FL2-A, FL3-A |

The worker sandbox (temp home, env allowlist, timeouts, output caps) is active for script runs; this
benchmark exercises read-only analysis operations.

## 5. Interpretation

- Daemon ready in ~0.4 s and durable `create` committed in <1 ms at this scale (60 tasks) supports the
  UI auto-refresh design (`events.stream` poll at ~100 ms) without backpressure on this host.
- `events.stream` payload is small at 90 events; longer sessions were **not** profiled here (T2
  streaming matrix owns 100/1,000/10,000-event measurements).
- Worker analysis of a 6,000-event FCS file is ~21 ms; larger datasets and real scientific stacks are
  out of scope for this baseline.
- No 8/24/72 h endurance, no UI main-thread/long-task, no markdown render CPU, no first-token latency
  against a real vendor provider was measured. Those stay **NOT_VERIFIED** / TBD elsewhere.

## 6. Not measured (must not be claimed)

1. Electron UI cold/warm launch, first-interactive, frame rate (owned by T2 visual/streaming audit).
2. Markdown rendering CPU for 10,000 deltas.
3. First-token latency against a real provider account (only local HTTP fixtures exist).
4. Multi-agent concurrency cost, sequential provider rate-limit behaviour.
5. 8/24/72-hour endurance, daemon long-run resource drift, WAL growth over hours.
6. Python worker CPU/memory for real single-cell/flow datasets beyond the 6,000-event demo file.

## 7. Reproduce

```powershell
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
npm run build
node scripts/performance-baseline.mjs --out ../docs/verification/artifacts/performance-baseline.json
```

The script creates temp homes under `%TEMP%`, never touches user data, and kills the daemons/workers it
starts. It exits 0 on success and 2 on a measurement error.
