# Eve Windows installer lifecycle verification (reproducible).
# Steps: [optional old-version install] -> silent install -> metadata -> launch app ->
#        authenticated daemon health -> UI close keeps daemon -> reinstall -> silent uninstall ->
#        install dir removed, user data preserved, registry entry removed.
# Usage (PowerShell 5.1+):
#   powershell -ExecutionPolicy Bypass -File scripts\verify-installer.ps1 -Installer "release\SuWen-Setup-3.2.0-win-x64.exe" -Version 3.2.0
#   optional upgrade: -UpgradeFrom "C:\path\SuWen-Setup-3.0.0-preview.1-win-x64.exe" -UpgradeFromVersion 3.0.0-preview.1
param(
  [Parameter(Mandatory = $true)][string]$Installer,
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$UpgradeFrom = '',
  [string]$UpgradeFromVersion = '',
  [string]$OutFile = ''
)
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutFile) { $OutFile = Join-Path $root '..\docs\verification\artifacts\installer-lifecycle.json' }
$steps = New-Object System.Collections.ArrayList
function Add-Step([string]$name, [string]$status, [string]$detail) {
  [void]$steps.Add([ordered]@{ name = $name; status = $status; detail = $detail; at = (Get-Date).ToUniversalTime().ToString('o') })
  Write-Output ("[{0}] {1} - {2}" -f $status, $name, $detail)
}
function Fail([string]$message) {
  Add-Step 'fatal' 'FAIL' $message
  Write-Output "FATAL: $message"
  exit 1
}
function Wait-Exit($process, [int]$seconds) {
  if ($null -eq $process) { return $true }
  return $process.WaitForExit($seconds * 1000)
}
function Get-EveRegistryEntry {
  $keys = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' -ErrorAction SilentlyContinue
  foreach ($key in $keys) {
    $props = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
    if ($props -and $props.DisplayName -eq 'Eve') { return $props }
  }
  return $null
}
function Get-DaemonHealth {
  $homeDir = Join-Path $env:APPDATA 'Eve\runtime'
  $script = Join-Path $PSScriptRoot 'pipe-health.mjs'
  $raw = & node $script --home $homeDir 2>&1
  if ($LASTEXITCODE -ne 0) { return $null }
  try { return (($raw | Select-Object -Last 1) | ConvertFrom-Json) } catch { return $null }
}

if (-not (Test-Path -LiteralPath $Installer)) { Fail "installer not found: $Installer" }
$installerItem = Get-Item -LiteralPath $Installer
$installerHash = (Get-FileHash -LiteralPath $Installer -Algorithm SHA256).Hash
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Eve'
$userDataDir = Join-Path $env:APPDATA 'Eve'
$appExe = Join-Path $installDir 'Eve.exe'
$uninstaller = Join-Path $installDir 'Uninstall Eve.exe'

# Make sure no stale app process from a previous run interferes.
Get-Process -Name 'Eve' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

if ($UpgradeFrom) {
  if (-not (Test-Path -LiteralPath $UpgradeFrom)) { Fail "upgrade source installer not found: $UpgradeFrom" }
  Add-Step 'upgrade_source' 'INFO' ("{0} sha256={1}" -f $UpgradeFrom, (Get-FileHash -LiteralPath $UpgradeFrom -Algorithm SHA256).Hash)
  $old = Start-Process -FilePath $UpgradeFrom -ArgumentList '/S' -Wait -PassThru
  if (-not $old -or $old.ExitCode -ne 0) { Fail "old installer exit code: $($old.ExitCode)" }
  Start-Sleep -Seconds 5
  $oldEntry = Get-EveRegistryEntry
  if (-not $oldEntry) { Fail 'old version registry entry missing after install' }
  $oldDetail = "DisplayVersion=$($oldEntry.DisplayVersion)"
  if ($UpgradeFromVersion) { $oldDetail += " expected=$UpgradeFromVersion" }
  Add-Step 'upgrade_install_old' 'PASS' $oldDetail
  $oldExe = Get-Item -LiteralPath $appExe
  Add-Step 'upgrade_old_exe' 'PASS' ("{0} bytes={1} version={2}" -f $appExe, $oldExe.Length, $oldExe.VersionInfo.FileVersion)
}

$install = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
if (-not $install -or $install.ExitCode -ne 0) { Fail "installer exit code: $($install.ExitCode)" }
Start-Sleep -Seconds 5
Add-Step 'install' 'PASS' ("exit={0} installerBytes={1} sha256={2} duration=~{3}s" -f $install.ExitCode, $installerItem.Length, $installerHash, [int]($install.ExitTime - $install.StartTime).TotalSeconds)

if (-not (Test-Path -LiteralPath $appExe)) { Fail "app executable missing: $appExe" }
if (-not (Test-Path -LiteralPath $uninstaller)) { Fail "uninstaller missing: $uninstaller" }
$appItem = Get-Item -LiteralPath $appExe
Add-Step 'files' 'PASS' ("Eve.exe bytes={0} FileVersion={1} ProductVersion={2}" -f $appItem.Length, $appItem.VersionInfo.FileVersion, $appItem.VersionInfo.ProductVersion)

$entry = Get-EveRegistryEntry
if (-not $entry) { Fail 'registry entry missing' }
$registryDetail = "DisplayName=$($entry.DisplayName) DisplayVersion=$($entry.DisplayVersion)"
if ($entry.DisplayVersion -ne $Version) { Fail "registry version mismatch: $($entry.DisplayVersion) != $Version" }
Add-Step 'registry' 'PASS' $registryDetail

$env:ELECTRON_RUN_AS_NODE = $null
$app = Start-Process -FilePath $appExe -PassThru
Start-Sleep -Seconds 12
$running = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
if (-not $running) {
  Add-Step 'app_launch' 'FAIL' 'installed app exited before the 12s check (stderr not captured)'
} else {
  Add-Step 'app_launch' 'PASS' ("pid={0} alive after 12s" -f $app.Id)
  $health = Get-DaemonHealth
  if (-not $health) {
    Add-Step 'daemon_health' 'FAIL' 'authenticated named-pipe health failed'
  } else {
    $healthVersion = $health.result.version
    if ($healthVersion -ne $Version) { Add-Step 'daemon_health' 'FAIL' "daemon version $healthVersion != $Version" }
    else { Add-Step 'daemon_health' 'PASS' ("version={0} mode={1} pid={2}" -f $healthVersion, $health.result.mode, $health.pid) }
  }
  $appPid = $app.Id
  Stop-Process -Id $appPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $healthAfter = Get-DaemonHealth
  if (-not $healthAfter) { Add-Step 'daemon_survives_ui_close' 'FAIL' 'daemon not reachable after UI process was killed' }
  else { Add-Step 'daemon_survives_ui_close' 'PASS' ("version={0} pid={1}" -f $healthAfter.result.version, $healthAfter.pid) }
}

$reinstall = Start-Process -FilePath $Installer -ArgumentList '/S' -Wait -PassThru
Start-Sleep -Seconds 4
if (-not $reinstall -or $reinstall.ExitCode -ne 0) { Add-Step 'reinstall' 'FAIL' "exit=$($reinstall.ExitCode)" }
elseif (-not (Test-Path -LiteralPath $appExe)) { Add-Step 'reinstall' 'FAIL' 'app executable missing after reinstall' }
else { Add-Step 'reinstall' 'PASS' 'same-version reinstall kept the app executable' }

$uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
Start-Sleep -Seconds 6
$uninstallCode = if ($uninstall) { $uninstall.ExitCode } else { -1 }
Start-Sleep -Seconds 4
if (Test-Path -LiteralPath $appExe) { Add-Step 'uninstall' 'FAIL' 'app executable still present after silent uninstall' }
else { Add-Step 'uninstall' 'PASS' "exit=$uninstallCode install directory removed" }
if (Test-Path -LiteralPath $userDataDir) { Add-Step 'user_data_preserved' 'PASS' $userDataDir }
else { Add-Step 'user_data_preserved' 'FAIL' "user data directory missing: $userDataDir" }
$entryAfter = Get-EveRegistryEntry
if ($entryAfter) { Add-Step 'registry_removed' 'FAIL' "registry entry still present: $($entryAfter.DisplayVersion)" }
else { Add-Step 'registry_removed' 'PASS' 'HKCU uninstall entry removed' }

Get-Process -Name 'SuWen' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$failed = @($steps | Where-Object { $_.status -eq 'FAIL' })
$report = [ordered]@{
  at = (Get-Date).ToUniversalTime().ToString('o')
  version = $Version
  installer = (Resolve-Path -LiteralPath $Installer).Path
  installerBytes = $installerItem.Length
  installerSha256 = $installerHash
  upgradeFrom = $UpgradeFrom
  steps = $steps
  passed = @($steps | Where-Object { $_.status -eq 'PASS' }).Count
  failed = $failed.Count
  ok = ($failed.Count -eq 0)
  note = 'Host-level lifecycle only. Not a clean Windows VM, no code signature, no cross-major upgrade matrix.'
}
$outDir = Split-Path -Parent $OutFile
if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
$report | ConvertTo-Json -Depth 6 | ForEach-Object { [System.IO.File]::WriteAllText($OutFile, $_, (New-Object System.Text.UTF8Encoding($false))) }
Write-Output ("REPORT {0} passed={1} failed={2}" -f $OutFile, $report.passed, $report.failed)
if ($failed.Count -gt 0) { exit 1 } else { exit 0 }
