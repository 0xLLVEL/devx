<#
.SYNOPSIS
    Generates the DevX E2 (`./`) brand assets.

.DESCRIPTION
    Concept E2: a `./` slash-run mark — an orange dot plus a navy slash.
    Produces, per -Variant:
      App        1024x1024 PNG with a navy tile (assets/app-icon.png), the
                 single source of truth for `npm run tauri icon`.
      TrayLight  64x64 transparent PNG, navy slash + orange dot, for light
                 taskbars (assets/tray-icon-light.png).
      TrayDark   64x64 transparent PNG, white slash + coral dot, for dark
                 taskbars (assets/tray-icon-dark.png).

    Run `npm run tauri icon ../../assets/app-icon.png` from `apps/desktop`
    after changing this script to regenerate every platform icon variant.

    Kept as a script (rather than committing opaque binaries) so the icon is
    reviewable and reproducible.
#>
[CmdletBinding()]
param(
    [ValidateSet('App', 'TrayLight', 'TrayDark')]
    [string]$Variant = 'App',
    [string]$OutputPath,
    [int]$Size = 0
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$repoRoot = Split-Path -Parent $scriptDir

$navy = [System.Drawing.Color]::FromArgb(255, 15, 23, 42)
$orange = [System.Drawing.Color]::FromArgb(255, 194, 65, 12)
$coral = [System.Drawing.Color]::FromArgb(255, 255, 107, 90)
$white = [System.Drawing.Color]::FromArgb(255, 255, 255, 255)

switch ($Variant) {
    'App' {
        if ($Size -eq 0) { $Size = 1024 }
        if ([string]::IsNullOrWhiteSpace($OutputPath)) {
            $OutputPath = Join-Path $repoRoot 'assets\app-icon.png'
        }
        $tile = $true
        $tileColor = $navy
        $slashColor = $white
        $dotColor = $coral
    }
    'TrayLight' {
        if ($Size -eq 0) { $Size = 64 }
        if ([string]::IsNullOrWhiteSpace($OutputPath)) {
            $OutputPath = Join-Path $repoRoot 'assets\tray-icon-light.png'
        }
        $tile = $false
        $slashColor = $navy
        $dotColor = $orange
    }
    'TrayDark' {
        if ($Size -eq 0) { $Size = 64 }
        if ([string]::IsNullOrWhiteSpace($OutputPath)) {
            $OutputPath = Join-Path $repoRoot 'assets\tray-icon-dark.png'
        }
        $tile = $false
        $slashColor = $white
        $dotColor = $coral
    }
}

$outputDir = Split-Path -Parent $OutputPath
if (-not (Test-Path $outputDir)) {
    New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
}

$bitmap = New-Object System.Drawing.Bitmap($Size, $Size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::Transparent)

if ($tile) {
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
    $tileBrush = New-Object System.Drawing.SolidBrush($tileColor)
    $graphics.FillPath($tileBrush, $path)
}

# E2 mark on a 64-unit grid, scaled: slash (51,12)->(37,52) width 11,
# dot at (19,44) radius 8. On the tile the mark gets its own padding so it
# never touches the tile edge; tray variants use the full canvas.
if ($tile) {
    $pad = [float]($Size * 0.10)
    $ox = [float]$inset + $pad
    $oy = [float]$inset + $pad
    $unit = [float]($Size - 2.0 * ($inset + $pad)) / 64.0
} else {
    $ox = 0.0
    $oy = 0.0
    $unit = [float]$Size / 64.0
}
$pen = New-Object System.Drawing.Pen($slashColor, [float](11.0 * $unit))
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$graphics.DrawLine(
    $pen,
    $ox + [float](51.0 * $unit), $oy + [float](12.0 * $unit),
    $ox + [float](37.0 * $unit), $oy + [float](52.0 * $unit)
)
$dotBrush = New-Object System.Drawing.SolidBrush($dotColor)
$dotR = [float](8.0 * $unit)
$graphics.FillEllipse(
    $dotBrush,
    $ox + [float](19.0 * $unit) - $dotR, $oy + [float](44.0 * $unit) - $dotR,
    $dotR * 2.0, $dotR * 2.0
)

$bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)

$graphics.Dispose()
$bitmap.Dispose()
$pen.Dispose()
$dotBrush.Dispose()
if ($tile) {
    $tileBrush.Dispose()
    $path.Dispose()
}

Write-Host "Wrote $OutputPath ($Size x $Size) [$Variant]"
