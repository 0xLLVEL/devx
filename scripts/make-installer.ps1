# Builds the DevX release installer.
#
# Produces `target/release/bundle/nsis/DevX_<version>_x64-setup.exe`:
#
#   1. builds the workspace in release mode (desktop app, CLI, helper);
#   2. stages the CLI and helper into `apps/desktop/src-tauri/binaries/`
#      with the target-triple names the Tauri bundler expects;
#   3. runs `tauri build`, which bundles everything into the NSIS installer.
#
# The NSIS hooks in `apps/desktop/src-tauri/installer/installer-hooks.nsh`
# register the helper as a Windows service and add the CLI to the user PATH.
#>
[CmdletBinding()]
param(
    [string]$Configuration = 'release'
)

$ErrorActionPreference = 'Stop'

$scriptDir = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Definition }
$repoRoot = Split-Path -Parent $scriptDir
Set-Location $repoRoot

$targetTriple = (rustc -vV | Select-String 'host:').ToString().Split(' ')[-1]
Write-Host "==> target: $targetTriple" -ForegroundColor Cyan

# 1. Build the whole workspace in release mode.
Write-Host '==> cargo build --release' -ForegroundColor Cyan
cargo build --release
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 2. Stage the sidecar binaries under the names the bundler expects:
#    `<name>-<target-triple>.exe` inside src-tauri/binaries/.
$binDir = Join-Path $repoRoot 'apps\desktop\src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Copy-Item -Force (Join-Path $repoRoot "target\release\devx.exe") `
    (Join-Path $binDir "devx-$targetTriple.exe")
Copy-Item -Force (Join-Path $repoRoot "target\release\devx-helper.exe") `
    (Join-Path $binDir "devx-helper-$targetTriple.exe")

Write-Host "==> staged:" -ForegroundColor Cyan
Get-ChildItem $binDir | ForEach-Object { Write-Host "    $($_.Name)" }

# 3. Bundle. beforeBuildCommand runs the frontend build and typecheck.
Write-Host '==> tauri build' -ForegroundColor Cyan
Push-Location (Join-Path $repoRoot 'apps\desktop')
try {
    npx tauri build
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
    Pop-Location
}

$setup = Get-ChildItem (Join-Path $repoRoot 'target\release\bundle\nsis') -Filter '*-setup.exe' |
    Select-Object -First 1
if ($setup) {
    Write-Host "==> installer: $($setup.FullName)" -ForegroundColor Green
}
