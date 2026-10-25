"""Round-5: update top-level README + acceptance matrix + two count strings to 3.3.0."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
INST = '0B55D5BDFBA86C6C1CF2C4D4EB378E113BABDC02C9D6C16F8043F7D7171DAE03'


def read(p):
    return (ROOT / p).read_text(encoding='utf-8')


def write(p, t):
    (ROOT / p).write_text(t, encoding='utf-8', newline='')


def rep(t, old, new):
    return t.replace(old, new, 1) if old in t else t


t = read('README.md')
t = rep(t, '# 素问 / SuWen desktop 3.2.0', '# 素问 / SuWen desktop 3.3.0')
t = rep(t, '- 当前版本 / Version: **3.2.0**', '- 当前版本 / Version: **3.3.0**')
t = rep(t, 'Measured on this machine (final 3.2.0 build, 2026-10-25, branch `suwen-vnext-durable`):',
        'Measured on this machine (final 3.3.0 build, 2026-10-25, branch `suwen-vnext-durable`):')
t = rep(t, '| installer | `release/SuWen-Setup-3.2.0-win-x64.exe`, **129,447,101 B**, SHA-256 `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897`',
        f'| installer | `release/SuWen-Setup-3.3.0-win-x64.exe`, **131,011,183 B**, SHA-256 `{INST}`')
t = rep(t, 'npm run dist:win    # -> release/SuWen-Setup-3.2.0-win-x64.exe',
        'npm run dist:win    # -> release/SuWen-Setup-3.3.0-win-x64.exe')
t = rep(t, 'Do not describe 3.2.0 as a production-ready, clean-machine-verified or fully vNext-complet',
        'Do not describe 3.3.0 as a production-ready, clean-machine-verified or fully vNext-complet')
write('README.md', t)

t = read('docs/release/final-acceptance-report.md')
t = rep(t, '**102 rows -> 86 IMPLEMENTED_PASS', '**102 rows -> 87 IMPLEMENTED_PASS')
write('docs/release/final-acceptance-report.md', t)

t = read('docs/release/release-gates.md')
t = rep(t, '(98 rows — 81 IMPLEMENTED_PASS / 12 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL).',
        '(102 rows — 87 IMPLEMENTED_PASS / 10 UNVERIFIED / 4 NOT_STARTED / 1 BLOCKED_EXTERNAL; round-5 rows R149-R152).')
write('docs/release/release-gates.md', t)

p = 'desktop/acceptance-matrix.md'
t = read(p)
if 'Round-5 (3.3.0) supersession' not in t:
    block = f"""# vNext acceptance status - desktop 3.3.0 (2026-10-25, round-5)

Round-5 (3.3.0) supersedes the 3.2.0 table below: hosted legacy web workbench E2E 34/34,
runtime smoke 27/27, config injection 13/13, markdown unit 32/32, full suite 222/220/0/2,
RPC E2E live 42/42, chaos 12/12 (53.4 s), UI DOM QA 18/0/13, packaged smoke passed incl.
hosted SPA, Windows lifecycle 12/12 incl. 3.0.0-preview.1 upgrade. Installer
`release/SuWen-Setup-3.3.0-win-x64.exe` 131,011,183 B SHA256 `{INST}` (UNSIGNED).
Clean-VM lifecycle, signing, 8/24/72 h endurance/reboot/power-loss and real vendor accounts
remain NOT VERIFIED / BLOCKED_EXTERNAL.

---

"""
    write(p, block + t)
print('readme/acceptance updated')
