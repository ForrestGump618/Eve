[CmdletBinding()]
param([switch]$NativeConsole)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules\electron'))) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if ($NativeConsole) { & npm.cmd start -- --native } else { & npm.cmd start }
exit $LASTEXITCODE
