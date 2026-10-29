param(
  [string]$Installer = (
    Join-Path $PSScriptRoot '..\..\..\desktop\release\Eve-Setup-1.5.0-win-x64.exe'
  ),
  [string]$OutFile = (Join-Path $PSScriptRoot 'page-transitions.json'),
  [int]$FinishTimeoutSeconds = 240
)

$ErrorActionPreference = 'Stop'

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class EveInstallerPages {
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

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxLength);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxLength);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

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

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern int GetWindowLong(IntPtr hwnd, int index);

  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern IntPtr GetParent(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern int GetDlgCtrlID(IntPtr hwnd);

  [DllImport("user32.dll")]
  private static extern IntPtr GetDlgItem(IntPtr hwnd, int id);

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

  public static void ClickNative(IntPtr window, int id) {
    SendMessage(GetDlgItem(window, id), 0x00F5, IntPtr.Zero, IntPtr.Zero);
  }

  public static bool Capture(IntPtr window, IntPtr hdc) {
    return PrintWindow(window, hdc, 0);
  }

  public static void Redraw(IntPtr window) {
    RedrawWindow(window, IntPtr.Zero, IntPtr.Zero, 0x185);
  }

  public static void PhysicalClick(IntPtr window, IntPtr control) {
    SetForegroundWindow(window);
    var rect = WindowRect(control);
    SetCursorPos((rect.Left + rect.Right) / 2, (rect.Top + rect.Bottom) / 2);
    System.Threading.Thread.Sleep(30);
    mouse_event(0x0002, 0, 0, 0, UIntPtr.Zero);
    mouse_event(0x0004, 0, 0, 0, UIntPtr.Zero);
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
  $rect = [EveInstallerPages]::WindowRect($window)
  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    return $false
  }
  [EveInstallerPages]::Redraw($window)
  Start-Sleep -Milliseconds 500
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $hdc = $graphics.GetHdc()
    try {
      $captured = [EveInstallerPages]::Capture($window, $hdc)
    }
    finally {
      $graphics.ReleaseHdc($hdc)
    }
    if (-not $captured) {
      throw 'PrintWindow could not capture the installer window.'
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
  $windowRect = [EveInstallerPages]::WindowRect($window)
  foreach ($child in @([EveInstallerPages]::Children($window))) {
    if (-not [EveInstallerPages]::Visible($child)) {
      continue
    }
    $text = [EveInstallerPages]::Text($child)
    if (-not $text) {
      continue
    }
    $class = [EveInstallerPages]::ClassName($child)
    if ($class -notin @('Static', 'Button', 'Edit')) {
      continue
    }
    $rect = [EveInstallerPages]::WindowRect($child)
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
        $captured = [EveInstallerPages]::Capture($child, $hdc)
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
  $children = @([EveInstallerPages]::Children($window))
  $text = @(
    $children |
      Where-Object { [EveInstallerPages]::Visible($_) } |
      ForEach-Object { [EveInstallerPages]::Text($_) } |
      Where-Object { $_ }
  )
  $background = $children |
    Where-Object {
      [EveInstallerPages]::ClassName($_) -eq 'Static' -and
      [EveInstallerPages]::Visible($_) -and
      [EveInstallerPages]::Style($_) -eq 0x5000000E
    } |
    Select-Object -First 1
  $page = $children |
    Where-Object {
      [EveInstallerPages]::ClassName($_) -eq '#32770' -and
      [EveInstallerPages]::Visible($_) -and
      ([EveInstallerPages]::WindowRect($_).Right - [EveInstallerPages]::WindowRect($_).Left) -gt 0
    } |
    Select-Object -First 1
  $rect = if ($page) { [EveInstallerPages]::WindowRect($page) } else { $null }
  $buttons = @(
    $children |
      Where-Object { [EveInstallerPages]::ClassName($_) -eq 'Button' } |
      ForEach-Object {
        [ordered]@{
          id = [EveInstallerPages]::ControlId($_)
          text = [EveInstallerPages]::Text($_)
          visible = [EveInstallerPages]::Visible($_)
          enabled = [EveInstallerPages]::Enabled($_)
        }
      }
  )
  $allControls = @(
    $children |
      ForEach-Object {
        [ordered]@{
          id = [EveInstallerPages]::ControlId($_)
          class = [EveInstallerPages]::ClassName($_)
          text = [EveInstallerPages]::Text($_)
          visible = [EveInstallerPages]::Visible($_)
          enabled = [EveInstallerPages]::Enabled($_)
        }
      }
  )
  return [pscustomobject]@{
    text = $text
    allText = @(
      $children |
        ForEach-Object { [EveInstallerPages]::Text($_) } |
        Where-Object { $_ }
    )
    buttons = $buttons
    allControls = $allControls
    backgroundImage = if ($background) { [string][EveInstallerPages]::Image($background).ToInt64() } else { '' }
    pageWidth = if ($rect) { $rect.Right - $rect.Left } else { 0 }
    pageHeight = if ($rect) { $rect.Bottom - $rect.Top } else { 0 }
  }
}

function Find-ClickTarget([IntPtr]$window, [string]$text) {
  $children = @([EveInstallerPages]::Children($window))
  $label = $children |
    Where-Object {
      [EveInstallerPages]::Visible($_) -and
      [EveInstallerPages]::Text($_) -eq $text
    } |
    Select-Object -First 1
  if (-not $label) {
    return $null
  }
  $labelRect = [EveInstallerPages]::WindowRect($label)
  $centerX = ($labelRect.Left + $labelRect.Right) / 2
  $centerY = ($labelRect.Top + $labelRect.Bottom) / 2
  $target = $children |
    Where-Object {
      if (
        -not [EveInstallerPages]::Visible($_) -or
        [EveInstallerPages]::Text($_) -or
        [EveInstallerPages]::ClassName($_) -ne 'Static'
      ) {
        return $false
      }
      $rect = [EveInstallerPages]::WindowRect($_)
      $width = $rect.Right - $rect.Left
      $height = $rect.Bottom - $rect.Top
      return (
        $width -ge 40 -and
        $width -le 160 -and
        $height -ge 24 -and
        $height -le 60 -and
        $centerX -ge $rect.Left -and
        $centerX -le $rect.Right -and
        $centerY -ge $rect.Top -and
        $centerY -le $rect.Bottom
      )
    } |
    Select-Object -Last 1
  if ($target) {
    return $target
  }
  return $label
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
    if ($script:process.HasExited) {
      throw "Installer exited before stage appeared: $needle"
    }
    Start-Sleep -Milliseconds 50
  } while ((Get-Date) -lt $deadline)
  $visible = if ($lastSnapshot) { $lastSnapshot.text -join ' | ' } else { '' }
  $allText = if ($lastSnapshot) { $lastSnapshot.allText -join ' | ' } else { '' }
  $buttons = if ($lastSnapshot) { $lastSnapshot.buttons | ConvertTo-Json -Compress } else { '' }
  $allControls = if ($lastSnapshot) { $lastSnapshot.allControls | ConvertTo-Json -Compress } else { '' }
  throw "Installer stage did not appear within $seconds seconds: $needle; visible=$visible; allText=$allText; buttons=$buttons; allControls=$allControls"
}

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
Get-Process -Name 'Eve' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
$script:process = Start-Process -FilePath $installerPath -PassThru

try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 150
    $window = [EveInstallerPages]::TopWindows() |
      Where-Object {
        [EveInstallerPages]::ProcessId($_) -eq $script:process.Id -and
        [EveInstallerPages]::ClassName($_) -eq '#32770'
      } |
      Select-Object -First 1
  } while (-not $window -and (Get-Date) -lt $deadline)
  if (-not $window) {
    throw 'Installer window did not appear.'
  }

  $welcome = Get-Snapshot $window
  $welcomeScreenshot = Join-Path $PSScriptRoot 'installer-welcome.png'
  Save-WindowScreenshot $window $welcomeScreenshot | Out-Null
  $installControl = [EveInstallerPages]::Children($window) |
    Where-Object {
      [EveInstallerPages]::Visible($_) -and
      [EveInstallerPages]::ClassName($_) -eq 'Static' -and
      [EveInstallerPages]::Text($_) -eq '安装'
    } |
    Select-Object -First 1
  if (-not $installControl) {
    throw 'Custom install button was not found.'
  }
  [EveInstallerPages]::Click($installControl)

  $progress = Wait-ForStage $window '正在安装 Eve' 5
  $progressScreenshot = Join-Path $PSScriptRoot 'installer-progress.png'
  Save-WindowScreenshot $window $progressScreenshot | Out-Null
  $finish = Wait-ForStage $window '安装完成' $FinishTimeoutSeconds
  $finish = Wait-ForStage $window '完成' 10
  $finishScreenshot = Join-Path $PSScriptRoot 'installer-finish.png'
  Save-WindowScreenshot $window $finishScreenshot | Out-Null

  $requiredFinishText = @('安装完成', 'Eve 已准备就绪，可以开始新的科研工作。', '打开 Eve', '完成')
  $missingFinishText = @($requiredFinishText | Where-Object { $_ -notin $finish.text })
  $checks = [ordered]@{
    welcomeRendered = '安装 Eve' -in $welcome.text
    welcomeBackgroundLoaded = $welcome.backgroundImage -ne '' -and $welcome.backgroundImage -ne '0'
    customInstallClickAdvanced = $progress.pageWidth -gt 0
    progressRendered = '正在安装 Eve' -in $progress.text
    progressBackgroundLoaded = $progress.backgroundImage -ne '' -and $progress.backgroundImage -ne '0'
    noVisibleNativeButton = (
      @($welcome.buttons + $progress.buttons + $finish.buttons) |
        Where-Object { $_.visible }
    ).Count -eq 0
    finishRendered = $missingFinishText.Count -eq 0
    finishBackgroundLoaded = $finish.backgroundImage -ne '' -and $finish.backgroundImage -ne '0'
  }
  $finishControl = Find-ClickTarget $window '完成'
  if ($finishControl) {
    [EveInstallerPages]::Click($finishControl)
  }
  $exitDeadline = (Get-Date).AddSeconds(15)
  do {
    $finishExited = $script:process.HasExited
    if ($finishExited) {
      break
    }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $exitDeadline)
  $installDir = Join-Path $env:LOCALAPPDATA 'Programs\Eve'
  $checks['finishExited'] = $finishExited
  $checks['installedAppPresent'] = Test-Path -LiteralPath (Join-Path $installDir 'Eve.exe')
  $checks['uninstallerPresent'] = Test-Path -LiteralPath (Join-Path $installDir 'Uninstall Eve.exe')
  $failed = @($checks.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object Key)

  $report = [ordered]@{
    at = (Get-Date).ToUniversalTime().ToString('o')
    installer = $installerPath
    welcome = $welcome
    progress = $progress
    finish = $finish
    finishTimeoutSeconds = $FinishTimeoutSeconds
    missingFinishText = $missingFinishText
    checks = $checks
    failedChecks = $failed
    passed = $failed.Count -eq 0
    installDir = $installDir
    screenshots = [ordered]@{
      welcome = $welcomeScreenshot
      progress = $progressScreenshot
      finish = $finishScreenshot
    }
    note = 'The probe chose Finish without launching Eve so the uninstaller can run immediately.'
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
    'Installer page probe: passed={0} welcome={1}x{2} progress={3}x{4} finish={5}x{6} report={7}' -f
      $report.passed,
      $welcome.pageWidth,
      $welcome.pageHeight,
      $progress.pageWidth,
      $progress.pageHeight,
      $finish.pageWidth,
      $finish.pageHeight,
      $OutFile
  )
  if ($failed.Count -gt 0) {
    throw "Installer page checks failed: $($failed -join ', ')"
  }
}
finally {
  if (-not $script:process.HasExited) {
    $script:process.Kill()
    $script:process.WaitForExit()
  }
}
