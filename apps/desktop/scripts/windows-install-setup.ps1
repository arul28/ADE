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

# Runs the CLI with its stderr dropped and returns its stdout as one string.
# Windows PowerShell 5.1 turns a redirected native stderr line into a
# terminating error under "Stop"; a warning the CLI prints must not fail the
# install, so the preference is "Continue" in this scope only. The exit code
# decides: $LASTEXITCODE is still the CLI's when this returns.
function Invoke-CliQuiet([string[]]$Arguments) {
  $ErrorActionPreference = "Continue"
  & $cliWrapper @Arguments 2>$null | Out-String
}

# Appends one timing line per install step to <ADE_HOME>/runtime/install-steps.log.
#
# The installer is the one part of an ADE update that leaves no account of
# itself: electron-builder's common.nsh sets `ShowInstDetails nevershow`, NSIS
# writes no log, and the desktop app is not running, so the minutes between
# `autoUpdate.quit_and_install` and the new version's first event could only be
# attributed by reading file mtimes afterwards. These lines close that gap.
#
# Never fatal, and never a reason an install fails: a step that cannot write its
# own timing still did its work.
function Write-AdeInstallStep([string]$Step, [double]$Seconds, [string]$Detail = "") {
  try {
    if ([string]::IsNullOrWhiteSpace($env:ADE_HOME)) { return }
    $logDir = Join-Path $env:ADE_HOME "runtime"
    if (-not (Test-Path -LiteralPath $logDir -PathType Container)) {
      New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $line = "{0} install-setup {1} {2:N2}s{3}" -f `
      ([DateTime]::UtcNow.ToString("o")), $Step, $Seconds, $(if ($Detail) { " $Detail" } else { "" })
    Add-Content -LiteralPath (Join-Path $logDir "install-steps.log") -Value $line -Encoding UTF8
  } catch {
    # Best effort only.
  }
}

# Runs one install step, timing it, and records how long it took either way.
#
# A native command that exits nonzero does NOT throw, not even under
# `$ErrorActionPreference = "Stop"` -- every caller here checks $LASTEXITCODE
# itself, right after this returns. So the exit code is read here too: a step
# that failed must not be logged as "ok", or the log we added to attribute a slow
# or broken install would be the one thing lying about it. Only cmdlets run
# between the body and that read, so $LASTEXITCODE still belongs to the body when
# the caller sees it.
function Invoke-AdeTimedStep([string]$Step, [scriptblock]$Body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    & $Body
    $sw.Stop()
    $exit = $LASTEXITCODE
    if (($exit -is [int]) -and ($exit -ne 0)) {
      Write-AdeInstallStep $Step $sw.Elapsed.TotalSeconds "failed exit=$exit"
    } else {
      Write-AdeInstallStep $Step $sw.Elapsed.TotalSeconds "ok"
    }
  } catch {
    $sw.Stop()
    Write-AdeInstallStep $Step $sw.Elapsed.TotalSeconds "failed"
    throw
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

  $serviceStatusJson = $null
  Invoke-AdeTimedStep "service_status_read" {
    $script:serviceStatusJson = Invoke-CliQuiet @("serve", "--service-status", "--json")
  }
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

  Invoke-AdeTimedStep "path_shim_install" { & $pathInstaller $cliTarget }
  if ($LASTEXITCODE -ne 0) {
    throw "The ADE terminal command installer exited with code $LASTEXITCODE."
  }
  # `brain start`, NOT `serve --install-service`: the latter registers the
  # service at whatever ADE_DEFAULT_ROLE happens to be, which is unset here,
  # so the brain came up as role `agent` and refused the desktop app and the
  # phone (role `cto`) until the app re-registered it. `brain start` pins
  # `cto`, the same as `install-runtime.ps1`.
  Invoke-AdeTimedStep "brain_start" { & $cliWrapper brain start }
  if ($LASTEXITCODE -ne 0) {
    throw "The ADE per-user brain startup installer exited with code $LASTEXITCODE."
  }
} catch {
  $setupError = $_
  $rollbackErrors = [Collections.Generic.List[string]]::new()
  if ($serviceStateKnown) {
    # Restoring an installed service goes through `brain start` for the same
    # `cto` reason as the install step above.
    if ($previousServiceInstalled) {
      Invoke-CliQuiet @("brain", "start") | Out-Null
    } else {
      Invoke-CliQuiet @("serve", "--uninstall-service") | Out-Null
    }
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
