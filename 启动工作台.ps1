[CmdletBinding()]
param([int]$Port = 8766, [switch]$LegacyWeb, [switch]$NativeConsole)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not $LegacyWeb) {
    & (Join-Path $PSScriptRoot 'desktop\启动Eve.ps1') -NativeConsole:$NativeConsole
    exit $LASTEXITCODE
}
$TaskPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $TaskPython)) {
    $TaskPython = (Get-Command python -ErrorAction Stop).Source
}
$env:PYTHONUTF8 = '1'
& $TaskPython -c "import fastapi, uvicorn, paramiko, jupyter_client, ipykernel"
if ($LASTEXITCODE -ne 0) {
    Write-Host 'Please run scripts/bootstrap.ps1 to install dependencies.'
    exit 1
}
& $TaskPython -m omicslab serve --workspace $PSScriptRoot --home (Join-Path $PSScriptRoot '.omicslab') --port $Port
exit $LASTEXITCODE
