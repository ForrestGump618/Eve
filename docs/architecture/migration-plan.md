# Migration and acceptance plan

Rollback baseline: Git tag `suwen-vnext-baseline-20261024` at `8cabac3`; implementation branch `suwen-vnext-durable`. Source was clean before work. Existing ignored `.omicslab` runtime/user files are neither read nor committed. No destructive migration.

The current project is Python, not Electron. Add an MIT-licensed `desktop/` Electron+TypeScript client and independent authenticated daemon as a compatibility layer. Preserve Python import namespace and console alias as explicitly documented compatibility exceptions. Preserve the existing Apache-2.0 license and notices; newly authored desktop code can carry its own MIT license without relicensing existing code.

| Stage | Implementation | Acceptance/evidence |
|---|---|---|
| 0 Audit | Source, installer identity, upstream code, baseline tests | current.md and research reports; 121 pass / 1 pre-existing job snapshot race |
| 1 Runtime | SQLite state/event/checkpoint transactions, leases/fencing, DAG, control and recovery | Unit/integration tests and killed-process recovery |
| 2 Context | Token accounting, immutable archive, structured versioned summaries and coverage checks | 100k+ tokens, ten compactions, restart, facts/source/hash checks |
| 3 Desktop | Five workspaces, chat, task trace, settings/diagnostics, optional Python | Build and real smoke test; background progress after UI exits |
| 4 Research/extensions | Preserve existing Python functionality; adapters and public API tests | Real endpoints separately labeled; no paid API success claims |
| 5 Release | NSIS x64, lockfile, notices/SBOM, checksums and clean install tests | Report actual artifacts; VM installation/72h tests remain pending until executed |

Data: new runtime uses a new user-writable SuWen data directory. Legacy JSON, DB schemas, config keys and identifiers remain compatible; no history replacement. Credentials use OS encryption with no plaintext persistence. Legacy data import must be a separate explicit non-destructive import with backup; no silent migration.

Pause/restart semantics must be explicit: a machine asleep or powered off performs no computation. User-level detached process is not a Windows Service; login recovery is optional, never claimed as installed automatically. Unknown external side effects wait for reconciliation, rather than blind retry.
