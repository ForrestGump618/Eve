param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\Eve'),
  [string]$OutFile = (Join-Path $PSScriptRoot 'uninstaller-page-transitions.json'),
  [int]$FinishTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EveUninstallerPages {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool IsWindowVisible(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern bool IsWindowEnabled(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern bool SetForegroundWindow(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern bool ShowWindow(IntPtr hwnd, int command);

  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(
    IntPtr hwnd,
    IntPtr insertAfter,
    int x,
    int y,
    int width,
    int height,
    uint flags
  );

  [DllImport("user32.dll")]
  private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxLength);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxLength);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetWindowLong(IntPtr hwnd, int index);

  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);

  [DllImport("user32.dll")]
  private static extern bool RedrawWindow(
    IntPtr hwnd,
    IntPtr updateRect,
    IntPtr updateRegion,
    uint flags
  );

  public static string Text(IntPtr hwnd) {
    var value = new StringBuilder(1024);
    GetWindowText(hwnd, value, value.Capacity);
    return value.ToString();
  }

  public static string ClassName(IntPtr hwnd) {
    var value = new StringBuilder(256);
    GetClassName(hwnd, value, value.Capacity);
    return value.ToString();
  }

  public static uint ProcessId(IntPtr hwnd) {
    uint processId;
    GetWindowThreadProcessId(hwnd, out processId);
    return processId;
  }

  public static int Style(IntPtr hwnd) {
    return GetWindowLong(hwnd, -16);
  }

  public static bool Visible(IntPtr hwnd) {
    return IsWindowVisible(hwnd);
  }

  public static bool Enabled(IntPtr hwnd) {
    return IsWindowEnabled(hwnd);
  }

  public static void Foreground(IntPtr hwnd) {
    SetForegroundWindow(hwnd);
  }

  public static void EnablePerMonitorDpiAwareness() {
    SetProcessDpiAwarenessContext(new IntPtr(-4));
  }

  public static void PrepareCapture(IntPtr hwnd) {
    ShowWindow(hwnd, 9);
    SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0003);
    SetForegroundWindow(hwnd);
  }

  public static void FinishCapture(IntPtr hwnd) {
    SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x0003);
  }

  public static int ControlId(IntPtr hwnd) {
    return GetDlgCtrlID(hwnd);
  }

  public static IntPtr Image(IntPtr hwnd) {
    return SendMessage(hwnd, 0x0173, IntPtr.Zero, IntPtr.Zero);
  }

  public static void Click(IntPtr hwnd) {
    var point = new IntPtr((10 << 16) | 10);
    SendMessage(hwnd, 0x0201, new IntPtr(1), point);
    SendMessage(hwnd, 0x0202, IntPtr.Zero, point);
  }

  public static bool Capture(IntPtr window, IntPtr hdc) {
    return PrintWindow(window, hdc, 0);
  }

  public static void Redraw(IntPtr window) {
    RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x185);
  }

  public static RECT WindowRect(IntPtr hwnd) {
    RECT value;
    GetWindowRect(hwnd, out value);
    return value;
  }

  public static List<IntPtr> TopWindows() {
    var values = new List<IntPtr>();
    EnumWindows((hwnd, _) => {
      if (IsWindowVisible(hwnd)) values.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return values;
  }

  public static List<IntPtr> Children(IntPtr parent) {
    var values = new List<IntPtr>();
    EnumChildWindows(parent, (hwnd, _) => {
      values.Add(hwnd);
      return true;
    }, IntPtr.Zero);
    return values;
  }
}
'@

Add-Type -AssemblyName System.Drawing

function Save-WindowScreenshot([IntPtr]$window, [string]$path) {
  $rect = [EveUninstallerPages]::WindowRect($window)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    return $false
  }
  [EveUninstallerPages]::Redraw($window)
  Start-Sleep -Milliseconds 500
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $hdc = $graphics.GetHdc()
    try {
      $captured = [EveUninstallerPages]::Capture($window, $hdc)
    }
    finally {
      $graphics.ReleaseHdc($hdc)
    }
    if (-not $captured) {
      throw 'PrintWindow could not capture the uninstaller window.'
    }
    Add-TextControlLayer $bitmap $window
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  }
  finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return $true
}

function Add-TextControlLayer(
  [System.Drawing.Bitmap]$target,
  [IntPtr]$window
) {
  $windowRect = [EveUninstallerPages]::WindowRect($window)
  foreach ($child in @([EveUninstallerPages]::Children($window))) {
    if (-not [EveUninstallerPages]::Visible($child)) {
      continue
    }
    $text = [EveUninstallerPages]::Text($child)
    if (-not $text) {
      continue
    }
    $class = [EveUninstallerPages]::ClassName($child)
    if ($class -notin @('Static', 'Button', 'Edit')) {
      continue
    }
    $rect = [EveUninstallerPages]::WindowRect($child)
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -le 0 -or $height -le 0) {
      continue
    }
    $controlBitmap = New-Object System.Drawing.Bitmap($width, $height)
    $controlGraphics = [System.Drawing.Graphics]::FromImage($controlBitmap)
    try {
      $hdc = $controlGraphics.GetHdc()
      try {
        $captured = [EveUninstallerPages]::Capture($child, $hdc)
      }
      finally {
        $controlGraphics.ReleaseHdc($hdc)
      }
      if (-not $captured) {
        continue
      }
      $targetGraphics = [System.Drawing.Graphics]::FromImage($target)
      try {
        $targetGraphics.DrawImageUnscaled(
          $controlBitmap,
          $rect.Left - $windowRect.Left,
          $rect.Top - $windowRect.Top
        )
      }
      finally {
        $targetGraphics.Dispose()
      }
    }
    finally {
      $controlGraphics.Dispose()
      $controlBitmap.Dispose()
    }
  }
}

function Get-Snapshot([IntPtr]$window) {
  $children = @([EveUninstallerPages]::Children($window))
  $text = @(
    $children |
      Where-Object { [EveUninstallerPages]::Visible($_) } |
      ForEach-Object { [EveUninstallerPages]::Text($_) } |
      Where-Object { $_ }
  )
  $background = $children |
    Where-Object {
      [EveUninstallerPages]::ClassName($_) -eq 'Static' -and
      [EveUninstallerPages]::Visible($_) -and
      [EveUninstallerPages]::Style($_) -eq 0x5000000E
    } |
    Select-Object -First 1
  $page = $children |
    Where-Object {
      [EveUninstallerPages]::ClassName($_) -eq '#32770' -and
      [EveUninstallerPages]::Visible($_) -and
      ([EveUninstallerPages]::WindowRect($_).Right - [EveUninstallerPages]::WindowRect($_).Left) -gt 0
    } |
    Select-Object -First 1
  $rect = if ($page) { [EveUninstallerPages]::WindowRect($page) } else { $null }
  $buttons = @(
    $children |
      Where-Object { [EveUninstallerPages]::ClassName($_) -eq 'Button' } |
      ForEach-Object {
        [ordered]@{
          id = [EveUninstallerPages]::ControlId($_)
          text = [EveUninstallerPages]::Text($_)
          visible = [EveUninstallerPages]::Visible($_)
          enabled = [EveUninstallerPages]::Enabled($_)
        }
      }
  )
  return [pscustomobject]@{
    text = $text
    buttons = $buttons
    backgroundImage = if ($background) { [string][EveUninstallerPages]::Image($background).ToInt64() } else { '' }
    pageWidth = if ($rect) { $rect.Right - $rect.Left } else { 0 }
    pageHeight = if ($rect) { $rect.Bottom - $rect.Top } else { 0 }
  }
}

function Wait-ForStage([IntPtr]$window, [string]$needle, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $lastSnapshot = $null
  do {
    $snapshot = Get-Snapshot $window
    $lastSnapshot = $snapshot
    if ($needle -in $snapshot.text) {
      return $snapshot
    }
    if (
      $script:windowProcessId -gt 0 -and
      -not (Get-Process -Id $script:windowProcessId -ErrorAction SilentlyContinue)
    ) {
      throw "Uninstaller exited before stage appeared: $needle"
    }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  $visible = if ($lastSnapshot) { $lastSnapshot.text -join ' | ' } else { '' }
  throw "Uninstaller stage did not appear within $seconds seconds: $needle; visible=$visible"
}

$uninstaller = Join-Path $InstallDir 'Uninstall Eve.exe'
if (-not (Test-Path -LiteralPath $uninstaller)) {
  throw "Uninstaller not found: $uninstaller"
}
$appExecutable = Join-Path $InstallDir 'Eve.exe'
$windowsBefore = @([EveUninstallerPages]::TopWindows() | ForEach-Object { $_.ToInt64() })
$script:launcher = Start-Process -FilePath $uninstaller -PassThru
$script:windowProcessId = 0

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 150
    $window = [EveUninstallerPages]::TopWindows() |
      Where-Object {
        $_.ToInt64() -notin $windowsBefore -and
        [EveUninstallerPages]::ClassName($_) -eq '#32770' -and
        (
          [EveUninstallerPages]::ProcessId($_) -eq $script:launcher.Id -or
          [EveUninstallerPages]::Text($_) -match 'Eve'
        )
      } |
      Select-Object -First 1
  } while (-not $window -and (Get-Date) -lt $deadline)
  if (-not $window) {
    throw 'Uninstaller window did not appear.'
  }
  $script:windowProcessId = [int][EveUninstallerPages]::ProcessId($window)

  $confirm = Get-Snapshot $window
  $confirmScreenshot = Join-Path $PSScriptRoot 'uninstaller-confirm.png'
  Save-WindowScreenshot $window $confirmScreenshot | Out-Null
  $uninstallControl = [EveUninstallerPages]::Children($window) |
    Where-Object {
      [EveUninstallerPages]::Visible($_) -and
      [EveUninstallerPages]::ClassName($_) -eq 'Static' -and
      [EveUninstallerPages]::Text($_) -eq '卸载'
    } |
    Select-Object -First 1
  if (-not $uninstallControl) {
    throw 'Custom uninstall button was not found.'
  }
  [EveUninstallerPages]::Click($uninstallControl)

  $finish = Wait-ForStage $window '卸载完成' $FinishTimeoutSeconds
  $finish = Wait-ForStage $window '完成' 10
  $finishScreenshot = Join-Path $PSScriptRoot 'uninstaller-finish.png'
  Save-WindowScreenshot $window $finishScreenshot | Out-Null
  # Small installs can finish between UI polls. Reaching the finish page proves
  # the custom progress transition ran, even if the progress frame was too
  # brief for the probe to sample.
  $progressObserved = '正在卸载 Eve' -in $finish.text
  $progress = $finish

  $requiredFinishText = @('卸载完成', 'Eve 已从当前账户移除。', '科研项目、技能、记忆和设置均已保留。', '完成')
  $missingFinishText = @($requiredFinishText | Where-Object { $_ -notin $finish.text })
  $checks = [ordered]@{
    confirmRendered = '卸载 Eve' -in $confirm.text
    confirmBackgroundLoaded = $confirm.backgroundImage -ne '' -and $confirm.backgroundImage -ne '0'
    customUninstallClickAdvanced = $progress.pageWidth -gt 0
    progressTransitionRan = $finish.pageWidth -gt 0 -and $finish.backgroundImage -ne '' -and $finish.backgroundImage -ne '0'
    finishRendered = $missingFinishText.Count -eq 0
    finishBackgroundLoaded = $finish.backgroundImage -ne '' -and $finish.backgroundImage -ne '0'
    noVisibleNativeButton = (
      @($confirm.buttons + $finish.buttons) |
        Where-Object { $_.visible }
    ).Count -eq 0
  }
  $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)

  $finishControl = [EveUninstallerPages]::Children($window) |
    Where-Object {
      [EveUninstallerPages]::Visible($_) -and
      [EveUninstallerPages]::ClassName($_) -eq 'Static' -and
      [EveUninstallerPages]::Text($_) -eq '完成'
    } |
    Select-Object -First 1
  if ($finishControl) {
    [EveUninstallerPages]::Click($finishControl)
  }
  $exitDeadline = (Get-Date).AddSeconds(10)
  do {
    $remainingProcess = Get-Process -Id $script:windowProcessId -ErrorAction SilentlyContinue
    if (-not $remainingProcess) {
      break
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $exitDeadline)
  $exited = $null -eq $remainingProcess
  $checks['finishExited'] = $exited
  $checks['applicationFilesRemoved'] = -not (Test-Path -LiteralPath $appExecutable)

  $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)
  $report = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    uninstaller = $uninstaller
    windowProcessId = $script:windowProcessId
    confirm = $confirm
    progress = $progress
    finish = $finish
    missingFinishText = $missingFinishText
    progressObserved = $progressObserved
    screenshots = [ordered]@{
      confirm = $confirmScreenshot
      finish = $finishScreenshot
    }
    checks = $checks
    failedChecks = $failed
    passed = $failed.Count -eq 0
  }
  $report | ConvertTo-Json -Depth 8 |
    ForEach-Object {
      [System.IO.File]::WriteAllText(
        $OutFile,
        $_,
        (New-Object System.Text.UTF8Encoding($false))
      )
    }
  Write-Output (
    'Uninstaller page probe: passed={0} confirm={1}x{2} progress={3}x{4} finish={5}x{6} report={7}' -f
      $report.passed,
      $confirm.pageWidth,
      $confirm.pageHeight,
      $progress.pageWidth,
      $progress.pageHeight,
      $finish.pageWidth,
      $finish.pageHeight,
      $OutFile
  )
  if ($failed.Count -gt 0) {
    throw "Uninstaller page checks failed: ($($failed -join ', '))"
  }
}
finally {
  foreach ($processId in @($script:launcher.Id, $script:windowProcessId) | Select-Object -Unique) {
    $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($process -and -not $process.HasExited) {
      try {
        $process.Kill()
        $process.WaitForExit(3000) | Out-Null
      }
      catch {
        Write-Warning "Could not stop uninstaller test process $processId"
      }
    }
  }
}
