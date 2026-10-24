# Read-only copy verification for SuWen vNext workspace.
# Compares SOURCE_ROOT (prototype workspace) with TARGET (desktop-vnext) using
# SHA-256, honoring the copy exclusions recorded in docs/migration/copy-verification.md.
# No file in either tree is modified.
param(
  [string]$Source = 'C:\Users\Qingyuan Zhuang\Documents\Codex\2026-10-23\c-users-qingyuan-zhuang-documents-deepseek-2\outputs\omicslab',
  [string]$Target = 'C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext',
  [string]$OutDir = 'C:\Users\Qingyuan Zhuang\Documents\Codex\SuWen\desktop-vnext\docs\research\evidence'
)
$ErrorActionPreference = 'Stop'
$exclude = '^(\.git|\.pytest_cache|\.omicslab|build|dist|omicslab\.egg-info|desktop\\node_modules|desktop\\release|desktop\\dist)(\\|$)|\\__pycache__(\\|$)'

function Get-FileMap([string]$Root) {
  $map = @{}
  Get-ChildItem -LiteralPath $Root -Recurse -File -Force | ForEach-Object {
    $rel = $_.FullName.Substring($Root.Length + 1)
    if ($rel -notmatch $exclude) {
      $map[$rel] = [pscustomobject]@{
        Path   = $rel
        Size   = $_.Length
        Sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
      }
    }
  }
  return $map
}

Write-Output 'Hashing SOURCE ...'
$src = Get-FileMap $Source
Write-Output ("SOURCE files: {0}" -f $src.Count)
Write-Output 'Hashing TARGET ...'
$tgt = Get-FileMap $Target
Write-Output ("TARGET files: {0}" -f $tgt.Count)

$ordered = $src.Keys | Sort-Object
$csvSrc = foreach ($k in $ordered) { $src[$k] }
$orderedT = $tgt.Keys | Sort-Object
$csvTgt = foreach ($k in $orderedT) { $tgt[$k] }
$csvSrc | Export-Csv -LiteralPath (Join-Path $OutDir 'audit-source-hashes.csv') -NoTypeInformation -Encoding utf8
$csvTgt | Export-Csv -LiteralPath (Join-Path $OutDir 'audit-target-hashes.csv') -NoTypeInformation -Encoding utf8

$same = 0; $diff = @(); $onlySrc = @(); $onlyTgt = @()
foreach ($k in $ordered) {
  if (-not $tgt.ContainsKey($k)) { $onlySrc += $k; continue }
  if ($src[$k].Sha256 -eq $tgt[$k].Sha256) { $same++ } else { $diff += $k }
}
foreach ($k in $orderedT) { if (-not $src.ContainsKey($k)) { $onlyTgt += $k } }

$srcBytes = ($csvSrc | Measure-Object -Property Size -Sum).Sum
$tgtBytes = ($csvTgt | Measure-Object -Property Size -Sum).Sum

Write-Output ''
Write-Output '=== COPY VERIFICATION SUMMARY ==='
Write-Output ("source_files={0}; target_files={1}; hash_identical={2}; differing={3}; only_in_source={4}; only_in_target={5}" -f $src.Count, $tgt.Count, $same, $diff.Count, $onlySrc.Count, $onlyTgt.Count)
Write-Output ("source_bytes={0}; target_bytes={1}" -f $srcBytes, $tgtBytes)
Write-Output ''
Write-Output '--- differing (modified after copy; path | source_sha | target_sha) ---'
foreach ($k in $diff) { Write-Output ("{0} | {1} | {2}" -f $k, $src[$k].Sha256, $tgt[$k].Sha256) }
Write-Output ''
Write-Output '--- only in source (not copied / excluded by rule) ---'
$onlySrc | ForEach-Object { Write-Output $_ }
Write-Output ''
Write-Output '--- only in target (created after copy) ---'
$onlyTgt | ForEach-Object { Write-Output $_ }
