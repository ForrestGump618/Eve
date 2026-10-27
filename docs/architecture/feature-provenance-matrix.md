# Feature provenance / actual implementation

外部项目 static package resources are not behavior evidence. Unknown means not tested, not absent.

| Area | 外部项目 evidence | 外部项目 sampled capability / gap | SuWen implementation | Validation / limitation |
|---|---|---|---|---|
| UI | Electron main/preload/renderer inventory | isolated renderer, host tied to full quit | desktop/src/main.ts, preload.cts, ui/ | Actual Electron stream/renderer isolation/window-close test; independent original UI |
| Plugins | declared dependencies only; runtime unknown | Cordis lifecycle/disposers | injected harness ActivityHandler; existing Python registries retained | New desktop arbitrary extension importing not implemented |
| MCP | runtime unknown | stdio/HTTP lifecycle | desktop/src/mcp-client.ts + fixed readonly mcp-server.ts | Protocol tests + actual Europe PMC/PubMed and UniProt queries; no third-party server install claim |
| Skills | bundled paths only; runtime unknown | filesystem registry | existing Python SkillRegistry retained | Desktop bridge/Paper2Agent lifecycle pending |
| Research | RDKit/Molstar declarations, not execution | replaceable model/tool loop | databases.ts, fixed optional worker/research_worker.py, existing Python research modules | Actual public query + fixed numeric sample; Biomni/ERA/Robin end-to-end not validated |
| Context | unknown | append-only projection, char estimator | context.ts, context-async.ts, context-worker.ts | 100k+ visible token histories, ten compactions, restart/hash/coverage tests; unknown models explicitly estimated |
| Project memory | unknown | session persistence/projection | echo project-note records + unchanged Python knowledge module | Automatic migration/complete desktop project knowledge bridge pending |
| Durable execution | unknown | default jobs/workflows not durable | harness/store.ts, engine.ts, artifacts.ts | CAS, lease/fence, durable timers, real SIGKILL, uncertain effects approval; no 72h claim |
| Monitoring | unknown | session events/trace | authenticated RPC health + events/checkpoints + diagnostics | Actual UI/daemon PID, uptime, user-background mode; no Windows Service installed |
| Channels | unknown | plugin architecture | existing Python channels preserved | New desktop channel settings not bridged, no messages sent to third parties |
| RSI | unknown | no sampled evidence of full required loop | existing Python discovery preserved; new source changes isolated on Git branch | Full benchmark/review/canary/promote/rollback lifecycle not completed |

No commercial assets or binaries enter the release. No DeepSeek code is vendored in this preview. Third-party technology licenses remain separate.
