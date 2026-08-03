[CmdletBinding()]
param(
  [string]$Version = $(if ($env:ADE_VERSION) { $env:ADE_VERSION } else { "latest" }),
  [string]$Repo = $(if ($env:ADE_RELEASE_REPO) { $env:ADE_RELEASE_REPO } else { "arul28/ADE" }),
  [string]$AssetDirectory = $env:ADE_RELEASE_ASSET_DIR,
  [string]$InstallDir = $env:ADE_INSTALL_DIR,
  [string]$AdeHome = $env:ADE_HOME,
  [switch]$NoService,
  [switch]$NoPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Fail([string]$Message) {
  throw "ade install: $Message"
}

function Resolve-AssetUrl([string]$Name) {
  if ($Version -eq "latest") {
    return "https://github.com/$Repo/releases/latest/download/$Name"
  }
  return "https://github.com/$Repo/releases/download/$Version/$Name"
}

function Download-Asset([string]$Name, [string]$Destination) {
  if (-not [string]::IsNullOrWhiteSpace($AssetDirectory)) {
    $source = Join-Path ([IO.Path]::GetFullPath($AssetDirectory)) $Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
      Fail "missing local runtime asset: $Name"
    }
    Copy-Item -LiteralPath $source -Destination $Destination -Force
    return
  }
  $url = Resolve-AssetUrl $Name
  if (-not $url.StartsWith("https://", [StringComparison]::OrdinalIgnoreCase)) {
    Fail "refusing non-HTTPS runtime asset URL: $url"
  }
  Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination
}

function Read-Checksum([string]$ManifestPath, [string]$AssetName) {
  $foundChecksums = @()
  foreach ($line in Get-Content -LiteralPath $ManifestPath -ErrorAction Stop) {
    if ($line -match '^([a-fA-F0-9]{64})\s+\*?(.+)$') {
      $candidate = [IO.Path]::GetFileName($Matches[2].Trim())
      if ([string]::Equals($candidate, $AssetName, [StringComparison]::Ordinal)) {
        $foundChecksums += $Matches[1].ToLowerInvariant()
      }
    }
  }
  if ($foundChecksums.Count -ne 1) {
    Fail "checksum manifest must contain exactly one entry for $AssetName"
  }
  return $foundChecksums[0]
}

function Verify-Checksum([string]$ManifestPath, [string]$AssetName, [string]$FilePath) {
  $expected = Read-Checksum $ManifestPath $AssetName
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $FilePath).Hash.ToLowerInvariant()
  if (-not [string]::Equals($expected, $actual, [StringComparison]::Ordinal)) {
    Fail "checksum mismatch for $AssetName"
  }
}

function Get-ShortSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").Substring(0, 12).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Stop-ServiceProcessPreservingRegistration([string]$HomePath) {
  $launcherPath = Join-Path $HomePath "runtime\brain-service-$(Get-ShortSha256 'com.ade.runtime').ps1"
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.Name -match '^powershell(?:\.exe)?$' -and
      ([string]$_.CommandLine).IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })) {
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Fail "could not restore the previous stopped ADE brain state"
    }
  }
}

function Set-ProcessRuntimeEnvironment([string]$HomePath, [string]$RuntimePath) {
  $env:ADE_HOME = $HomePath
  $env:ADE_PACKAGE_CHANNEL = "stable"
  $env:ADE_RUNTIME_ROOT = $RuntimePath
  $env:ADE_RUNTIME_NODE_MODULES = Join-Path $RuntimePath "node_modules"
  $env:NODE_PATH = if ([string]::IsNullOrWhiteSpace($script:PreviousNodePath)) {
    $env:ADE_RUNTIME_NODE_MODULES
  } else {
    "$($env:ADE_RUNTIME_NODE_MODULES)$([IO.Path]::PathSeparator)$script:PreviousNodePath"
  }
}

function Remove-TrailingDirectorySeparators([string]$Value) {
  $root = [IO.Path]::GetPathRoot($Value)
  $minimumLength = if ($null -eq $root) { 0 } else { $root.Length }
  while ($Value.Length -gt $minimumLength -and ($Value.EndsWith("\") -or $Value.EndsWith("/"))) {
    $Value = $Value.Substring(0, $Value.Length - 1)
  }
  return $Value
}

function Install-UserPath([string]$Directory) {
  $normalized = Remove-TrailingDirectorySeparators ([IO.Path]::GetFullPath($Directory))
  $current = [Environment]::GetEnvironmentVariable("Path", "User")
  $entries = if ([string]::IsNullOrWhiteSpace($current)) { @() } else {
    @($current -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  }
  foreach ($entry in $entries) {
    try {
      if ([string]::Equals(
        (Remove-TrailingDirectorySeparators ([IO.Path]::GetFullPath($entry))),
        $normalized,
        [StringComparison]::OrdinalIgnoreCase
      )) { return }
    } catch {}
  }
  $next = if ($entries.Count -eq 0) { $normalized } else { "$normalized;$current" }
  [Environment]::SetEnvironmentVariable("Path", $next, "User")
  try {
    if (-not ("Ade.RuntimeInstaller.EnvironmentBroadcast" -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
namespace Ade.RuntimeInstaller {
  public static class EnvironmentBroadcast {
    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd, uint message, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
"@ | Out-Null
    }
    $result = [UIntPtr]::Zero
    [void][Ade.RuntimeInstaller.EnvironmentBroadcast]::SendMessageTimeout(
      [IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, "Environment", 2, 5000, [ref]$result)
  } catch {
    Write-Warning "ADE was added to PATH, but running shells may need to be restarted."
  }
}

if ($env:PROCESSOR_ARCHITECTURE -notmatch '^(AMD64|x86_64)$' -and
    $env:PROCESSOR_ARCHITEW6432 -notmatch '^(AMD64|x86_64)$') {
  Fail "Windows x64 is required"
}
if ($Repo -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$') {
  Fail "ADE_RELEASE_REPO must be in owner/repo form"
}
if ($Version -ne "latest" -and $Version -notmatch '^v?[A-Za-z0-9_.-]+$') {
  Fail "ADE_VERSION must be latest or a release tag such as v1.2.13"
}
if (-not (Get-Command tar.exe -ErrorAction SilentlyContinue)) {
  Fail "tar.exe is required; install current Windows updates and retry"
}

if ([string]::IsNullOrWhiteSpace($AdeHome)) {
  $AdeHome = Join-Path ([Environment]::GetFolderPath("UserProfile")) ".ade"
}
$AdeHome = [IO.Path]::GetFullPath($AdeHome)
if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $InstallDir = Join-Path $AdeHome "bin"
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)

$target = "win32-x64"
$binaryAsset = "ade-$target.exe"
$nativeAsset = "ade-$target.native.tar.gz"
$runtimeDir = Join-Path $AdeHome "runtime\$target"
$destinationBinary = Join-Path $InstallDir "ade.exe"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) ("ade-install-" + [Guid]::NewGuid().ToString("N"))
$stagedBinary = Join-Path $tempRoot "ade.exe"
$stagedArchive = Join-Path $tempRoot $nativeAsset
$checksumManifest = Join-Path $tempRoot "SHA256SUMS"
$stagedRuntime = Join-Path $tempRoot "runtime"
$backupBinary = Join-Path $tempRoot "ade.previous.exe"
$backupRuntime = Join-Path $tempRoot "runtime.previous"
$script:PreviousNodePath = $env:NODE_PATH
$previousEnvironment = @{
  ADE_HOME = $env:ADE_HOME
  ADE_PACKAGE_CHANNEL = $env:ADE_PACKAGE_CHANNEL
  ADE_RUNTIME_ROOT = $env:ADE_RUNTIME_ROOT
  ADE_RUNTIME_NODE_MODULES = $env:ADE_RUNTIME_NODE_MODULES
  NODE_PATH = $env:NODE_PATH
}
$previousServiceWasStopped = $false
$previousServiceWasRunning = $false
$promotedBinary = $false
$promotedRuntime = $false
$preserveTempForRecovery = $false

try {
  New-Item -ItemType Directory -Force -Path $tempRoot, $stagedRuntime | Out-Null
  Download-Asset $binaryAsset $stagedBinary
  Download-Asset $nativeAsset $stagedArchive
  Download-Asset "SHA256SUMS" $checksumManifest
  Verify-Checksum $checksumManifest $binaryAsset $stagedBinary
  Verify-Checksum $checksumManifest $nativeAsset $stagedArchive

  & tar.exe -xzf $stagedArchive -C $stagedRuntime
  if ($LASTEXITCODE -ne 0) { Fail "failed to extract $nativeAsset" }
  if (-not (Test-Path -LiteralPath (Join-Path $stagedRuntime "node_modules") -PathType Container)) {
    Fail "native dependency archive is missing node_modules"
  }

  Set-ProcessRuntimeEnvironment $AdeHome $stagedRuntime
  & $stagedBinary --version | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "downloaded ADE runtime failed its version check" }

  if ((Test-Path -LiteralPath $destinationBinary -PathType Leaf) -and -not $NoService) {
    Set-ProcessRuntimeEnvironment $AdeHome $runtimeDir
    $serviceStatusJson = (& $destinationBinary serve --service-status --json 2>$null | Out-String)
    if ($LASTEXITCODE -ne 0) { Fail "existing ADE brain service state could not be read before update" }
    try {
      $serviceStatus = $serviceStatusJson | ConvertFrom-Json -ErrorAction Stop
    } catch {
      Fail "existing ADE brain service returned invalid status before update"
    }
    if ($serviceStatus.installed -isnot [bool]) {
      Fail "existing ADE brain service returned incomplete status before update"
    }
    if ($serviceStatus.running -isnot [bool]) {
      Fail "existing ADE brain service returned incomplete running state before update"
    }
    if ($serviceStatus.installed) {
      $previousServiceWasRunning = $serviceStatus.running
      & $destinationBinary serve --uninstall-service | Out-Null
      if ($LASTEXITCODE -ne 0) { Fail "existing ADE brain service could not be stopped for update" }
      $previousServiceWasStopped = $true
    }
  }

  New-Item -ItemType Directory -Force -Path $InstallDir, (Split-Path $runtimeDir -Parent) | Out-Null
  if (Test-Path -LiteralPath $destinationBinary -PathType Leaf) {
    Move-Item -LiteralPath $destinationBinary -Destination $backupBinary
  }
  if (Test-Path -LiteralPath $runtimeDir) {
    Move-Item -LiteralPath $runtimeDir -Destination $backupRuntime
  }
  Move-Item -LiteralPath $stagedRuntime -Destination $runtimeDir
  $promotedRuntime = $true
  Move-Item -LiteralPath $stagedBinary -Destination $destinationBinary
  $promotedBinary = $true

  Set-ProcessRuntimeEnvironment $AdeHome $runtimeDir
  & $destinationBinary --version | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "installed ADE runtime failed its version check" }
  if (-not $NoService) {
    & $destinationBinary serve --install-service | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "ADE installed, but its per-user brain service could not be registered" }
  }
  if (-not $NoPath) { Install-UserPath $InstallDir }

  Write-Output "ADE runtime installed: $destinationBinary"
  Write-Output "ADE native runtime: $runtimeDir"
  if (-not $NoPath) { Write-Output "Open a new terminal and run: ade doctor --text" }
} catch {
  $installError = $_
  $rollbackErrors = [Collections.Generic.List[string]]::new()
  if ($promotedBinary -and -not $NoService -and (Test-Path -LiteralPath $destinationBinary -PathType Leaf)) {
    try {
      Set-ProcessRuntimeEnvironment $AdeHome $runtimeDir
      & $destinationBinary serve --uninstall-service 2>$null | Out-Null
      if ($LASTEXITCODE -ne 0) { $rollbackErrors.Add("new brain service cleanup exited with code $LASTEXITCODE") }
    } catch { $rollbackErrors.Add("new brain service cleanup failed: $($_.Exception.Message)") }
  }
  try {
    if ($promotedBinary) { Remove-Item -LiteralPath $destinationBinary -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $backupBinary -PathType Leaf) {
      Move-Item -LiteralPath $backupBinary -Destination $destinationBinary -Force -ErrorAction Stop
    }
  } catch { $rollbackErrors.Add("binary restore failed: $($_.Exception.Message)") }
  try {
    if ($promotedRuntime) { Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction Stop }
    if (Test-Path -LiteralPath $backupRuntime) {
      Move-Item -LiteralPath $backupRuntime -Destination $runtimeDir -Force -ErrorAction Stop
    }
  } catch { $rollbackErrors.Add("native runtime restore failed: $($_.Exception.Message)") }
  if ($previousServiceWasStopped -and (Test-Path -LiteralPath $destinationBinary -PathType Leaf)) {
    try {
      Set-ProcessRuntimeEnvironment $AdeHome $runtimeDir
      & $destinationBinary serve --install-service | Out-Null
      if ($LASTEXITCODE -ne 0) {
        $rollbackErrors.Add("previous brain service restore exited with code $LASTEXITCODE")
      } elseif (-not $previousServiceWasRunning) {
        Stop-ServiceProcessPreservingRegistration $AdeHome
      }
    } catch { $rollbackErrors.Add("previous brain service restore failed: $($_.Exception.Message)") }
  }
  if ($rollbackErrors.Count -gt 0) {
    $preserveTempForRecovery = $true
    throw "ADE runtime install failed ($($installError.Exception.Message)); rollback also failed: $($rollbackErrors -join '; '). Recovery files were retained at $tempRoot"
  }
  throw $installError
} finally {
  foreach ($name in $previousEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], "Process")
  }
  if (-not $preserveTempForRecovery) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
