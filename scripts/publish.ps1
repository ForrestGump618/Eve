<#
.SYNOPSIS
    构建 Suwen 发布产物（sdist + wheel + SHA256SUMS.txt）。

.DESCRIPTION
    在一个干净状态下依次执行：跑测试 → 生成 sdist/wheel → 计算 SHA256 → 校验产物内容。
    默认使用仓库内 .venv，可通过 -Python 指定其他解释器。

.PARAMETER SkipTests
    跳过测试（仅构建；不推荐用于正式发布）。

.PARAMETER NoClean
    不先清理 dist/ 与 build/ 目录（默认会清理，避免旧产物混入）。

.PARAMETER Python
    Python 解释器路径，默认 .venv\Scripts\python.exe。

.EXAMPLE
    .\scripts\publish.ps1

.EXAMPLE
    .\scripts\publish.ps1 -SkipTests
#>
[CmdletBinding()]
param(
    [switch]$SkipTests,
    [switch]$NoClean,
    [string]$Python = ""
)

$ErrorActionPreference = "Stop"
$env:PYTHONIOENCODING = "utf-8"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

if (-not $Python) {
    $candidate = Join-Path $Root ".venv\Scripts\python.exe"
    if (Test-Path $candidate) {
        $Python = $candidate
    } else {
        $Python = "python"
    }
}
Write-Host "使用 Python: $Python" -ForegroundColor Cyan
Write-Host "仓库根目录: $Root" -ForegroundColor Cyan

function Invoke-Python {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $Python @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "命令失败（退出码 $LASTEXITCODE）：$Python $($Arguments -join ' ')"
    }
}

if (-not $SkipTests) {
    Write-Host "`n== 1/5 运行测试 ==" -ForegroundColor Yellow
    Invoke-Python -m pytest -q
} else {
    Write-Host "`n== 1/5 跳过测试 ==" -ForegroundColor Yellow
}

Write-Host "`n== 2/5 准备构建工具 ==" -ForegroundColor Yellow
$hasTools = $false
try {
    & $Python -c "import build, setuptools, wheel" 2>$null | Out-Null
    $hasTools = ($LASTEXITCODE -eq 0)
} catch {
    $hasTools = $false
}
if (-not $hasTools) {
    Write-Host "未安装 build/setuptools/wheel，正在安装..." -ForegroundColor Yellow
    Invoke-Python -m pip install --no-cache-dir --progress-bar off "build>=1.0" "setuptools>=68" wheel
}

if (-not $NoClean) {
    Write-Host "`n== 3/5 清理旧产物 ==" -ForegroundColor Yellow
    foreach ($item in @("dist", "build", "omicslab.egg-info")) {
        $target = Join-Path $Root $item
        if (Test-Path $target) {
            Remove-Item -Recurse -Force $target
            Write-Host "  已删除 $item"
        }
    }
}

Write-Host "`n== 4/5 构建 sdist + wheel ==" -ForegroundColor Yellow
# 使用 --no-isolation：构建依赖已安装到当前虚拟环境，避免隔离环境联网安装依赖时卡住。
Invoke-Python -m build --no-isolation --outdir dist

Write-Host "`n== 5/5 生成校验和并校验产物 ==" -ForegroundColor Yellow
$artifacts = Get-ChildItem -Path (Join-Path $Root "dist") -File |
    Where-Object { $_.Name -like "omicslab-*" }
if (-not $artifacts) {
    throw "构建完成但 dist/ 下没有产物"
}
$lines = foreach ($file in $artifacts) {
    $hash = (Get-FileHash -Algorithm SHA256 -Path $file.FullName).Hash.ToLowerInvariant()
    "$hash  $($file.Name)"
}
$sumsPath = Join-Path $Root "dist\SHA256SUMS.txt"
# 以 UTF-8 无 BOM 写入：BOM 会污染首行哈希，导致校验和校验失败。
[System.IO.File]::WriteAllLines($sumsPath, $lines, (New-Object System.Text.UTF8Encoding($false)))
Write-Host "已写入 $sumsPath"

Invoke-Python "scripts\check_dist.py" "dist"

Write-Host "`n发布产物已生成：" -ForegroundColor Green
Get-ChildItem -Path (Join-Path $Root "dist") -File | ForEach-Object {
    Write-Host ("  {0,-45} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB)) -ForegroundColor Green
}
