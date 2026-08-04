[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [Parameter(Mandatory = $true)]
  [string]$AppExecutableName,
  [ValidateSet("stable", "beta", "alpha")]
  [string]$PackageChannel = "stable"
)

$ErrorActionPreference = "Stop"

function Restore-ProcessValue([string]$Name, [string]$Value, [bool]$WasPresent) {
  [Environment]::SetEnvironmentVariable($Name, $(if ($WasPresent) { $Value } else { $null }), "Process")
}

function Get-ShortSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").Substring(0, 12).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Stop-BrainProcessPreservingStartup([string]$HomePath, [string]$Channel) {
  $serviceName = if ($Channel -eq "stable") { "com.ade.runtime" } else { "com.ade.runtime.$Channel" }
  $launcherPath = Join-Path $HomePath "runtime\brain-service-$(Get-ShortSha256 $serviceName).ps1"
  foreach ($process in @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.Name -match '^powershell(?:\.exe)?$' -and
      ([string]$_.CommandLine).IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })) {
    & taskkill.exe /PID ([string]$process.ProcessId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not restore the previous stopped ADE brain state."
    }
  }
}

$resolvedInstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
$normalizedExecutableName = [IO.Path]::GetFileName($AppExecutableName)
if (-not [string]::Equals($normalizedExecutableName, $AppExecutableName, [StringComparison]::Ordinal) -or
    -not $normalizedExecutableName.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
  throw "The installer did not provide a valid ADE executable name."
}

$appExe = Join-Path $resolvedInstallDir $normalizedExecutableName
$cliRoot = Join-Path $resolvedInstallDir "resources\ade-cli"
$cliName = if ($PackageChannel -eq "stable") { "ade.cmd" } else { "ade-$PackageChannel.cmd" }
$cliWrapper = Join-Path $cliRoot "bin\$cliName"
$pathInstaller = Join-Path $cliRoot "install-path.cmd"
$cleanupScript = Join-Path $cliRoot "windows-uninstall-cleanup.ps1"
$cliTarget = if ([string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
  throw "LOCALAPPDATA is unavailable; ADE cannot safely install its terminal command."
} else {
  Join-Path $env:LOCALAPPDATA "ADE\bin\$cliName"
}
$cliTargetExisted = Test-Path -LiteralPath $cliTarget -PathType Leaf
$previousCliTargetBytes = if ($cliTargetExisted) { [IO.File]::ReadAllBytes($cliTarget) } else { $null }
$previousUserPath = [Environment]::GetEnvironmentVariable("Path", "User")

foreach ($required in @($appExe, $cliWrapper, $pathInstaller, $cleanupScript, (Join-Path $cliRoot "cli.cjs"))) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
    throw "The packaged ADE install is incomplete: missing $required"
  }
}

$saved = @{}
foreach ($name in @(
  "ADE_BIN", "ADE_HOME", "ADE_PACKAGE_CHANNEL", "ADE_DESKTOP_APP_NAME",
  "ADE_DISABLE_CLI_AUTO_INSTALL", "ELECTRON_RUN_AS_NODE", "NODE_PATH"
)) {
  $saved[$name] = @{ Present = Test-Path "Env:$name"; Value = [Environment]::GetEnvironmentVariable($name, "Process") }
}

$previousServiceInstalled = $false
$previousServiceRunning = $false
$serviceStateKnown = $false

try {
  $env:ADE_BIN = $cliWrapper
  $env:ADE_PACKAGE_CHANNEL = $PackageChannel
  $env:ADE_DESKTOP_APP_NAME = [IO.Path]::GetFileNameWithoutExtension($normalizedExecutableName)
  $env:ADE_DISABLE_CLI_AUTO_INSTALL = "1"
  $env:ELECTRON_RUN_AS_NODE = "1"
  $homeName = if ($PackageChannel -eq "stable") { ".ade" } else { ".ade-$PackageChannel" }
  $env:ADE_HOME = Join-Path ([Environment]::GetFolderPath("UserProfile")) $homeName
  $resourcesDir = Join-Path $resolvedInstallDir "resources"
  $nodePathEntries = @(
    (Join-Path $resourcesDir "app.asar.unpacked\node_modules")
    (Join-Path $resourcesDir "app.asar\node_modules")
    if (-not [string]::IsNullOrWhiteSpace($saved.NODE_PATH.Value)) { $saved.NODE_PATH.Value }
  )
  $env:NODE_PATH = $nodePathEntries -join [IO.Path]::PathSeparator

  $serviceStatusJson = (& $cliWrapper serve --service-status --json 2>$null | Out-String)
  if ($LASTEXITCODE -ne 0) {
    throw "The ADE per-user brain startup state could not be read before setup."
  }
  try {
    $serviceStatus = $serviceStatusJson | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "The ADE per-user brain startup state was invalid before setup."
  }
  if ($serviceStatus.installed -isnot [bool]) {
    throw "The ADE per-user brain startup state was incomplete before setup."
  }
  if ($serviceStatus.running -isnot [bool]) {
    throw "The ADE per-user brain running state was incomplete before setup."
  }
  $previousServiceInstalled = $serviceStatus.installed
  $previousServiceRunning = $serviceStatus.running
  $serviceStateKnown = $true

  & $pathInstaller $cliTarget
  if ($LASTEXITCODE -ne 0) {
    throw "The ADE terminal command installer exited with code $LASTEXITCODE."
  }
  & $cliWrapper serve --install-service
  if ($LASTEXITCODE -ne 0) {
    throw "The ADE per-user brain startup installer exited with code $LASTEXITCODE."
  }
} catch {
  $setupError = $_
  $rollbackErrors = [Collections.Generic.List[string]]::new()
  if ($serviceStateKnown) {
    $rollbackServiceFlag = if ($previousServiceInstalled) { "--install-service" } else { "--uninstall-service" }
    & $cliWrapper serve $rollbackServiceFlag 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      $rollbackErrors.Add("could not restore the previous brain startup state (exit $LASTEXITCODE)")
    } elseif ($previousServiceInstalled -and -not $previousServiceRunning) {
      try {
        Stop-BrainProcessPreservingStartup $env:ADE_HOME $PackageChannel
      } catch {
        $rollbackErrors.Add($_.Exception.Message)
      }
    }
  }
  try {
    if ($cliTargetExisted) {
      $cliTargetParent = Split-Path $cliTarget -Parent
      New-Item -ItemType Directory -Path $cliTargetParent -Force | Out-Null
      [IO.File]::WriteAllBytes($cliTarget, $previousCliTargetBytes)
    } else {
      Remove-Item -LiteralPath $cliTarget -Force -ErrorAction SilentlyContinue
    }
  } catch {
    $rollbackErrors.Add("could not restore the previous terminal shim: $($_.Exception.Message)")
  }
  try {
    $currentUserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not [string]::Equals($currentUserPath, $previousUserPath, [StringComparison]::Ordinal)) {
      [Environment]::SetEnvironmentVariable("Path", $previousUserPath, "User")
    }
  } catch {
    $rollbackErrors.Add("could not restore the previous user PATH: $($_.Exception.Message)")
  }
  if ($rollbackErrors.Count -gt 0) {
    throw "ADE setup failed ($($setupError.Exception.Message)) and compensation failed: $($rollbackErrors -join '; ')"
  }
  throw $setupError
} finally {
  foreach ($name in $saved.Keys) {
    Restore-ProcessValue $name $saved[$name].Value $saved[$name].Present
  }
}
