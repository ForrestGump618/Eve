# 外部项目 Desktop reverse-engineering note

Target: `外部项目-Desktop-0.1.0-beta.27.8-x64.exe`.

## Evidence

- Installer is an NSIS PE executable, x86 header, SHA-256 `803d768437502b2762e1c85ad0c4a763715b6050b11874635ebee12ff3316c2f`.
- The installer contains an Electron application and `resources/app.asar`. The ASAR SHA-256 is `81dcd8b6e328bc9c29b7e72a492cb6afd54b17efb2a4e90626cfc1c93f3448c8`.
- REA static application evidence: `ev_0ae5cff7523d0b4c2f4478b95e4dae5eab132bc9e4290fc2f2be30ddef79382d` (parent analysis `ev_4244a4bfd2c34c7f72f3ad57d5dd7c5ca491a667310c32103e055d0cd5fc2288`).

## Confirmed from the shipped artifact

- Electron graph reports one BrowserWindow, seven explicit WebPreferences, two contextBridge APIs, 148 literal IPC channels, 12 main-process handlers, 30 renderer listeners and 124 renderer transmissions.
- The ASAR includes `out/renderer`, a PDF worker, a UI bundle, a Mol* vendor bundle, Playwright MCP resources, and `resources/science` and `resources/runtime` directories. These names establish packaged capability areas, not successful runtime execution.
- Static analysis recovered request, filesystem, event, timer, child-process and IPC candidates. It did not execute 外部项目 or prove that each route is reachable.

## Relevant capability comparison

| Area | 外部项目 evidence | Eve status | Gap/action |
|---|---|---|---|
| Literature reproduction | science/runtime resource areas; exact workflow unknown | PubMed/Europe PMC search, evidence gates, research quests, new `literature-reproduction` skill | Add paper claim matrix and reproducibility checkpoint UI |
| Primer/vector planning | no confirmed specialized feature from the shipped graph | `primer-design` and `vector-design` skills added | Sequence database and specificity tools remain provider-dependent |
| Multi-omics | science bundle is present; modality behavior unknown | bulk/single-cell/spatial skills and new `multiomics-integration` skill | Add modality inventory and cross-run provenance view |
| Figures | renderer and image/science assets present | gallery, vision review, new canvas annotation persistence | Annotation is stored as guidance; it does not mutate the source figure |
| Tool/data integrations | 148 IPC candidates and Playwright MCP resources | web, PubMed/UniProt, MCP discovery/call, skills, local/SSH files and PTY | 外部项目 endpoint semantics require runtime observation |

## Unknowns and limits

REA reports partial semantic coverage due to resource/heap limits, including `ui-D5H5l1tZ.js`, `molstar.js` and the PDF worker. Dynamic channels and runtime registration remain unknown. No claim here says 外部项目 successfully completes a research, primer or multi-omics task. A controlled runtime observation is needed before claiming behavior.
