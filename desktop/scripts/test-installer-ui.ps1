param(
  [Parameter(Mandatory = $true)][string]$PackageDir,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$InstalledDirectory = ''
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class InstallerProbe {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr root, EnumProc callback, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder b, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] static extern IntPtr ReadText(IntPtr h,uint msg,IntPtr w,StringBuilder text);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, EntryPoint="SendMessageW")] static extern IntPtr WriteText(IntPtr h,uint msg,IntPtr w,string text);
  public static bool SetWindowText(IntPtr h,string text) { return WriteText(h,0x000C,IntPtr.Zero,text)!=IntPtr.Zero; }
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out System.Drawing.Point point);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  public static IntPtr Window(int pid) { IntPtr result=IntPtr.Zero; EnumWindows((h,p)=>{ uint id; GetWindowThreadProcessId(h,out id); if(id==pid && IsWindowVisible(h) && Class(h).StartsWith("WindowsForms") && Text(h).Length>0) result=h; return true; },IntPtr.Zero); return result; }
  public static List<IntPtr> Children(IntPtr root) { var result=new List<IntPtr>(); if(root==IntPtr.Zero) return result; EnumChildWindows(root,(h,p)=>{if(IsWindowVisible(h))result.Add(h); return true;},IntPtr.Zero); return result; }
  public static string Text(IntPtr h) { var b=new StringBuilder(4096); if(Class(h).Contains(".EDIT.")) ReadText(h,0x000D,(IntPtr)b.Capacity,b); else GetWindowText(h,b,b.Capacity); return b.ToString(); }
  public static string Class(IntPtr h) { var b=new StringBuilder(256); GetClassName(h,b,b.Capacity); return b.ToString(); }
  public static void Click(IntPtr h) {
    if(h==IntPtr.Zero) throw new ArgumentException("Missing control");
    Rect rect; GetWindowRect(h,out rect); System.Drawing.Point previous; GetCursorPos(out previous);
    int x=(rect.Right-rect.Left)/2, y=(rect.Bottom-rect.Top)/2;
    try { SetCursorPos(rect.Left+x,rect.Top+y); var point=(IntPtr)((y<<16)|x); SendMessage(h,0x0201,(IntPtr)1,point); SendMessage(h,0x0202,IntPtr.Zero,point); }
    finally { SetCursorPos(previous.X,previous.Y); }
  }
}

'@
[InstallerProbe]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$PackageDir = (Resolve-Path -LiteralPath $PackageDir).Path
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
$checks = [ordered]@{'probe-completed'=$false}
function Check([string]$Name, [bool]$Value) {
  $checks[$Name] = $Value
  if (-not $Value) { throw "Check failed: $Name" }
}
function Wait-Until([scriptblock]$Probe, [int]$Seconds = 15) {
  $deadline = (Get-Date).AddSeconds($Seconds)
  do { $value = & $Probe; if ($value -and ($value -isnot [IntPtr] -or $value -ne [IntPtr]::Zero)) { return $value }; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $deadline)
  throw ('Timed out waiting for installer state: ' + (([InstallerProbe]::Children($script:window) | ForEach-Object { [InstallerProbe]::Text($_) }) -join ' | '))
}
function Control([string]$Text) { return [InstallerProbe]::Children($script:window) | Where-Object { [InstallerProbe]::Text($_) -eq $Text } | Select-Object -First 1 }
function PathField { return [InstallerProbe]::Children($script:window) | Where-Object { [InstallerProbe]::Class($_).Contains('.EDIT.') } | Select-Object -First 1 }
function Screenshot([string]$Name) {
  [InstallerProbe]::SetForegroundWindow($script:window) | Out-Null
  Start-Sleep -Milliseconds 250
  $rect = New-Object InstallerProbe+Rect
  [InstallerProbe]::GetWindowRect($script:window, [ref]$rect) | Out-Null
  $bitmap = New-Object System.Drawing.Bitmap(($rect.Right-$rect.Left),($rect.Bottom-$rect.Top))
  $g = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $g.CopyFromScreen($rect.Left,$rect.Top,0,0,$bitmap.Size)
    $bitmap.Save((Join-Path $OutDir "$Name.png"),[System.Drawing.Imaging.ImageFormat]::Png)
  } finally { $g.Dispose(); $bitmap.Dispose() }
}

# The public installer is exercised without installing over the user's app.
# Process-state transitions use a clearly identified local protocol fixture.
$fixtureDir = Join-Path $env:TEMP ('eve-installer-ui-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $fixtureDir | Out-Null
$fixtureSource = @'
using System;
using System.IO;
using System.Threading;
static class Fixture {
  static int Main() {
    string marker = Environment.GetEnvironmentVariable("EVE_INSTALLER_TEST_MARKER");
    if (!File.Exists(marker)) { File.WriteAllText(marker,"first-failure"); Thread.Sleep(600); return 17; }
    Thread.Sleep(3000);
    string command = Environment.CommandLine;
    string target = command.Substring(command.IndexOf("/D=",StringComparison.Ordinal)+3).Trim();
    Directory.CreateDirectory(Path.Combine(target,"resources","app","dist"));
    File.WriteAllText(Path.Combine(target,"Eve.exe"),"UI protocol fixture only");
    File.WriteAllText(Path.Combine(target,"resources","app","dist","build-info.json"),"{\"buildId\":\"installer-ui-protocol-fixture\"}");
    return 0;
  }
}
'@
$fixturePath = Join-Path $fixtureDir 'engine.exe'
[IO.File]::WriteAllText((Join-Path $fixtureDir 'engine.cs'),$fixtureSource)
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe "/out:$fixturePath" (Join-Path $fixtureDir 'engine.cs')
if ($LASTEXITCODE -ne 0) { throw 'Fixture compiler failed' }
$env:EVE_INSTALLER_TEST_MARKER = Join-Path $fixtureDir ('marker-'+[guid]::NewGuid().ToString('N'))
$frontend = Join-Path $PackageDir 'installer-build\EveInstaller.exe'
$app = Start-Process -FilePath $frontend -ArgumentList @('--payload',('"'+$fixturePath+'"'),'--version','1.0.0','--build','installer-ui-protocol-fixture') -PassThru
try {
  $script:window = Wait-Until { [InstallerProbe]::Window($app.Id) }
  Wait-Until { Control '安装' } | Out-Null
  Check 'welcome-controls' ([bool](Control '仅为我') -and [bool](Control '所有用户') -and [bool](Control '安装'))
  Screenshot 'installer-welcome'
  [InstallerProbe]::Click((Control '所有用户'))
  Screenshot 'installer-all-users'
  Check 'machine-scope-path' ([InstallerProbe]::Text((PathField)).StartsWith($env:ProgramFiles))
  [InstallerProbe]::Click((Control '仅为我'))
  Check 'current-user-path' ([InstallerProbe]::Text((PathField)).StartsWith($env:LOCALAPPDATA))
  [InstallerProbe]::SetWindowText((PathField),'relative-path') | Out-Null
  [InstallerProbe]::Click((Control '安装'))
  Check 'invalid-path-keeps-config' ([bool](Control '安装') -and -not (Test-Path -LiteralPath $env:EVE_INSTALLER_TEST_MARKER))
  Screenshot 'installer-invalid-path'
  $destination = Join-Path $fixtureDir 'test-app'
  [InstallerProbe]::SetWindowText((PathField),$destination) | Out-Null
  [InstallerProbe]::Click((Control '安装'))
  Wait-Until { Control '安装' } | Out-Null
  Check 'failed-engine-can-retry' ((Test-Path -LiteralPath $env:EVE_INSTALLER_TEST_MARKER) -and [bool](PathField))
  Screenshot 'installer-retry'
  [InstallerProbe]::Click((Control '安装'))
  Start-Sleep -Milliseconds 350
  Check 'running-hides-submit' (-not [bool](Control '安装'))
  Screenshot 'installer-progress'
  Wait-Until { Control '打开 Eve' } | Out-Null
  Check 'verified-completion' ([bool](Control '完成') -and -not [bool](PathField))
  Screenshot 'installer-finish'
  [InstallerProbe]::Click((Control '完成'))
  $exited = $app.WaitForExit(5000)
  Write-Output ('Frontend exited=' + $exited + ', code=' + $app.ExitCode)
  Check 'completion-exits' ($exited -and $app.ExitCode -eq 0)
  $checks['probe-completed']=$true
} finally {
  if (-not $app.HasExited) { $app.Kill(); $app.WaitForExit() }
  Remove-Item Env:EVE_INSTALLER_TEST_MARKER -ErrorAction SilentlyContinue
  [ordered]@{checks=$checks; passed=@($checks.Values | Where-Object {$_}).Count; failed=@($checks.Values | Where-Object {-not $_}).Count;
    note='Real custom installer windows. Engine failure/retry/completion use a local protocol fixture; no host installation or all-users elevation is claimed.'} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'installer-ui-results.json') -Encoding UTF8
}

if ($InstalledDirectory) {
  $InstalledDirectory = (Resolve-Path -LiteralPath $InstalledDirectory).Path
  $uninstaller = Join-Path $InstalledDirectory 'Uninstall Eve.exe'
  if (-not (Test-Path -LiteralPath $uninstaller)) { throw 'Installed uninstaller missing' }
  $before = @(Get-Process -Name EveInstaller -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  $hostProcess = Start-Process -FilePath $uninstaller -PassThru
  $uninstallChecks = [ordered]@{}
  try {
    $frontendProcess = Wait-Until { Get-Process -Name EveInstaller -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $before } | Select-Object -First 1 }
    $null = $frontendProcess.Handle
    $script:window = Wait-Until { [InstallerProbe]::Window($frontendProcess.Id) }
    Wait-Until { Control '卸载' } | Out-Null
    $uninstallChecks['welcome-controls'] = [bool](Control '取消') -and -not [bool](PathField)
    Screenshot 'uninstaller-welcome'
    [InstallerProbe]::Click((Control '取消'))
    $uninstallChecks['cancel-keeps-app'] = $frontendProcess.WaitForExit(5000) -and (Test-Path -LiteralPath (Join-Path $InstalledDirectory 'Eve.exe'))
    $hostProcess.WaitForExit(5000) | Out-Null
    $hostProcess = Start-Process -FilePath $uninstaller -PassThru
    $frontendProcess = Wait-Until { Get-Process -Name EveInstaller -ErrorAction SilentlyContinue | Where-Object { $_.Id -notin $before } | Select-Object -First 1 }
    $null = $frontendProcess.Handle
    $script:window = Wait-Until { [InstallerProbe]::Window($frontendProcess.Id) }
    [InstallerProbe]::Click((Wait-Until { Control '卸载' }))
    $uninstallChecks['running-hides-submit'] = -not [bool](Control '卸载')
    Screenshot 'uninstaller-progress'
    Wait-Until { Control '完成' } -Seconds 90 | Out-Null
    $uninstallChecks['verified-removal'] = -not (Test-Path -LiteralPath (Join-Path $InstalledDirectory 'Eve.exe')) -and -not (Test-Path -LiteralPath (Join-Path $InstalledDirectory 'resources'))
    Screenshot 'uninstaller-finish'
    [InstallerProbe]::Click((Control '完成'))
    $uninstallChecks['completion-exits'] = $frontendProcess.WaitForExit(5000) -and $frontendProcess.ExitCode -eq 0
    Write-Output ('Uninstaller frontend exit=' + $frontendProcess.ExitCode)
    $hostProcess.WaitForExit(5000) | Out-Null
  } finally {
    [ordered]@{checks=$uninstallChecks; passed=@($uninstallChecks.Values | Where-Object {$_}).Count; failed=@($uninstallChecks.Values | Where-Object {-not $_}).Count;
      note='Actual installed uninstaller windows and actual file removal; current-user scope.'} |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $OutDir 'uninstaller-ui-results.json') -Encoding UTF8
  }
  if (@($uninstallChecks.Values | Where-Object {-not $_}).Count) { throw 'Uninstaller UI checks failed' }
}
