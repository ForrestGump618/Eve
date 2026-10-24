# Windows installer verification — SuWen desktop 3.2.0

Evidence measured in TARGET `C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext`
(branch `suwen-vnext-durable`, 2026-10-25). Only inspected files/artifacts are recorded here.
Anything not executed is marked **NOT RUN** / **UNVERIFIED** / **PENDING_LEAD** — never claimed as passed.

> Supersession: the previous revision of this file documented the 3.1.0 build
> (`SuWen-Setup-3.1.0-win-x64.exe`, 129,425,145 B, SHA256 `E1A1062C…` for the earlier 3.1.0 build). Those values are historical and superseded. The delivered artifact is the
> final **3.2.0** build below (conflict C-17 in `docs/requirements/conflicts.md`).

> **Artifact supersession (2026-10-25):** the installer was rebuilt after the final T2 P2 fix (waiting_approval review notice + paint/lifecycle guard). Current artifact: **129,447,101 B, SHA256 4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897** (unsigned). Earlier builds (3.1.0 `E1A1062C…`, and the pre-P2 round-3 build) are superseded; see `docs/verification/artifacts/installer-lifecycle.json` for the lifecycle run on this exact build.

## 1. Build facts

| Item | Value |
|---|---|
| Package | `suwen-desktop` **3.2.0** (`desktop/package.json`) |
| Build command | `npm run dist:win` → `npm run build && electron-builder --win nsis --x64` |
| Build time | final installer written **2026-10-24T19:16:10Z** |
| Electron | 45.0.0 (runtime Node 24.22.0, SQLite 3.53.4) |
| Builder | electron-builder 26.18.0 |
| Host | Windows 11 10.0.26200 x64 |
| Mirror note | electron-builder downloads needed `npmmirror` mirrors because a direct GitHub download timed out once (`ETIMEDOUT 20.205.243.166:443`); the successful build used the mirrors |
| Signing | **UNSIGNED** — `signExecutable: false`, no code-signing certificate in this environment |
| ASAR | disabled (`asar: false`), payload is unpacked `resources/app/**` |

## 2. Produced artifacts and SHA-256 (verified with `Get-FileHash` in TARGET)

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `desktop/release/SuWen-Setup-3.2.0-win-x64.exe` (delivered) | **129,447,101** | `4590B7F3C38041985EB31F56047E4C35FCF0B2286FE6E989F55F736CB230B897` |
| `desktop/release/SuWen-Setup-3.2.0-win-x64.exe.blockmap` | 135,948 | `283b27e19d2a943dd940b8e83f748ceb2627950a87cad509069efae4230cbb72` |
| `desktop/release/win-unpacked/SuWen.exe` | **249,801,728** | `8f7eaf76feb66a61e51d5f8b9b67eefa375fedd0018a5566d64c27f0570a22e1` |

`SHA256SUMS` is written next to the built artifacts at `desktop/release/SHA256SUMS` and mirrored in
the committed file `docs/release/SHA256SUMS.txt` (3 lines, same values, exe / unpacked exe / blockmap).
The Windows CI workflow regenerates it in CI (`.github/workflows/suwen-windows.yml`, **never executed**
in this session). These three hashes are the authoritative values for the delivered artifact.

## 3. Package layout (inspected in `release/win-unpacked`)

- `resources/app/dist/main.js`, `resources/app/dist/src/daemon.js`,
  `resources/app/dist/ui/index.html` – Electron main, detached daemon, renderer UI.
- `resources/app/package.json` (302 B), `LICENSE` (1,098 B), `NOTICE` (947 B),
  `third-party-licenses/**` (incl. inventory.json), bundled `node_modules` for the renderer/main deps.
- `resources/worker/research_worker.py` – managed Python research worker (v2.0.0, stdlib only).
- `resources/legacy/**` – original Apache-2.0 legacy Python workbench sources (optional compatibility
  mode); not bundled as a runtime Python.
- `elevate.exe` 107,520 B (NSIS helper).
- Installer is NSIS x64, per-user (`perMachine: false`), `oneClick: false`,
  `allowToChangeInstallationDirectory: true`, `deleteAppDataOnUninstall: false`,
  shortcut/uninstall display name `SuWen`, appId `org.suwen.desktop`, icon `assets/suwen.ico`.

## 4. Host lifecycle probe on the FINAL 3.2.0 artifact (12/12 PASS — not a clean-VM test)

Artifact: `docs/verification/artifacts/installer-lifecycle.json`
(`version=3.2.0`, `installerBytes=129,447,101`, `installerSha256=4590B7F3…230B897`; `ok=true`,
`passed=12`, `failed=0`; `note` = "host-level only; no clean VM used"). Steps:

| Step | Status | Detail |
|---|---|---|
| upgrade source (old 3.0.0-preview.1 installed) | PASS | old installer sha256 F263AF7B…; DisplayVersion=3.0.0-preview.1 |
| silent install | PASS | exit=0, ~24 s |
| installed exe / version metadata | PASS | `…\AppData\Local\Programs\SuWen\SuWen.exe`, 249,801,728 B, FileVersion=3.2.0, ProductVersion=3.2.0.0 |
| registry uninstall entry | PASS | `SuWen` / DisplayVersion=3.2.0 (HKCU) |
| installed app launches | PASS | pid 16692 still alive after 12 s |
| daemon health over authenticated named pipe | PASS | version=3.2.0, mode=`user-background`, pid 51088 |
| daemon survives closing the installed UI | PASS | same pid 51088, version 3.2.0 |
| same-version reinstall | PASS | kept the app executable, exit 0 |
| silent uninstall | PASS | exit=0, install directory removed |
| user data preserved | PASS | test home `%APPDATA%\SuWen` still exists |
| registry entry removed | PASS | no remaining HKCU uninstall entry |

**12/12 steps passed on the delivered installer.** This is a **host** probe (the machine already has
Node, Python and previous SuWen data), **not** a clean-VM test. The probe removed
`ELECTRON_RUN_AS_NODE` from the launching shell only — a test-environment caveat, not a product
defect; the shipped app is unmodified.

## 5. What is NOT verified

1. **Clean Windows VM** install → start → uninstall, including first-run behavior with no Node/Python
   and no previous SuWen data. **NOT RUN** (no VM available).
2. Cross-version upgrade on a clean machine (the host probe starts from an installed
   3.0.0-preview.1 and upgrades to 3.2.0; that only proves the upgrade *source* install step on a
   host that has a developer environment).
3. CI execution of `.github/workflows/suwen-windows.yml`: authored and valid YAML, **never run** here;
   the workflow regenerates `SHA256SUMS` and uploads artifacts.
4. **Code signing / SmartScreen trust** — BLOCKED_EXTERNAL: no certificate. Windows SmartScreen will
   warn on this unsigned installer. No signing claim is made.
5. Auto-update path, per-machine install, uninstall keeping data across major versions.
6. Python runtime bootstrap (R101): the installer does not ship a Python runtime; basic chat/MCP works
   without Python, the optional worker requires a user-selected interpreter.
7. Database schema migration with pre-upgrade backup under a **cross-version** upgrade was not
   separately measured (upgrade steps only verified install/version/daemon health).

## 6. Requirement mapping

| Requirement | Status |
|---|---|
| R100 NSIS x64 + SHA256SUMS + install/start/upgrade/uninstall | installer + final hashes measured (129,447,101 B, SHA256 `4590B7F3…`); `SHA256SUMS` in `desktop/release/SHA256SUMS` + `docs/release/SHA256SUMS.txt`; host install/start/reinstall/uninstall **12/12 passed**; clean-VM lifecycle NOT RUN → row kept **UNVERIFIED/PARTIAL** in the master CSV |
| R101 optional Python runtime bootstrap | NOT_STARTED (worker uses user-selected interpreter; no bundled Python) |
| R102 upgrade migrates DB with backup; uninstall keeps data | host upgrade source 3.0.0-preview.1 install PASS; uninstall keeps user data; DB migration with backup under upgrade not separately measured → UNVERIFIED |
| R103 SmartScreen truthfulness | PASS for honesty: unsigned status documented; certificate absent |
| R119 clean Windows install/start/upgrade/uninstall | host lifecycle 12/12 PASS on the final artifact; **clean-VM lifecycle NOT RUN** → UNVERIFIED |
| R120 windows-installer-verification.md report | this file |
| R121 final delivery | final installer path/bytes/SHA256 + SHA256SUMS recorded; remaining gaps disclosed |

## 7. Repro commands

```powershell
cd C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\desktop
npm run dist:win
Get-FileHash release\SuWen-Setup-3.2.0-win-x64.exe -Algorithm SHA256
Get-FileHash release\SuWen-Setup-3.2.0-win-x64.exe.blockmap -Algorithm SHA256
Get-FileHash release\win-unpacked\SuWen.exe -Algorithm SHA256
# silent lifecycle (host probe pattern; needs a test home that the installed app honors)
release\SuWen-Setup-3.2.0-win-x64.exe /S
& "$env:LOCALAPPDATA\Programs\SuWen\SuWen.exe"
& "$env:LOCALAPPDATA\Programs\SuWen\Uninstall SuWen.exe" /S
```

**Honesty statement:** the final 3.2.0 installer exists, its bytes/hashes are verified, the
final-artifact host lifecycle probe passed **12/12**, and the upgrade source 3.0.0-preview.1 installed
successfully. There is still **no clean-VM verification and no code signature**; `SHA256SUMS` is
present. Do not describe this as a clean-machine verified or published release.
