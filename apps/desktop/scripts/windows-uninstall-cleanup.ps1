[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [string]$AppExecutableName = "",
  [string]$PackageChannel = "stable",
  [string]$CliBinDir = "",
  [switch]$SkipServiceRemoval,
  [switch]$SkipUserPathUpdate
)

$ErrorActionPreference = "Stop"

function Remove-TrailingDirectorySeparators([string]$Value) {
  $root = [System.IO.Path]::GetPathRoot($Value)
  $minimumLength = if ($null -eq $root) { 0 } else { $root.Length }
  while (
    $Value.Length -gt $minimumLength -and
    ($Value.EndsWith("\", [System.StringComparison]::Ordinal) -or
      $Value.EndsWith("/", [System.StringComparison]::Ordinal))
  ) {
    $Value = $Value.Substring(0, $Value.Length - 1)
  }
  return $Value
}

function Resolve-NormalizedPath([string]$Value) {
  $fullPath = [System.IO.Path]::GetFullPath($Value)
  if (-not ("Ade.Windows.PathNormalization" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace Ade.Windows {
  public static class PathNormalization {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetLongPathName(
      string shortPath, StringBuilder longPath, uint bufferLength);
  }
}
"@ | Out-Null
  }

  # GetFullPath resolves relative segments but does not consistently expand
  # DOS 8.3 names under Windows PowerShell. GetLongPathName makes an existing
  # path compare identically whether NSIS, Node, or the user supplied its short
  # or long spelling. Nonexistent paths retain their normalized full spelling.
  $buffer = New-Object System.Text.StringBuilder 32768
  $length = [Ade.Windows.PathNormalization]::GetLongPathName(
    $fullPath,
    $buffer,
    [uint32]$buffer.Capacity
  )
  if ($length -gt 0 -and $length -lt $buffer.Capacity) {
    $fullPath = $buffer.ToString()
  }
  return Remove-TrailingDirectorySeparators $fullPath
}

function Test-CliShimOwnedByInstall(
  [string]$ShimPath,
  [string]$ExpectedCliDir
) {
  $contents = Get-Content -LiteralPath $ShimPath -Raw -ErrorAction Stop
  foreach ($line in ($contents -split "`r?`n")) {
    $match = [System.Text.RegularExpressions.Regex]::Match(
      $line,
      '^\s*"(?<target>[^"]+\.cmd)"\s+%\*\s*$',
      [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
    )
    if (-not $match.Success) { continue }

    $targetPath = $match.Groups["target"].Value
    if (-not [string]::Equals(
      [System.IO.Path]::GetFileName($targetPath),
      "ade.cmd",
      [System.StringComparison]::OrdinalIgnoreCase
    )) { continue }

    try {
      $targetDir = Resolve-NormalizedPath ([System.IO.Path]::GetDirectoryName($targetPath))
      if ([string]::Equals(
        $targetDir,
        $ExpectedCliDir,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        return $true
      }
    } catch {
      # An invalid command target is not owned by this installation.
    }
  }
  return $false
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
$normalizedPackageChannel = $PackageChannel.Trim().ToLowerInvariant()
if (@("stable", "alpha", "beta") -notcontains $normalizedPackageChannel) {
  throw "Unsupported ADE package channel: $PackageChannel"
}

if (-not $SkipServiceRemoval) {
  $normalizedAppExecutableName = [System.IO.Path]::GetFileName($AppExecutableName)
  if (
    [string]::IsNullOrWhiteSpace($normalizedAppExecutableName) -or
    -not [string]::Equals($normalizedAppExecutableName, $AppExecutableName, [System.StringComparison]::Ordinal) -or
    -not $normalizedAppExecutableName.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)
  ) {
    throw "The installer did not provide a valid ADE executable name."
  }

  $appExe = Join-Path $resolvedInstallDir $normalizedAppExecutableName
  $cliPath = Join-Path $resolvedInstallDir "resources\ade-cli\cli.cjs"
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    throw "Cannot remove the ADE background service because $normalizedAppExecutableName is missing from $resolvedInstallDir."
  }
  if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    throw "Cannot remove the ADE background service because the packaged CLI is missing from $resolvedInstallDir."
  }

  $electronRunAsNodePresent = Test-Path Env:ELECTRON_RUN_AS_NODE
  $electronRunAsNode = $env:ELECTRON_RUN_AS_NODE
  $disableCliInstallPresent = Test-Path Env:ADE_DISABLE_CLI_AUTO_INSTALL
  $disableCliInstall = $env:ADE_DISABLE_CLI_AUTO_INSTALL
  $packageChannelPresent = Test-Path Env:ADE_PACKAGE_CHANNEL
  $previousPackageChannel = $env:ADE_PACKAGE_CHANNEL
  $adeHomePresent = Test-Path Env:ADE_HOME
  $previousAdeHome = $env:ADE_HOME
  $nodePathPresent = Test-Path Env:NODE_PATH
  $previousNodePath = $env:NODE_PATH
  try {
    $env:ELECTRON_RUN_AS_NODE = "1"
    $env:ADE_DISABLE_CLI_AUTO_INSTALL = "1"
    $env:ADE_PACKAGE_CHANNEL = $normalizedPackageChannel
    $homeName = if ($normalizedPackageChannel -eq "stable") { ".ade" } else { ".ade-$normalizedPackageChannel" }
    $env:ADE_HOME = Join-Path ([System.Environment]::GetFolderPath("UserProfile")) $homeName
    $resourcesDir = Join-Path $resolvedInstallDir "resources"
    $nodePathEntries = @(
      (Join-Path $resourcesDir "app.asar.unpacked\node_modules")
      (Join-Path $resourcesDir "app.asar\node_modules")
      if (-not [string]::IsNullOrWhiteSpace($previousNodePath)) { $previousNodePath }
    )
    $env:NODE_PATH = $nodePathEntries -join [System.IO.Path]::PathSeparator
    $cleanupProcess = Start-Process `
      -FilePath $appExe `
      -ArgumentList @("`"$cliPath`"", "serve", "--uninstall-service") `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    if ($cleanupProcess.ExitCode -ne 0) {
      throw "The ADE background service cleanup command exited with code $($cleanupProcess.ExitCode)."
    }
  } finally {
    Restore-EnvironmentValue "ELECTRON_RUN_AS_NODE" $electronRunAsNode $electronRunAsNodePresent
    Restore-EnvironmentValue "ADE_DISABLE_CLI_AUTO_INSTALL" $disableCliInstall $disableCliInstallPresent
    Restore-EnvironmentValue "ADE_PACKAGE_CHANNEL" $previousPackageChannel $packageChannelPresent
    Restore-EnvironmentValue "ADE_HOME" $previousAdeHome $adeHomePresent
    Restore-EnvironmentValue "NODE_PATH" $previousNodePath $nodePathPresent
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
    if (Test-CliShimOwnedByInstall $shim.FullName $packagedCliDir) {
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
