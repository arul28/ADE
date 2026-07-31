[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [string]$CliBinDir = "",
  [switch]$SkipServiceRemoval,
  [switch]$SkipUserPathUpdate
)

$ErrorActionPreference = "Stop"

function Resolve-NormalizedPath([string]$Value) {
  return [System.IO.Path]::GetFullPath($Value).TrimEnd("\")
}

function Restore-EnvironmentValue([string]$Name, [string]$Value, [bool]$WasPresent) {
  if ($WasPresent) {
    [System.Environment]::SetEnvironmentVariable($Name, $Value, "Process")
  } else {
    [System.Environment]::SetEnvironmentVariable($Name, $null, "Process")
  }
}

function Send-EnvironmentChanged {
  try {
    if (-not ("Ade.Windows.EnvironmentBroadcast" -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Ade.Windows {
  public static class EnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
"@
    }
    $result = [UIntPtr]::Zero
    [void][Ade.Windows.EnvironmentBroadcast]::SendMessageTimeout(
      [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
  } catch {
    Write-Warning "The user PATH was cleaned, but running shells may need to be restarted."
  }
}

$resolvedInstallDir = Resolve-NormalizedPath $InstallDir

if (-not $SkipServiceRemoval) {
  $appExe = Join-Path $resolvedInstallDir "ADE.exe"
  $cliPath = Join-Path $resolvedInstallDir "resources\ade-cli\cli.cjs"
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Cannot remove the ADE background service because ADE.exe is missing from $resolvedInstallDir."
  }
  if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Cannot remove the ADE background service because the packaged CLI is missing from $resolvedInstallDir."
  }

  $electronRunAsNodePresent = Test-Path Env:ELECTRON_RUN_AS_NODE
  $electronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $disableCliInstallPresent = Test-Path Env:ADE_DISABLE_CLI_AUTO_INSTALL
  $disableCliInstall = $env:ADE_DISABLE_CLI_AUTO_INSTALL
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $env:ADE_DISABLE_CLI_AUTO_INSTALL = "1"
    & $appExe $cliPath "serve" "--uninstall-service"
    if ($LASTEXITCODE -ne 0) {
      throw "The ADE background service cleanup command exited with code $LASTEXITCODE."
    }
  } finally {
    Restore-EnvironmentValue "ELECTRON_RUN_AS_NODE" $electronRunAsNode $electronRunAsNodePresent
    Restore-EnvironmentValue "ADE_DISABLE_CLI_AUTO_INSTALL" $disableCliInstall $disableCliInstallPresent
  }
}

if ([string]::IsNullOrWhiteSpace($CliBinDir)) {
  if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
    throw "LOCALAPPDATA is unavailable; ADE cannot safely locate its terminal command."
  }
  $CliBinDir = Join-Path $env:LOCALAPPDATA "ADE\bin"
}

$resolvedCliBinDir = Resolve-NormalizedPath $CliBinDir
$packagedCliDir = Resolve-NormalizedPath (Join-Path $resolvedInstallDir "resources\ade-cli\bin")
if (Test-Path -LiteralPath $resolvedCliBinDir -PathType Container) {
  foreach ($shim in Get-ChildItem -LiteralPath $resolvedCliBinDir -Filter "ade*.cmd" -File -ErrorAction Stop) {
    $contents = Get-Content -LiteralPath $shim.FullName -Raw -ErrorAction Stop
    if ($contents.IndexOf($packagedCliDir, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      Remove-Item -LiteralPath $shim.FullName -Force -ErrorAction Stop
    }
  }
}

$remainingAdeShims = @(
  if (Test-Path -LiteralPath $resolvedCliBinDir -PathType Container) {
    Get-ChildItem -LiteralPath $resolvedCliBinDir -Filter "ade*.cmd" -File -ErrorAction Stop
  }
)

if ($remainingAdeShims.Count -eq 0 -and -not $SkipUserPathUpdate) {
  $currentPath = [System.Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ([string]::IsNullOrWhiteSpace($currentPath)) {
    @()
  } else {
    @($currentPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  $keptEntries = @($entries | Where-Object {
    try {
      (Resolve-NormalizedPath $_) -ne $resolvedCliBinDir
    } catch {
      $true
    }
  })
  if ($keptEntries.Count -ne $entries.Count) {
    $nextPath = if ($keptEntries.Count -eq 0) { $null } else { $keptEntries -join ";" }
    [System.Environment]::SetEnvironmentVariable("Path", $nextPath, "User")
    Send-EnvironmentChanged
  }
}

if ($remainingAdeShims.Count -eq 0 -and (Test-Path -LiteralPath $resolvedCliBinDir -PathType Container)) {
  $remainingFiles = @(Get-ChildItem -LiteralPath $resolvedCliBinDir -Force -ErrorAction Stop)
  if ($remainingFiles.Count -eq 0) {
    Remove-Item -LiteralPath $resolvedCliBinDir -Force -ErrorAction Stop
  }
}
