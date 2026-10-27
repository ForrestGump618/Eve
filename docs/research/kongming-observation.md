# 外部项目 2.3.3 static observation — 2026-10-24

Scope: supplied local installer only; no installer or application execution, account login, endpoint probing, TLS interception, authentication bypass or proprietary source recovery. Extracted files remain in the investigation workspace and must never enter SuWen releases.

| Evidence | Observed fact |
|---|---|
| PowerShell Get-FileHash | 260716184 bytes; SHA256 `fea1c4f21ebd79e3e6a63922f4e64320a5cd5ea697d9863c3462c0165da38b3c` |
| Get-AuthenticodeSignature | NotSigned; publisher authenticity not established by version strings |
| PE VersionInfo | Product Agent 外部项目, version 2.3.3, declared company GHDDI DataScience Team |
| REA `ev_51c467b9ad3450cdb12c5efebe309fbae6a0e05cda1d0c0531c409e633d4b5ff` | PE32 x86 installer stub; 73 resource entries examined, 34 resources. Installer stub architecture is not payload architecture. |
| 7-Zip 26.02 list | NSIS-3 Unicode; nested `$PLUGINSDIR/app-64.7z`, 260091135 bytes |
| ASAR inert metadata read | 17003 leaf entries including 150 unpacked entries; package `kongming` 2.3.3; main `dist-electron/main/index.js`; preload and renderer assets present |
| REA parent `ev_80a63856991876028597b80525edb1adf2c5b9f6b57914ba30da8e6bb9b5ff71` | ASAR SHA256 `145b355ff897f0b0536ed250d7529f4c7812de044cbead70143ec9f2a53d39d1`; only package.json selected, 1579 text bytes, zero JS parsed. Unselected code/runtime behavior is unknown. Semantic unknown inventory reached its limit; no full-code claim. |
| package.json declarations | Vue 3.5.35, vue-router 4.6.4, pinia 2.3.1, @agentclientprotocol/sdk 0.19.2, electron-store ^11.0.2, electron-updater ^6.3.0, node-pty ^1.0.0, RDKit and Molstar. These are declarations, not runtime verification. No app license field observed. |
| app-update.yml | Declared generic update URL `https://datascience.ghddi.org/api/agent/releases`; recorded as metadata, not contacted. |

Electron is supported by packaged structure and Electron/Chromium notices. Dependency names do not establish MCP capability, permission enforcement, scientific reliability, or background durability. No icons, bundles, text or skills were copied into SuWen.

Dynamic boundary: checks for WindowsSandbox.exe and Get-VM found no available isolation entry point. No VM snapshot or test account was available. Host execution was therefore not substituted for the attachment's isolated-VM requirement. Dynamic analysis remains blocked by an isolation/test-account requirement, not classified as passed. Installer source is the user-provided Downloads file; release-channel provenance unknown.
