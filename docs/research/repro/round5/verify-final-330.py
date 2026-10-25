"""Machine verification of the SuWen Desktop 3.3.0 round-5 evidence bundle.

Read-only checks over committed docs + measured artifacts. Run with:
  python -X utf8 docs/research/repro/round5/verify-final-330.py
Exit code 0 only when every check passes.
"""
from __future__ import annotations

import csv
import hashlib
import json
import os
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
DOCS = ROOT / 'docs'
INST_SHA = '0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03'
BLK_SHA = '15EAB7E1C14D36514DC8FB2A8B7BEE655E253D117DFBBAC1F5179EB5BB662ADB'
UNP_SHA = '469D75AD64B449B98D5DB8F7D1C64C0F988F8D2F99F6B04CD213A4481A0FA991'
INST_BYTES = 131011183
failures: list[str] = []
checks = 0


def check(cond, msg: str) -> None:
    global checks
    checks += 1
    if not cond:
        failures.append(msg)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest().upper()


def load_json(rel: str):
    return json.loads((ROOT / rel).read_text(encoding='utf-8'))


# ---------------------------------------------------------------- version
pkg = load_json('desktop/package.json')
check(pkg['version'] == '3.3.0', 'package.json version is %s' % pkg['version'])
check('3.3.0' in (ROOT / 'desktop/ui/index.html').read_text(encoding='utf-8'), 'native footer missing 3.3.0')

# ---------------------------------------------------------------- requirements
rows = list(csv.DictReader((DOCS / 'requirements/master-requirements.csv').open(encoding='utf-8-sig', newline='')))
by_id = {r['Requirement ID']: r for r in rows}
mc = Counter(r['Status'] for r in rows)
check(len(rows) == 102, 'master rows=%d' % len(rows))
check(mc.get('IMPLEMENTED_PASS') == 87, 'master PASS=%s' % mc.get('IMPLEMENTED_PASS'))
check(mc.get('UNVERIFIED') == 10 and mc.get('NOT_STARTED') == 4 and mc.get('BLOCKED_EXTERNAL') == 1,
      'master statuses=%s' % dict(mc))
for rid in ('R014', 'R127', 'R149', 'R150', 'R151', 'R152'):
    check(by_id[rid]['Status'] == 'IMPLEMENTED_PASS', '%s not IMPLEMENTED_PASS' % rid)
check(by_id['R119']['Status'] == 'UNVERIFIED', 'R119 (clean-VM lifecycle) must stay UNVERIFIED')
check(by_id['R138']['Status'] == 'BLOCKED_EXTERNAL', 'R138 not BLOCKED_EXTERNAL')
check(INST_SHA in by_id['R100']['Evidence'] and '131,011,183' in by_id['R100']['Evidence'],
      'R100 evidence missing final 3.3.0 installer')

# ---------------------------------------------------------------- parity + ui + defects
parity = list(csv.DictReader((DOCS / 'migration/feature-parity-matrix.csv').open(encoding='utf-8-sig', newline='')))
pc = Counter(r['vnext_status'] for r in parity)
check(len(parity) == 92, 'parity rows=%d' % len(parity))
check(pc.get('IMPLEMENTED_PASS') == 72, 'parity PASS=%s' % pc.get('IMPLEMENTED_PASS'))
check(pc.get('UNVERIFIED') == 8 and pc.get('NOT_STARTED') == 9 and pc.get('BLOCKED_EXTERNAL') == 1,
      'parity other statuses=%s' % dict(pc))

ui = list(csv.DictReader((DOCS / 'verification/ui-action-coverage.csv').open(encoding='utf-8-sig', newline='')))
uc = Counter(r['wired_status'] for r in ui)
check(len(ui) == 148, 'ui coverage rows=%d' % len(ui))
check(set(uc) <= {'WIRED_DAEMON_RPC', 'WIRED_MAIN_PROCESS', 'WIRED_UI_ONLY'}, 'ui unknown statuses=%s' % dict(uc))
check(sum(uc.values()) == 148, 'ui status sum=%d' % sum(uc.values()))

defects = list(csv.DictReader((DOCS / 'verification/defect-register.csv').open(encoding='utf-8-sig', newline='')))
check(len(defects) == 23, 'defect rows=%d' % len(defects))
check(all(None not in r for r in defects), 'defect register has malformed rows')
check(any(r['Bug ID'] == 'D-022' and r['Status'] == 'FIXED' for r in defects), 'D-022 missing')

# ---------------------------------------------------------------- artifacts + hashes
rel = ROOT / 'desktop/release'
sums = (rel / 'SHA256SUMS').read_text(encoding='utf-8').splitlines()
mirror = (DOCS / 'release/SHA256SUMS.txt').read_text(encoding='utf-8').splitlines()
check([s.lower() for s in sums] == [s.lower() for s in mirror], 'SHA256SUMS mirror mismatch')
installer = rel / 'SuWen-Setup-3.3.0-win-x64.exe'
blockmap = rel / 'SuWen-Setup-3.3.0-win-x64.exe.blockmap'
unpacked = rel / 'win-unpacked/SuWen.exe'
check(installer.exists() and installer.stat().st_size == INST_BYTES, 'installer bytes mismatch')
check(sha256(installer) == INST_SHA, 'installer hash mismatch')
check(blockmap.exists() and sha256(blockmap) == BLK_SHA, 'blockmap hash mismatch')
check(unpacked.exists() and sha256(unpacked) == UNP_SHA, 'unpacked hash mismatch')

win_doc = (DOCS / 'release/windows-installer-verification.md').read_text(encoding='utf-8')
final_doc = (DOCS / 'release/final-acceptance-report.md').read_text(encoding='utf-8')
notes = (DOCS / 'release/release-notes-v3.3.0.md').read_text(encoding='utf-8')
integ = (DOCS / 'verification/integration-and-e2e.md').read_text(encoding='utf-8')
for name, doc in (('windows-installer-verification', win_doc), ('final-acceptance', final_doc),
                  ('release-notes-3.3.0', notes), ('integration-and-e2e', integ)):
    check(INST_SHA in doc, '%s missing current installer hash' % name)
check('220630DA' not in (win_doc + final_doc + notes), 'stale 3.3.0 pre-final hash leaked')
check(UNP_SHA in win_doc and BLK_SHA in win_doc, 'windows installer doc missing unpacked/blockmap hashes')

# ---------------------------------------------------------------- measured evidence
life = load_json('docs/verification/artifacts/installer-lifecycle.json')
check(life.get('ok') is True and life.get('passed') == 12 and life.get('failed') == 0,
      'lifecycle summary=%s/%s/%s' % (life.get('ok'), life.get('passed'), life.get('failed')))
check(life.get('installerBytes') == INST_BYTES, 'lifecycle installerBytes')
check(str(life.get('installerSha256', '')).upper() == INST_SHA, 'lifecycle installerSha256')
steps = life.get('steps', [])
names = {s.get('name') for s in steps}
for required in ('upgrade_install_old', 'install', 'files', 'app_launch', 'daemon_health',
                 'daemon_survives_ui_close', 'reinstall', 'uninstall', 'user_data_preserved'):
    check(required in names, 'lifecycle step missing: %s' % required)

chaos = load_json('docs/verification/chaos-results.json')
check(chaos.get('result') == 'passed' and len(chaos.get('scenarios', [])) == 12,
      'chaos summary mismatch')
check(chaos.get('durationMs') == 53382, 'chaos duration=%s' % chaos.get('durationMs'))

e2e = load_json('desktop/release/workbench-e2e/20261025-135558/report.json')
es = e2e.get('summary', {})
check(es.get('status') == 'PASS', 'hosted workbench E2E status=%s' % es.get('status'))
check(es.get('checks', {}).get('PASS') == 34, 'hosted E2E checks=%s' % es.get('checks'))
check(es.get('routesPassed') == 12 and es.get('routesFailed') == 0, 'hosted E2E routes')
check(es.get('legacyPageErrors') == 0 and es.get('legacyConsoleErrors') == 0, 'hosted E2E page errors')
check(es.get('markdown', {}).get('cspViolations') == 0, 'hosted E2E CSP violations')
check(es.get('markdown', {}).get('themes', {}).get('light') == 'light', 'hosted E2E light theme')

smoke = load_json('docs/verification/workbench-runtime-smoke.json')
check(smoke.get('result') == 'passed' and smoke.get('passed') == 27 and smoke.get('failed') == [],
      'runtime smoke summary')
cfg = load_json('docs/verification/workbench-config-injection.json')
check(cfg.get('result') == 'passed', 'config injection result')
passes = sum(1 for c in cfg.get('checks', []) if c.get('status') == 'PASS' or c.get('ok') is True)
check(passes == 13, 'config injection checks=%s' % passes)

pkg_smoke = load_json('desktop/release/smoke/work/electron-e2e-result.json')
check(pkg_smoke.get('result') == 'passed', 'packaged smoke result')
lw = pkg_smoke.get('legacyWorkbench') or {}
check(lw.get('hosted') is True, 'packaged smoke hosted workbench missing')
check(lw.get('navItems') == 12 and len(lw.get('routes', [])) == 12, 'packaged smoke legacy routes')

# ---------------------------------------------------------------- doc coherence
prog = (DOCS / 'progress.md').read_text(encoding='utf-8')
check('Round 5 — legacy web parity in DESKTOP' in prog, 'progress round-5 section missing')
check('222' in integ and '34/34' in integ, 'integration doc missing round-5 numbers')
gates = (DOCS / 'release/release-gates.md').read_text(encoding='utf-8')
check('3.3.0' in gates and 'HOLD' in gates, 'gates doc not updated for 3.3.0/HOLD')
changelog = (DOCS / 'release/CHANGELOG.md').read_text(encoding='utf-8')
check('## [3.3.0]' in changelog, 'CHANGELOG missing 3.3.0')
parity_md = (DOCS / 'verification/legacy-web-parity.md').read_text(encoding='utf-8')
check('HOSTED_LEGACY_PENDING_E2E' not in parity_md, 'legacy-web-parity still PENDING_E2E')
check('HOSTED_LEGACY_VERIFIED' in parity_md, 'legacy-web-parity not verified')

print('checks: %d, failures: %d' % (checks, len(failures)))
for f in failures:
    print('FAIL', f)
sys.exit(1 if failures else 0)
