<#
.SYNOPSIS
    Generates the DevX source app icon (1024x1024 PNG).

.DESCRIPTION
    Produces `assets/app-icon.png`, the single source of truth for the app icon.
    Run `npm run tauri icon ../../assets/app-icon.png` from `apps/desktop` after
    changing this script to regenerate every platform icon variant.

    Kept as a script (rather than committing an opaque binary) so the icon is
    reviewable and reproducible.
#>
[CmdletBinding()]
param(
    [string]$OutputPath,
    [int]$Size = 1024
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
    $repoRoot = Split-Path -Parent $scriptDir
    $OutputPath = Join-Path $repoRoot 'assets\app-icon.png'
}

$outputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$graphics.Clear([System.Drawing.Color]::Transparent)

# Rounded-square background with a vertical brand gradient.
$inset = [int]($Size * 0.06)
$radius = [int]($Size * 0.22)
$rect = New-Object System.Drawing.Rectangle($inset, $inset, ($Size - 2 * $inset), ($Size - 2 * $inset))

$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$d = $radius * 2
$path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
$path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
$path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
$path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
$path.CloseFigure()

$topColor = [System.Drawing.Color]::FromArgb(255, 79, 134, 247)
$bottomColor = [System.Drawing.Color]::FromArgb(255, 37, 62, 158)
$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $topColor, $bottomColor, 90)
$graphics.FillPath($brush, $path)

# Wordmark.
$fontSize = [float]($Size * 0.34)
$font = New-Object System.Drawing.Font('Segoe UI', $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = [System.Drawing.StringAlignment]::Center
$format.LineAlignment = [System.Drawing.StringAlignment]::Center
$textBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 245, 248, 255))
$graphics.DrawString('DX', $font, $textBrush, [System.Drawing.RectangleF]::new($rect.X, $rect.Y, $rect.Width, $rect.Height), $format)

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
$brush.Dispose()
$textBrush.Dispose()
$font.Dispose()
$path.Dispose()

Write-Host "Wrote $OutputPath ($Size x $Size)"
