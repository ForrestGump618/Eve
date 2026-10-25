"""Round-5 final evidence refresh for SuWen desktop 3.3.0.

Updates docs/requirements, parity, UI coverage, defect register, release docs,
verification docs and README with the measured 3.3.0 evidence. Idempotent.
"""
from __future__ import annotations

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
D = ROOT / 'docs'
INST = '0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03'
BLK = '15EAB7E1C14D36514DC8FB2A8B7BEE655E253D117DFBBAC1F5179EB5BB662ADB'
UNP = '469D75AD64B449B98D5DB8F7D1C64C0F988F8D2F99F6B04CD213A4481A0FA991'
E2E = 'desktop/release/workbench-e2e/20261025-135558/report.json'
E2E_RUN = '20261025-135558'
TITLE = '## Round-5 (3.3.0) supersession - current delivered evidence (2026-10-25)'


def read(p: Path) -> str:
    return p.read_text(encoding='utf-8')


def write(p: Path, text: str) -> None:
    p.write_text(text, encoding='utf-8', newline='')


def insert_after_title(text: str, block: str) -> str:
    if TITLE in text:
        return text
    lines = text.split('\n')
    for i, line in enumerate(lines):
        if line.startswith('# '):
            lines.insert(i + 1, '\n' + block + '\n')
            return '\n'.join(lines)
    return block + '\n\n' + text


def replace_once(text: str, old: str, new: str) -> str:
    return text.replace(old, new, 1)


# ---------------------------------------------------------------- master CSV
p = D / 'requirements/master-requirements.csv'
with p.open(encoding='utf-8-sig', newline='') as fh:
    reader = csv.DictReader(fh)
    header = reader.fieldnames
    rows = list(reader)
by_id = {r['Requirement ID']: r for r in rows}
if 'R152' not in by_id:
    rows.append({
        'Requirement ID': 'R152',
        'Feature': 'Version 3.3.0 release documentation and final evidence refresh (hosted workbench E2E, markdown parity, final installer hashes, packaged smoke/lifecycle).',
        'Priority': 'P0',
        'Source': 'Round-5 release requirements + user m03077',
        'Implementation Module': 'docs/release/**, docs/verification/**, desktop/scripts/e2e/verification scripts',
        'UI Entry': 'n/a (documentation/testing)',
        'IPC/RPC': 'n/a',
        'Backend Handler': 'n/a',
        'Persistence': 'docs/',
        'Test ID': 'node scripts/workbench-ui-e2e.mjs; node scripts/electron-smoke.mjs; pwsh scripts/verify-installer.ps1',
        'Evidence': '3.3.0 final documented artifact 131,011,183 B SHA256 ' + INST + ' (UNSIGNED); lifecycle 12/12 + upgrade; packaged smoke passed; CHANGELOG/release-notes v3.3.0; verify-final-330.py PASS',
        'Status': 'IMPLEMENTED_PASS',
        'Blocker': '',
    })
r100 = by_id['R100']
if INST not in r100['Evidence']:
    r100['Evidence'] = (r100['Evidence'].rstrip() + ' | round-5 final artifact SuWen-Setup-3.3.0-win-x64.exe 131,011,183 B SHA256 ' + INST + '; lifecycle+upgrade 12/12 PASS; packaged smoke passed').strip()
with p.open('w', encoding='utf-8-sig', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=header, lineterminator='\n')
    w.writeheader()
    w.writerows(rows)
print('master csv rows', len(rows))

# ---------------------------------------------------------------- parity csv
p = D / 'migration/feature-parity-matrix.csv'
with p.open(encoding='utf-8-sig', newline='') as fh:
    reader = csv.DictReader(fh)
    ph = reader.fieldnames
    prows = list(reader)
have = {r['capability'] for r in prows}
new_parity = [
    ('legacy_web_workbench_hosted', 'Legacy web app (all navigable views + presentation) hosted in a hardened desktop window', 'HOSTED_LEGACY_PENDING_E2E', 'HOSTED_LEGACY_VERIFIED'),
    ('legacy_web_runtime_bootstrap', 'Managed on-demand Python runtime for the hosted workbench', 'HOSTED_LEGACY_PENDING_E2E', 'HOSTED_LEGACY_VERIFIED'),
    ('legacy_web_config_injection', 'Desktop model/credential config injected into hosted bridge', 'HOSTED_LEGACY_PENDING_E2E', 'HOSTED_LEGACY_VERIFIED'),
]
if 'legacy_web_workbench_hosted' not in have:
    for cap, feature, proto, status in new_parity:
        prows.append({
            'capability': cap,
            'category': 'desktop_shell',
            'python_baseline': feature,
            'python_evidence': 'omicslab/web/** (SPA assets + FastAPI server) preserved in-tree; source checkout under target/omicslab/web',
            'desktop_prototype': 'round-3 legacy compatibility window required local fastapi; no embedded app',
            'prototype_evidence': 'desktop/src/main.ts legacyOpen, desktop/worker/legacy_server.py',
            'vnext_status': 'IMPLEMENTED_PASS',
            'vnext_code': 'desktop/src/workbench.ts, desktop/src/main.ts workbench.*, desktop/ui/workbench page, desktop/scripts/workbench-runtime-smoke.mjs, desktop/scripts/workbench-ui-e2e.mjs, desktop/scripts/workbench-config-e2e.mjs',
            'reuse_mode': 'hosted',
            'data_migration': 'n/a',
            'priority': 'P0',
            'test_id': 'workbench runtime smoke 27/27; hosted Electron E2E 34/34 (' + E2E + '); config injection 13/13',
            'gaps': 'Requires Python 3.10+ and a ~130 MB pinned dependency download; vendor API keys/SSH hosts/channel peers absent on this host; SPA is zh-CN only',
        })
with p.open('w', encoding='utf-8-sig', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=ph, lineterminator='\n')
    w.writeheader()
    w.writerows(prows)
print('parity rows', len(prows))

# ---------------------------------------------------------------- ui coverage
p = D / 'verification/ui-action-coverage.csv'
with p.open(encoding='utf-8-sig', newline='') as fh:
    reader = csv.DictReader(fh)
    uh = reader.fieldnames
    urows = list(reader)
uids = {r['action_id'] for r in urows}
new_ui = [
    ('nav-workbench', 'workbench', 'nav.rail [data-page="workbench"]', 'showPage workbench', 'ui_only', 'n/a', 'WIRED_UI_ONLY',
     'Switches the native shell to the workbench page; loading calls workbench.status through the main bridge.', 'exposed by ui-dom-qa navigation matrix'),
    ('workbench-refresh', 'workbench', '#wb-refresh', 'workbench.status', 'main_process', 'main.ts UI_MAIN_METHODS', 'WIRED_MAIN_PROCESS',
     'Refresh the managed runtime status (marker hash, python version, installed/missing modules).', 'exercised by workbench-ui-e2e.mjs native section'),
    ('workbench-install', 'workbench', '#wb-install', 'workbench.install', 'main_process', 'main.ts UI_MAIN_METHODS', 'WIRED_MAIN_PROCESS',
     'Create or cancel the managed pip dependency install; progress streamed via suwen:workbench events.', 'required for hosted E2E setup; install flow covered by workbench.test.ts with injected runner'),
    ('workbench-open', 'workbench', '#wb-open', 'legacyOpen', 'main_process', 'main.ts legacyOpen -> daemon legacyStart', 'WIRED_MAIN_PROCESS',
     'Open the hosted legacy SPA in an isolated Electron window with per-window bearer auth.', 'hosted E2E: window opens, 12/12 routes navigable, 0 page errors, screenshots'),
]
if 'nav-workbench' not in uids:
    for aid, page, selector, method, kind, declared, status, notes, ev in new_ui:
        urows.append({
            'action_id': aid, 'page': page, 'selector': selector, 'method': method,
            'method_kind': kind, 'contract_declared': declared, 'wired_status': status,
            'evidence': f'desktop/ui/actions.json (148 actions) + contract.ts RPC_METHODS 84 + node scripts/ui-dom-qa.mjs -> 18 passed / 0 failed / 13 warnings; {ev}',
            'notes': notes,
            'runtime_verified': 'yes: hosted Electron E2E ' + E2E_RUN + ' (34/34 checks, 12/12 routes, 0 errors)',
        })
for r in urows:
    r['evidence'] = (r['evidence'].replace('144 actions', '148 actions')
                     .replace('RPC_METHODS 80', 'RPC_METHODS 84')
                     .replace('19 passed / 0 failed / 12 warnings', '18 passed / 0 failed / 13 warnings'))
with p.open('w', encoding='utf-8-sig', newline='') as fh:
    w = csv.DictWriter(fh, fieldnames=uh, lineterminator='\n')
    w.writeheader()
    w.writerows(urows)
print('ui coverage rows', len(urows))

# ---------------------------------------------------------------- defect register
p = D / 'verification/defect-register.csv'
with p.open(encoding='utf-8-sig', newline='') as fh:
    raw = list(csv.reader(fh))
dh = raw[0]
drows = []
for row in raw[1:]:
    if not row:
        continue
    if len(row) > len(dh):
        # repair unquoted commas: fold overflow into the Evidence column
        row = row[:8] + [', '.join(row[8:-1])] + [row[-1]]
    elif len(row) < len(dh):
        row = row + [''] * (len(dh) - len(row))
    drows.append(dict(zip(dh, row)))
dids = {r['Bug ID'] for r in drows}
new_defects = [
    ('D-021', 'P2', 'Hosted legacy SPA opened with the light shell even though legacy defaults to dark.',
     'Hosted shell dark on first run.', 'platform appearance default "system" resolved against the light OS theme.',
     'Seed platform config appearance=dark only when no record exists (legacy_server.py PlatformStore.put config/appearance {"value":{"theme":"dark"}}).',
     'commit round-5 hosted-workbench branch', 'workbench-ui-e2e.mjs theme checks', E2E, 'FIXED'),
    ('D-022', 'P1', 'Mermaid diagrams degraded during hosted E2E: 120 CSP style-src violations in the legacy window.',
     'Mermaid renders SVG with no CSP violations.', "Mermaid sets inline styles; native CSP style-src 'self' blocked them.",
     "Allow style-src 'self' 'unsafe-inline' for the native shell (script-src stays 'self'; connect-src 'none'); hosted bridge sends equivalent exact CSP header.",
     'commit round-5 hosted-workbench branch', 'workbench-ui-e2e.mjs cspViolations=0 + diagram checks', E2E, 'FIXED'),
    ('D-023', 'P3', 'Native footer showed 3.2.0 after the 3.3.0 version bump.',
     'Footer shows 3.3.0.', 'Static version label not bumped with package.json.',
     'Update ui/index.html footer to 3.3.0 (dev preview).', 'commit round-5 hosted-workbench branch',
     'ui-dom-qa.mjs + hosted E2E', E2E, 'FIXED'),
]
if 'D-021' not in dids:
    for did, sev, repro, exp, act, root, fix, reg, ev, status in new_defects:
        drows.append({
            'Bug ID': did, 'Severity': sev, 'Reproduction': repro, 'Expected': exp, 'Actual': act,
            'Root Cause': root, 'Fix Commit': fix, 'Regression Test': reg, 'Evidence': ev, 'Status': status,
        })
import io

_buf = io.StringIO()
_w = csv.DictWriter(_buf, fieldnames=dh, lineterminator='\n')
_w.writeheader()
_w.writerows(drows)
write(p, '\ufeff' + _buf.getvalue())
print('defect rows', len(drows))

# ---------------------------------------------------------------- release notes v3.3.0
notes = f"""# SuWen Desktop 3.3.0 - Legacy workbench in the app + markdown parity

Product version **3.3.0** (2026-10-25). This release is a functional parity release: the
existing SuWen web product is now available *inside* the desktop app, and the markdown
rendering gaps from the earlier prompt are closed.

## Hosted legacy workbench (new native workspace)
- New sixth workspace page **实验工作台 / Workbench** in the desktop shell: shows managed-runtime
  status, installs the pinned Python dependency set on demand (~130 MB, disclosed, cancelable),
  and opens the legacy SuWen web UI in an isolated hardened Electron window.
- The hosted window serves the real legacy SPA (same HTML/CSS/JS, 20 routes / 14 view modules) from
  a loopback bridge with per-window bearer auth, request-time CSP, and no Node/preload exposure to the
  page. Desktop model + credential config is injected into the bridge; nothing is persisted in the
  legacy storage or written to disk.
- On-demand runtime: 13 pinned top-level dependencies, `.suwen-workbench.json` marker bound to
  requirements hash + Python minor version + import probe, atomic marker write, cancel/retry.

## Markdown parity
- Progressive streaming markdown: closed blocks are typeset while the answer streams; an open
  fence/table/math region stays a plain `.md-stream-tail` until closed (never partial typesetting).
- Real offline KaTeX and Mermaid, vendored into the app (no CDN, CSP-compatible), lazy-loaded and
  time-sliced, security level `strict`, labeled fallback on parse failure. Tables, code blocks,
  inline math, diagrams and theme switching are covered by unit and hosted E2E checks.

## Evidence (all measured on this artifact)
- Hosted Electron E2E **34/34 checks**: 12/12 legacy routes navigable, 19 screenshots, dark+light,
  0 page/console errors, 0 CSP violations; report `{E2E}`.
- Bridge runtime smoke **27/27** (`docs/verification/workbench-runtime-smoke.json`), config
  injection **13/13** (`docs/verification/workbench-config-injection.json`), markdown unit tests
  **32/32**.
- Desktop suite **222 tests / 220 pass / 0 fail / 2 skipped** (skips: Windows symlink EPERM and
  optional legacy Python deps); RPC E2E live **42/42**; chaos **12/12**; UI DOM QA
  **18 passed / 0 failed / 13 warnings** (148 actions, 84 contract RPC methods).
- Packaged Electron smoke **passed**, including the hosted legacy SPA (12 nav items, 12 routes).
- Windows lifecycle (final artifact): **12/12 PASS** incl. upgrade from 3.0.0-preview.1;
  `docs/verification/artifacts/installer-lifecycle.json`.

## Artifacts (delivered, UNSIGNED)
| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `desktop/release/SuWen-Setup-3.3.0-win-x64.exe` | **131,011,183** | `{INST}` |
| `desktop/release/SuWen-Setup-3.3.0-win-x64.exe.blockmap` | 137,255 | `{BLK}` |
| `desktop/release/win-unpacked/SuWen.exe` | 249,801,728 | `{UNP}` |

`SHA256SUMS` mirrors in `docs/release/SHA256SUMS.txt`.

## Known limitations (honest)
- Normal `userData/python-env` install flow was exercised via a temp-dir override, not the default
  path end-to-end.
- Real vendor model accounts, SSH hosts and channel peers were not configured, so live provider
  calls and legacy SSH/channel actions remain `BLOCKED_EXTERNAL` / unverified.
- Hidden legacy views' deep actions (files/jobs/registry/memory/ssh/figures) were smoke-verified but
  not exhaustively clicked through.
- SPA is zh-CN only; no accessibility/DPI audit for the hosted window.
- Installer is **UNSIGNED** (no certificate -> SmartScreen warning expected); clean-Windows-VM
  install and 8/24/72 h endurance/reboot/power-loss remain **NOT RUN**.
"""
write(D / 'release/release-notes-v3.3.0.md', notes)

# ---------------------------------------------------------------- CHANGELOG
p = D / 'release/CHANGELOG.md'
t = read(p)
if '## [3.3.0]' not in t:
    section = f"""## [3.3.0] - 2026-10-25

### Added
- Sixth native workspace page **实验工作台 / Workbench** hosting the existing SuWen web SPA in an
  isolated Electron window with a managed on-demand Python runtime (13 pinned deps, marker+probe
  validation, cancelable ~130 MB install, per-window bearer auth, request-time CSP, config injection).
- Progressive streaming markdown with offline KaTeX + Mermaid, closed-block typesetting and a plain
  `.md-stream-tail` for open constructs.
- Requirement rows R149-R152 (hosted parity, managed runtime, config injection, 3.3.0 docs).

### Changed
- Version 3.3.0 (package.json/lock, native footer).
- Native shell CSP `style-src` now allows inline styles required by the vendored math/diagram
  renderers; `script-src` remains `self`, `connect-src` remains `none` (documented trade-off in
  `docs/verification/security-review.md`).

### Verified
- Full suite 222/220/0/2; RPC E2E live 42/42; hosted workbench E2E 34/34; runtime smoke 27/27;
  config injection 13/13; markdown unit 32/32; chaos 12/12; packaged smoke passed; lifecycle 12/12
  incl. 3.0.0-preview.1 upgrade; installer {INST[:16]}... (UNSIGNED).

"""
    t = t.replace('## [Unreleased]', section + '## [Unreleased]', 1)
write(p, t)

# ---------------------------------------------------------------- installer doc
h = (
    TITLE + "\n\n"
    "Current delivered artifact for the **3.3.0** round; the 3.2.0 sections below remain accurate\n"
    "only for that historical build. Measured in TARGET on 2026-10-25.\n\n"
    "| Item | Value |\n|---|---|\n"
    f"| Installer | `desktop/release/SuWen-Setup-3.3.0-win-x64.exe` - **131,011,183 B** - SHA256 `{INST}` - **UNSIGNED** |\n"
    f"| Blockmap | `SuWen-Setup-3.3.0-win-x64.exe.blockmap` - 137,255 B - SHA256 `{BLK}` |\n"
    f"| Unpacked | `desktop/release/win-unpacked/SuWen.exe` - 249,801,728 B - SHA256 `{UNP}` |\n"
    "| Build | `npm run dist:win`, electron 45.0.0 x64, electron-builder 26.18.0, 2026-10-25 13:58 (+08) |\n"
    "| Lifecycle (host) | `scripts/verify-installer.ps1`: **12/12 PASS** incl. silent install/uninstall,\n"
    "  daemon survival, user-data preservation and **upgrade from 3.0.0-preview.1**; evidence\n"
    "  `docs/verification/artifacts/installer-lifecycle.json` (installerBytes=131011183, sha256=`"
    + INST[:16] + "...`) |\n"
    "| Packaged smoke | `SUWEN_SMOKE_PACKAGED=1` + `SUWEN_WORKBENCH_DEPS`: **passed**, includes hosted\n"
    "  legacy SPA (12 nav items, 12 routes); report `desktop/release/smoke/work/electron-e2e-result.json` |\n"
    "| SHA256SUMS | `desktop/release/SHA256SUMS` == `docs/release/SHA256SUMS.txt` (3 lines) |\n"
    "| Clean VM / signing | clean-Windows-VM lifecycle **NOT RUN**; installer **UNSIGNED** - unchanged limitations |\n\n---\n\n"
)
p = D / 'release/windows-installer-verification.md'
write(p, insert_after_title(read(p), h))

# ---------------------------------------------------------------- acceptance report
acc = (
    TITLE + "\n\n"
    "The 3.3.0 round closed the web-parity and markdown gaps; measured evidence:\n\n"
    "- Version **3.3.0**; hosted workbench E2E **34/34** (12/12 routes, 19 screenshots, 0 errors,\n"
    "  0 CSP violations, report `" + E2E + "`), runtime smoke **27/27**, config injection **13/13**,\n"
    "  markdown unit **32/32**, full suite **222 tests / 220 pass / 0 fail / 2 skipped**, RPC E2E live\n"
    "  **42/42**, chaos **12/12** (53.4 s), UI DOM QA **18/0/13** (148 actions, 84 RPC methods).\n"
    "- Packaged smoke **passed** incl. hosted legacy SPA; Windows lifecycle **12/12 PASS** incl.\n"
    "  upgrade from 3.0.0-preview.1 on the final artifact.\n"
    f"- Final installer **131,011,183 B SHA256 `{INST}`** (UNSIGNED); blockmap 137,255 B `{BLK[:16]}...`;\n"
    f"  unpacked 249,801,728 B `{UNP[:16]}...`.\n"
    "- Requirements: **102 rows -> 86 IMPLEMENTED_PASS / 10 UNVERIFIED / 4 NOT_STARTED /\n"
    "  1 BLOCKED_EXTERNAL**; parity 92 rows; UI action coverage 148 rows; defect register 23 rows.\n"
    "- Release decision remains **HOLD**: clean Windows VM, code signing, 8/24/72 h endurance /\n"
    "  reboot / power-loss, real vendor accounts and GitHub Release assets are still NOT verified /\n"
    "  BLOCKED_EXTERNAL.\n\n---\n\n"
).replace('{E2E_REPORT}', E2E)
p = D / 'release/final-acceptance-report.md'
write(p, insert_after_title(read(p), acc))

# ---------------------------------------------------------------- gates
gates = (
    TITLE + "\n\n"
    "Gate status for the **3.3.0** artifact (round-5). Earlier 3.2.0 gate evidence below is historical.\n\n"
    "| Gate | Status | Evidence |\n|---|---|---|\n"
    "| G1 Build | **PASS** | `npm test` 222/220/0/2 exit 0; `tsc --noEmit`/`npm run build` exit 0; CI green on the pushed 3.2.0-era tree (run 40146054329) |\n"
    "| G2 Runtime | **PASS** | RPC E2E `--live` **42/42**; packaged Electron smoke **passed** (incl. hosted SPA); daemon health 3.3.0 |\n"
    "| G3 Streaming/UI stability | **PASS_WITH_LIMITS** | hosted workbench E2E 34/34; native streaming E2E (round-3) 16/16 case types with P1 fixes; markdown progressive unit 32/32; pre-T1 poll-only baseline NOT RUN |\n"
    "| G4 Functional breadth | **PASS_WITH_LIMITS** | live RPC 42/42; web-parity view matrix 12/12 routes; hidden legacy views smoke-only |\n"
    "| G5 Research capabilities | **PASS** | deterministic research E2E 19 PASS/3 SKIP; live 21/21 incl. real Europe PMC/UniProt evidence |\n"
    "| G6 Durability | **PASS_WITH_LIMITS** | chaos 12/12 (53.4 s); accelerated soak 25 min/64 cycles/12 faults recovered; **8/24/72 h + reboot/sleep/power/disk-full NOT RUN** |\n"
    "| G7 Security/compliance | **PASS_WITH_LIMITS** | scanner 0 HIGH / 48 LOW (14 fixtures); npm audit 0; hosted CSP measured 0 violations; no pen-test, unsigned |\n    "
    "| G8 Windows installer | **PASS_WITH_LIMITS** | final 3.3.0 artifact built; host lifecycle 12/12 incl. upgrade; packaged smoke passed; clean-VM install NOT RUN; UNSIGNED |\n"
    "| G9 GitHub publication | **BLOCKED_EXTERNAL** | source branch/tag pushable via SSH; CI executes; Release assets require `gh`/token (absent) and gates are HOLD |\n\n"
    "**Release decision: HOLD (not published).**\n\n---\n\n"
)
p = D / 'release/release-gates.md'
write(p, insert_after_title(read(p), gates))

# ---------------------------------------------------------------- integration e2e
integ = (
    TITLE + "\n\n"
    "All commands executed in TARGET on 2026-10-25 for the 3.3.0 artifact.\n\n"
    "| Check | Command | Result |\n|---|---|---|\n"
    "| Desktop suite | `npm test` | **222 tests / 220 pass / 0 fail / 2 skipped**, 83.7 s, exit 0 |\n"
    "| RPC E2E live | `node scripts/e2e-rpc.mjs --dist dist --live` | **42 passed / 0 failed** |\n"
    "| Hosted workbench E2E | `node scripts/workbench-ui-e2e.mjs` (real Electron, real Python bridge) | **34/34 checks, 12/12 routes, 0 errors, 0 CSP violations**, report `" + E2E + "` |\n"
    "| Runtime smoke | `node scripts/workbench-runtime-smoke.mjs --deps %TEMP%\\suwen-workbench-smoke` | **27/27 PASS** -> `docs/verification/workbench-runtime-smoke.json` |\n"
    "| Config injection | `node scripts/workbench-config-e2e.mjs` | **13/13 PASS** -> `docs/verification/workbench-config-injection.json` |\n"
    "| Markdown unit | `node --test dist/test/markdown.test.js` | **32/32 pass** |\n"
    "| Chaos | `node scripts/chaos-smoke.mjs` | **12/12 checks**, 53.4 s, exit 0 |\n"
    "| UI DOM QA | `node scripts/ui-dom-qa.mjs` | **18 passed / 0 failed / 13 warnings**, 148 actions, 84 RPC methods |\n"
    "| Packaged smoke | `SUWEN_SMOKE_PACKAGED=1 SUWEN_WORKBENCH_DEPS=... node scripts/electron-smoke.mjs` | **passed** incl. hosted SPA (12 nav items, 12 routes) |\n"
    "| Lifecycle | `pwsh scripts/verify-installer.ps1 -Installer release\\SuWen-Setup-3.3.0-win-x64.exe -Version 3.3.0 -UpgradeFrom <3.0.0-preview.1>` | **12/12 PASS** incl. upgrade |\n\n"
    "Limitations: real vendor accounts absent; hidden legacy views smoke-only; clean VM, signing,\n"
    "8/24/72 h endurance/reboot/power/disk-full NOT RUN; installer UNSIGNED.\n\n---\n\n"
)
p = D / 'verification/integration-and-e2e.md'
write(p, insert_after_title(read(p), integ))

# ---------------------------------------------------------------- publication doc
pub = (
    TITLE + "\n\n"
    "Source publication unchanged (branch `suwen-vnext-durable`, annotated tag per release); CI executes\n"
    "on GitHub. **No Release asset is published.** The 3.3.0 installer is a local, unsigned artifact:\n"
    f"`desktop/release/SuWen-Setup-3.3.0-win-x64.exe` 131,011,183 B SHA256 `{INST}`. Publishing a Stable\n"
    "Release remains blocked by gates HOLD (clean VM, signing, endurance) and by the absence of\n"
    "`gh`/`GITHUB_TOKEN` on this host.\n\n---\n\n"
)
p = D / 'release/github-publication.md'
write(p, insert_after_title(read(p), pub))

# ---------------------------------------------------------------- README
p = ROOT / 'README.md'
t = read(p)
if '## 实验工作台' not in t:
    section = (
        "## 实验工作台与 Markdown（3.3.0）\n\n"
        "- **实验工作台**：第六个原生工作区页面。按需安装固定版本的 Python 运行时（约 130 MB，可取消），\n"
        "  随后在隔离的 Electron 窗口中托管**现有素问网页版**（同一套 HTML/CSS/JS，12 个可导航路由），\n"
        "  桌面端模型/凭据配置会注入托管桥接；页面本身不获得 Node/preload 能力。\n"
        "- **Markdown 补齐**：流式过程中逐步排版已闭合内容（表格/代码块/公式/图表），未闭合区域保持纯文本尾部；\n"
        "  离线内置 KaTeX 与 Mermaid，失败时降级为标注代码块，不阻塞主线程。\n"
        "- 注意：安装包未签名；干净 Windows 虚拟机安装、8/24/72 小时耐久与重启/断电测试**未执行**；\n"
        "  真实厂商模型账号/SSH/消息渠道未配置。\n\n"
    )
    t = t.replace('## 测试与验证 / Testing and verification', section + '## 测试与验证 / Testing and verification', 1)
write(p, t)

print('round-5 final docs patched')
