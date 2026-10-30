param(
  [string]$OutDir = (Join-Path $PSScriptRoot '..\installer')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$pageWidth = 620
$pageHeight = 450

function Get-Color([string]$hex) {
  return [System.Drawing.ColorTranslator]::FromHtml($hex)
}

function New-RoundedPath(
  [float]$x,
  [float]$y,
  [float]$width,
  [float]$height,
  [float]$radius
) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $diameter = $radius * 2
  $path.AddArc($x, $y, $diameter, $diameter, 180, 90)
  $path.AddArc($x + $width - $diameter, $y, $diameter, $diameter, 270, 90)
  $path.AddArc(
    $x + $width - $diameter,
    $y + $height - $diameter,
    $diameter,
    $diameter,
    0,
    90
  )
  $path.AddArc($x, $y + $height - $diameter, $diameter, $diameter, 90, 90)
  $path.CloseFigure()
  return $path
}

function Fill-RoundedRect(
  $graphics,
  [string]$color,
  [float]$x,
  [float]$y,
  [float]$width,
  [float]$height,
  [float]$radius
) {
  $path = New-RoundedPath $x $y $width $height $radius
  $brush = New-Object System.Drawing.SolidBrush((Get-Color $color))
  $graphics.FillPath($brush, $path)
  $brush.Dispose()
  $path.Dispose()
}

function Stroke-RoundedRect(
  $graphics,
  [string]$color,
  [float]$x,
  [float]$y,
  [float]$width,
  [float]$height,
  [float]$radius,
  [float]$strokeWidth = 1
) {
  $path = New-RoundedPath $x $y $width $height $radius
  $pen = New-Object System.Drawing.Pen((Get-Color $color), $strokeWidth)
  $pen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Inset
  $graphics.DrawPath($pen, $path)
  $pen.Dispose()
  $path.Dispose()
}

function Draw-BrandMark($graphics) {
  Fill-RoundedRect $graphics '#171b21' 24 13 28 28 8
  $pen = New-Object System.Drawing.Pen((Get-Color '#ffffff'), [single]2.4)
  $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
  $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
  $graphics.DrawLine($pen, 39, 21, 32, 21)
  $graphics.DrawLine($pen, 32, 21, 32, 33)
  $graphics.DrawLine($pen, 32, 33, 39, 33)
  $graphics.DrawLine($pen, 32, 27, 38, 27)
  $pen.Dispose()
}

function Draw-PageChrome($graphics, [string]$kind) {
  $bounds = New-Object System.Drawing.Rectangle(0, 0, $pageWidth, $pageHeight)
  $background = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $bounds,
    (Get-Color '#fafbfc'),
    (Get-Color '#f1f3f7'),
    90
  )
  $graphics.FillRectangle($background, $bounds)
  $background.Dispose()

  Fill-RoundedRect $graphics '#eef0f4' 36 75 548 333 19
  Fill-RoundedRect $graphics '#f5f6f9' 34 71 552 333 20

  $cardPath = New-RoundedPath 32 68 556 334 18
  $cardBrush = New-Object System.Drawing.SolidBrush((Get-Color '#ffffff'))
  $graphics.FillPath($cardBrush, $cardPath)
  $cardBrush.Dispose()
  $cardPath.Dispose()
  Stroke-RoundedRect $graphics '#d9dde3' 32.5 68.5 555 333 18

  $linePen = New-Object System.Drawing.Pen((Get-Color '#e5e8ee'), 1)
  $graphics.DrawLine($linePen, 0, 54, $pageWidth, 54)
  $linePen.Dispose()

  Draw-BrandMark $graphics

  if ($kind -eq 'welcome') {
    Fill-RoundedRect $graphics '#f7f8fa' 64 151 232 70 14
    Stroke-RoundedRect $graphics '#d9dde3' 64.5 151.5 231 69 14
    Fill-RoundedRect $graphics '#f7f8fa' 324 151 232 70 14
    Stroke-RoundedRect $graphics '#d9dde3' 324.5 151.5 231 69 14

    $checkRing = New-Object System.Drawing.Pen((Get-Color '#c9d0da'), [single]1.2)
    $graphics.DrawEllipse($checkRing, 266, 163, 18, 18)
    $graphics.DrawEllipse($checkRing, 526, 163, 18, 18)
    $checkRing.Dispose()

    Fill-RoundedRect $graphics '#f7f8fa' 64 259 432 38 11
    Stroke-RoundedRect $graphics '#d9dde3' 64.5 259.5 431 37 11
    Fill-RoundedRect $graphics '#f0f2f5' 506 260 58 36 10

    $separator = New-Object System.Drawing.Pen((Get-Color '#e8ebef'), 1)
    $graphics.DrawLine($separator, 64, 331, 556, 331)
    $separator.Dispose()

    Fill-RoundedRect $graphics '#ffffff' 332 346 106 40 12
    Stroke-RoundedRect $graphics '#d9dde3' 332.5 346.5 105 39 12
    Fill-RoundedRect $graphics '#3157d5' 450 346 106 40 12
  }
  elseif ($kind -eq 'finish') {
    $iconBrush = New-Object System.Drawing.SolidBrush((Get-Color '#edf1ff'))
    $graphics.FillEllipse($iconBrush, 64, 92, 48, 48)
    $iconBrush.Dispose()

    $checkPen = New-Object System.Drawing.Pen((Get-Color '#3157d5'), [single]2.8)
    $checkPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $checkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $graphics.DrawLine($checkPen, 76, 116, 86, 126)
    $graphics.DrawLine($checkPen, 86, 126, 101, 106)
    $checkPen.Dispose()

    Fill-RoundedRect $graphics '#f7f8fa' 64 210 492 72 14
    Stroke-RoundedRect $graphics '#e8ebef' 64.5 210.5 491 71 14

    Fill-RoundedRect $graphics '#ffffff' 332 346 106 40 12
    Stroke-RoundedRect $graphics '#d9dde3' 332.5 346.5 105 39 12
    Fill-RoundedRect $graphics '#3157d5' 450 346 106 40 12
  }
  elseif ($kind -eq 'progress') {
    Fill-RoundedRect $graphics '#e8ebef' 64 210 492 8 4
    Fill-RoundedRect $graphics '#ffffff' 450 346 106 40 12
    Stroke-RoundedRect $graphics '#d9dde3' 450.5 346.5 105 39 12
  }
  elseif ($kind -eq 'uninstall') {
    Fill-RoundedRect $graphics '#f7f8fa' 64 177 492 112 14
    Stroke-RoundedRect $graphics '#e8ebef' 64.5 177.5 491 111 14

    $separator = New-Object System.Drawing.Pen((Get-Color '#e8ebef'), 1)
    $graphics.DrawLine($separator, 80, 217, 540, 217)
    $graphics.DrawLine($separator, 80, 247, 540, 247)
    $separator.Dispose()

    Fill-RoundedRect $graphics '#ffffff' 332 346 106 40 12
    Stroke-RoundedRect $graphics '#d9dde3' 332.5 346.5 105 39 12
    Fill-RoundedRect $graphics '#3157d5' 450 346 106 40 12
  }
  elseif ($kind -eq 'uninstall-finish') {
    $iconBrush = New-Object System.Drawing.SolidBrush((Get-Color '#eef0f4'))
    $graphics.FillEllipse($iconBrush, 64, 92, 48, 48)
    $iconBrush.Dispose()

    $markPen = New-Object System.Drawing.Pen((Get-Color '#4b5563'), [single]2.6)
    $markPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $markPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $graphics.DrawLine($markPen, 77, 105, 99, 127)
    $graphics.DrawLine($markPen, 99, 105, 77, 127)
    $markPen.Dispose()

    Fill-RoundedRect $graphics '#3157d5' 450 346 106 40 12
  }
}

if (-not (Test-Path -LiteralPath $OutDir)) {
  New-Item -ItemType Directory -Path $OutDir | Out-Null
}

$pages = @{
  'installerWelcome.bmp' = 'welcome'
  'installerProgress.bmp' = 'progress'
  'installerFinish.bmp' = 'finish'
  'installerUninstall.bmp' = 'uninstall'
  'installerUninstallProgress.bmp' = 'progress'
  'installerUninstallFinish.bmp' = 'uninstall-finish'
}

foreach ($entry in $pages.GetEnumerator()) {
  $bitmap = New-Object System.Drawing.Bitmap(
    $pageWidth,
    $pageHeight,
    [System.Drawing.Imaging.PixelFormat]::Format24bppRgb
  )
  $bitmap.SetResolution(96, 96)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.CompositingQuality =
    [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
  $graphics.TextRenderingHint =
    [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $graphics.Clear((Get-Color '#f7f8fa'))

  Draw-PageChrome $graphics $entry.Value

  $graphics.Dispose()
  $bitmap.Save(
    (Join-Path $OutDir $entry.Key),
    [System.Drawing.Imaging.ImageFormat]::Bmp
  )
  $bitmap.Dispose()
}

Write-Output "Generated Eve installer surfaces in $OutDir"
