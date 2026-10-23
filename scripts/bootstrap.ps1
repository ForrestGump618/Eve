#Requires -Version 5.1
<#
.SYNOPSIS
    Bootstrap a local Suwen development environment.

.DESCRIPTION
    Locates a Python >= 3.10 interpreter, creates a .venv in the repository
    root, upgrades pip, and installs the project in editable mode. Safe to
    re-run: an existing .venv is reused.

.PARAMETER NoInstall
    Only create/reuse the virtual environment; skip pip install.

.PARAMETER Extras
    Comma separated optional dependency groups, e.g. "bio,dev".

.PARAMETER Python
    Explicit Python interpreter to use instead of auto-detection.

.EXAMPLE
    .\scripts\bootstrap.ps1

.EXAMPLE
    .\scripts\bootstrap.ps1 -Extras "bio,dev"

.EXAMPLE
    .\scripts\bootstrap.ps1 -NoInstall
#>
[CmdletBinding()]
param(
    [switch]$NoInstall,
    [string]$Extras = "",
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"

# Repository root = parent of this scripts/ directory. No absolute paths.
$Root = Split-Path -Parent $PSScriptRoot
$VenvDir = Join-Path $Root ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Write-Step([string]$Message) { Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "OK  $Message" -ForegroundColor Green }
function Write-Warn([string]$Message) { Write-Host "WARN $Message" -ForegroundColor Yellow }
function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

Write-Step "Suwen bootstrap (project: $Root)"

# --- 1. Locate a usable Python interpreter -----------------------------------
$candidates = @()
if ($Python) { $candidates += , @($Python) }
$candidates += , @("python")
$candidates += , @("python3")
$candidates += , @("py", "-3.12")
$candidates += , @("py", "-3.11")
$candidates += , @("py", "-3.10")
$candidates += , @("py", "-3")

$versionCheck = "import sys; sys.exit(0 if sys.version_info[:2] >= (3, 10) else 1)"
$pythonCmd = $null
foreach ($candidate in $candidates) {
    $exe = [string]$candidate[0]
    $argv = @()
    if ($candidate.Count -gt 1) { $argv = @($candidate[1..($candidate.Count - 1)]) }

    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
    try {
        & $exe @argv -c $versionCheck *> $null
    } catch {
        continue
    }
    if ($LASTEXITCODE -eq 0) {
        $pythonCmd = $candidate
        break
    }
}

if (-not $pythonCmd) {
    Fail @"
No Python >= 3.10 found.
  - Install Python 3.10+ from https://www.python.org/downloads/
  - Make sure it is on PATH (Windows installer: check "Add python.exe to PATH")
  - Or pass an explicit interpreter:  .\scripts\bootstrap.ps1 -Python C:\path\to\python.exe
"@
}

$pyExe = [string]$pythonCmd[0]
$pyArgs = @()
if ($pythonCmd.Count -gt 1) { $pyArgs = @($pythonCmd[1..($pythonCmd.Count - 1)]) }
$pyVersion = (& $pyExe @pyArgs -c "import sys; print(sys.version.split()[0])").Trim()
Write-Ok "Using Python $pyVersion ($pyExe $($pyArgs -join ' '))".Trim()

# --- 2. Create or reuse the virtual environment ------------------------------
if (Test-Path $VenvPython) {
    Write-Ok "Reusing existing virtual environment: $VenvDir"
} else {
    Write-Step "Creating virtual environment at $VenvDir"
    & $pyExe @pyArgs -m venv $VenvDir
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $VenvPython)) {
        Fail @"
Failed to create the virtual environment.
  - Windows: reinstall Python and include the "pip" and "venv" components.
  - Debian/Ubuntu: sudo apt install python3-venv
  - Or create it manually:  $pyExe $($pyArgs -join ' ') -m venv "$VenvDir"
"@
    }
    Write-Ok "Virtual environment created"
}

# --- 3. Upgrade pip ----------------------------------------------------------
Write-Step "Upgrading pip"
& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) {
    Fail @"
pip upgrade failed (network or proxy problem?).
  Retry manually:  "$VenvPython" -m pip install --upgrade pip
  Behind a proxy:  `$env:HTTPS_PROXY = "http://host:port"
"@
}
Write-Ok "pip is up to date"

# --- 4. Install the project --------------------------------------------------
if ($NoInstall) {
    Write-Ok "Skipping dependency installation (-NoInstall)"
} else {
    $extras = $Extras.Trim().Trim(',').Trim()
    $target = "."
    if ($extras) { $target = ".[$extras]" }

    Write-Step "Installing Suwen in editable mode: $target"
    Push-Location $Root
    try {
        & $VenvPython -m pip install -e $target
        $installExit = $LASTEXITCODE
    } finally {
        Pop-Location
    }
    if ($installExit -ne 0) {
        Fail @"
Dependency installation failed.
  Retry manually from "$Root":
    "$VenvPython" -m pip install -e "$target"
  If a native package fails to build on Windows, install "Build Tools for Visual Studio"
  (https://visualstudio.microsoft.com/visual-cpp-build-tools/), or try:
    "$VenvPython" -m pip install -e "$target" --only-binary=:all:
"@
    }
    Write-Ok "Dependencies installed"
}

# --- 5. Next steps -----------------------------------------------------------
Write-Host ""
Write-Host "Next steps" -ForegroundColor Cyan
Write-Host "  1) Configure an LLM provider (pick one):"
Write-Host "       `$env:DEEPSEEK_API_KEY = 'sk-...'      # this PowerShell session only"
Write-Host "       or start the server and use the Settings page"
Write-Host "  2) Start the server:"
Write-Host "       .venv\Scripts\python.exe -m omicslab serve --port 5077"
Write-Host "  3) Open:  http://127.0.0.1:5077"
Write-Host ""
Write-Host "Health check:  .venv\Scripts\python.exe -m omicslab env" -ForegroundColor DarkGray
Write-Host "Dev mode:      .\scripts\dev.ps1" -ForegroundColor DarkGray
Write-Host ""
exit 0
