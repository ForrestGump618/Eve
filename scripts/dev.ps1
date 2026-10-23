#Requires -Version 5.1
<#
.SYNOPSIS
    Start Suwen in development mode (auto-reload when supported).

.DESCRIPTION
    Runs `python -m omicslab serve --port <port> --reload` if the CLI supports
    --reload; otherwise falls back to a plain serve. The process is attached to
    this console, so Ctrl+C stops the server.

.PARAMETER Port
    Port to listen on. Default: 5077.

.PARAMETER Workspace
    Workspace directory (default: the directory this script is run from).

.PARAMETER NoReload
    Force plain serve even if --reload is supported.

.EXAMPLE
    .\scripts\dev.ps1

.EXAMPLE
    .\scripts\dev.ps1 -Port 5078 -Workspace C:\data\pbmc
#>
[CmdletBinding()]
param(
    [int]$Port = 5077,
    [string]$Workspace = "",
    [switch]$NoReload
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

function Fail([string]$Message) {
    Write-Host "ERROR: $Message" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $VenvPython)) {
    Fail @"
Virtual environment not found: "$VenvPython"
  Run the bootstrap script first:  .\scripts\bootstrap.ps1
"@
}

# --- Detect --reload support without starting the server ---------------------
$supportsReload = $false
if (-not $NoReload) {
    $previous = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $helpText = (& $VenvPython -m omicslab serve --help 2>&1 | Out-String)
        if ($LASTEXITCODE -eq 0 -and $helpText -match "--reload") {
            $supportsReload = $true
        }
    } catch {
        $supportsReload = $false
    } finally {
        $ErrorActionPreference = $previous
    }
}

# --- Build the command line --------------------------------------------------
$serveArgs = @("-m", "omicslab", "serve", "--port", "$Port")
if ($Workspace) { $serveArgs += @("--workspace", $Workspace) }
if ($supportsReload) {
    $serveArgs += "--reload"
    Write-Host "==> Dev mode: auto-reload enabled" -ForegroundColor Cyan
} else {
    Write-Host "==> Dev mode: auto-reload not available, starting plain serve" -ForegroundColor Yellow
}

$url = "http://127.0.0.1:$Port"
Write-Host "==> Starting server: $url" -ForegroundColor Cyan
if ($Workspace) { Write-Host "==> Workspace: $Workspace" -ForegroundColor DarkGray }
Write-Host "    Press Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

& $VenvPython @serveArgs
exit $LASTEXITCODE
