[CmdletBinding()]
param(
  [string]$Version = $(if ($env:ADE_VERSION) { $env:ADE_VERSION } else { "latest" }),
  [string]$Repo = $(if ($env:ADE_RELEASE_REPO) { $env:ADE_RELEASE_REPO } else { "arul28/ADE" }),
  [string]$AssetDirectory = $env:ADE_RELEASE_ASSET_DIR,
  [string]$InstallDir = $env:ADE_INSTALL_DIR,
  [string]$AdeHome = $env:ADE_HOME,
  [switch]$NoService,
  # `irm ... | iex` cannot take parameters, so the env var is the only way to
  # opt out on the one-liner we actually promote.
  [switch]$NoPath = ($env:ADE_INSTALL_NO_PATH -eq "1"),
  [switch]$NoPrompt
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

# Only these first two steps live in PowerShell -- everything after the runtime
# exists on disk is handed to `ade setup`, which renders the remaining steps and
# the summary once, in TypeScript, for both platforms.
$script:StepAnsi = $false
try {
  # IsErrorRedirected, not IsOutputRedirected: the progress line and step lines
  # are written to [Console]::Error, so stderr is the stream that decides
  # whether an in-place redraw is safe.
  $script:StepAnsi = [Console]::IsErrorRedirected -eq $false -and $Host.UI.SupportsVirtualTerminal
} catch {
  $script:StepAnsi = $false
}
$script:DownloadedBytes = 0
$script:ActiveLine = $false
# Started here so the summary's elapsed time covers the whole install, not just
# the `ade setup` half that renders it.
$script:InstallStopwatch = [Diagnostics.Stopwatch]::StartNew()

function Format-AdeBytes([double]$Bytes) {
  if ($Bytes -lt 1MB) { return "{0:N0} KB" -f ($Bytes / 1KB) }
  if ($Bytes -lt 1GB) { return "{0:N1} MB" -f ($Bytes / 1MB) }
  return "{0:N1} GB" -f ($Bytes / 1GB)
}

function Write-AdeBanner {
  Write-Host ""
  Write-Host "     _    ____  _____"
  Write-Host "    / \  |  _ \| ____|"
  Write-Host "   / _ \ | | | |  _|"
  Write-Host "  / ___ \| |_| | |___"
  Write-Host " /_/   \_\____/|_____|"
  Write-Host ""
}

# Clears the in-place progress line before any static output, so a completed
# step never prints on top of a half-drawn bar.
function Clear-AdeActiveLine {
  if (-not $script:ActiveLine) { return }
  $script:ActiveLine = $false
  if ($script:StepAnsi) {
    [Console]::Error.Write("`r" + (" " * 78) + "`r")
  }
}

function Write-AdeStep([string]$Symbol, [string]$Label, [string]$Detail) {
  Clear-AdeActiveLine
  [Console]::Error.WriteLine(("  {0} {1} {2}" -f $Symbol, $Label.PadRight(20), $Detail).TrimEnd())
}

function Write-AdeProgress([string]$Label, [double]$Received, [double]$Total) {
  if (-not $script:StepAnsi) { return }
  if ($Total -gt 0) {
    $fraction = [Math]::Max(0.0, [Math]::Min(1.0, $Received / $Total))
    $filled = [int][Math]::Round($fraction * 12)
    $bar = ("#" * $filled) + ("." * (12 - $filled))
    $line = "  {0}  {1,3}%  {2} - {3}/{4}" -f $bar, [int]($fraction * 100), $Label,
      (Format-AdeBytes $Received), (Format-AdeBytes $Total)
  } else {
    $line = "  > {0} - {1}" -f $Label, (Format-AdeBytes $Received)
  }
  if ($line.Length -gt 78) { $line = $line.Substring(0, 78) }
  [Console]::Error.Write("`r" + $line.PadRight(78))
  $script:ActiveLine = $true
}

# Streams the body so a 118 MB download reports bytes instead of sitting silent.
# `Invoke-WebRequest` cannot do this here: the script sets
# $ProgressPreference = SilentlyContinue (required, or its own progress bar
# corrupts the console under `irm | iex`), which also suppresses any feedback.
function Download-Asset(
  [string]$Name,
  [string]$Destination,
  [string]$ProgressLabel = ""
) {
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
  if ([string]::IsNullOrWhiteSpace($ProgressLabel)) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination
    return
  }

  Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
  # The Add-Type above is allowed to fail quietly, but the type resolution below
  # is not: under $ErrorActionPreference = "Stop" it throws from inside the main
  # install try block, so a host without the assembly would take the ROLLBACK
  # path instead of just losing its progress bar. Degrade to a plain download.
  if (-not ("System.Net.Http.HttpClient" -as [type])) {
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $Destination
    $script:DownloadedBytes += (Get-Item -LiteralPath $Destination).Length
    return
  }

  $client = [Net.Http.HttpClient]::new()
  try {
    $client.Timeout = [TimeSpan]::FromMinutes(30)
    $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead).
      GetAwaiter().GetResult()
    try {
      if (-not $response.IsSuccessStatusCode) {
        Fail "download failed for $Name (HTTP $([int]$response.StatusCode))"
      }
      $total = if ($response.Content.Headers.ContentLength) {
        [double]$response.Content.Headers.ContentLength
      } else { 0 }
      # Not $input: that is PowerShell's automatic pipeline enumerator, and
      # assigning to it shadows the real one for the rest of the scope.
      $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
      $output = [IO.File]::Create($Destination)
      try {
        $buffer = [byte[]]::new(1MB)
        $received = 0.0
        $lastReport = [Environment]::TickCount
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $output.Write($buffer, 0, $read)
          $received += $read
          # Throttled: redrawing on every 1 MB chunk costs more than the socket.
          if (([Environment]::TickCount - $lastReport) -ge 100) {
            $lastReport = [Environment]::TickCount
            Write-AdeProgress $ProgressLabel $received $total
          }
        }
        Write-AdeProgress $ProgressLabel $received $total
        $script:DownloadedBytes += $received
      } finally {
        $output.Dispose()
        $stream.Dispose()
      }
    } finally {
      $response.Dispose()
    }
  } finally {
    $client.Dispose()
  }
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

# Prompting is only safe when a real console is attached. `irm | iex` keeps the
# console on stdin (the script text arrives over the pipeline, not stdin), so
# Read-Host works there; CI and redirected-stdin hosts must fall through to the
# printed follow-up commands instead.
function Test-AdeInteractive {
  if ($NoPrompt) { return $false }
  if ($env:ADE_INSTALL_NO_PROMPT -eq "1") { return $false }
  try {
    if (-not [Environment]::UserInteractive) { return $false }
    if ([Console]::IsInputRedirected) { return $false }
  } catch {
    return $false
  }
  return $true
}

# Prompting, desktop-installer discovery and its SHA-512 verification all moved
# into `ade setup` (apps/ade-cli/src/commands/setup*.ts) so Windows and macOS
# share one implementation. This script now owns only what has to happen before
# the `ade` binary exists on disk.

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
$installSucceeded = $false

try {
  New-Item -ItemType Directory -Force -Path $tempRoot, $stagedRuntime | Out-Null
  Write-AdeBanner
  Write-Host "  Installing ADE to $AdeHome"
  Write-Host ""
  Download-Asset $binaryAsset $stagedBinary "ADE runtime"
  Download-Asset $nativeAsset $stagedArchive "Native dependencies"
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
    # `brain start`, NOT `serve --install-service`. The latter registers the
    # service at whatever ADE_DEFAULT_ROLE happens to be, and in a fresh install
    # that is unset, so the machine brain came up as role `agent`. `ade connect`
    # runs at `cto`, and an `agent` brain can never serve a `cto` caller -- so
    # sign-in failed on every clean install, on Windows and macOS alike.
    # `brain start` pins `cto` internally, matching what the desktop app spawns
    # and what it refuses to attach to anything else.
    & $destinationBinary brain start | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "ADE installed, but its per-user brain service could not be registered" }
  }
  if (-not $NoPath) { Install-UserPath $InstallDir }

  Write-AdeStep "+" "ADE runtime" $destinationBinary
  Write-AdeStep "+" "Native dependencies" $runtimeDir
  $installSucceeded = $true
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
      # Same `cto` reasoning as the install path above: restoring the previous
      # service through `serve --install-service` would put it back at role
      # `agent`, leaving the user rolled back onto a brain their own `ade
      # connect` cannot talk to.
      & $destinationBinary brain start | Out-Null
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

# ---------------------------------------------------------------------------
# Onboarding. Runs only after a fully successful install, and outside the
# install's try/catch so nothing here can trigger a rollback of a good install.
#
# Everything past this point -- agent CLIs, account, desktop app, end-to-end
# verification and the closing summary -- is `ade setup`. That is the same
# implementation the macOS installer hands off to, written once in TypeScript
# and unit-tested, so the two platforms cannot drift the way they had (macOS
# had a download progress bar here; Windows silently downloaded a gigabyte).
# ---------------------------------------------------------------------------
if ($installSucceeded) {
  $onboardingPreviousEnvironment = @{
    ADE_HOME = $env:ADE_HOME
    ADE_PACKAGE_CHANNEL = $env:ADE_PACKAGE_CHANNEL
    ADE_RUNTIME_ROOT = $env:ADE_RUNTIME_ROOT
    ADE_RUNTIME_NODE_MODULES = $env:ADE_RUNTIME_NODE_MODULES
    NODE_PATH = $env:NODE_PATH
  }

  try {
    # `ade setup` needs the runtime sidecar environment; the install's finally
    # deliberately restored the caller's copy, so re-apply it just for this
    # child process and put it back afterwards.
    Set-ProcessRuntimeEnvironment $AdeHome $runtimeDir

    $runtimeVersion = ""
    try {
      # Collapsed to one line, matching the sh side's `tr -d '\r\n'`: any stray
      # warning line ahead of the version would otherwise embed a newline in the
      # summary's step detail and break its layout.
      $runtimeVersion = (((& $destinationBinary --version) -join " ") -replace '\s+', " ").Trim()
    } catch {
      $runtimeVersion = ""
    }

    $setupArgs = @(
      "setup",
      "--continue",
      "--runtime-path", $destinationBinary,
      "--native-path", $runtimeDir,
      "--elapsed-ms", ([string][int]$script:InstallStopwatch.ElapsedMilliseconds),
      "--downloaded-bytes", ([string][int64]$script:DownloadedBytes)
    )
    if (-not [string]::IsNullOrWhiteSpace($runtimeVersion)) {
      $setupArgs += @("--runtime-version", $runtimeVersion)
    }
    # No console means no prompts: `ade setup` falls through to printing the
    # follow-up commands instead of blocking on a read that can never return.
    if (-not (Test-AdeInteractive)) { $setupArgs += "--no-prompt" }

    # stdout/stderr are inherited on purpose: the step lines, the prompts and
    # the summary are meant for this console.
    & $destinationBinary @setupArgs
  } catch {
    Write-Warning "Setup did not finish ($($_.Exception.Message)). Run 'ade setup' to try again."
  } finally {
    foreach ($name in $onboardingPreviousEnvironment.Keys) {
      [Environment]::SetEnvironmentVariable($name, $onboardingPreviousEnvironment[$name], "Process")
    }
  }

  # Only this script knows whether it edited the user PATH, so the "new
  # terminal" note belongs here rather than in the shared summary. With -NoPath
  # nothing was added and a new terminal would buy the user nothing.
  if (-not $NoPath) {
    Write-Host ""
    # Single-quoted: a backtick inside a double-quoted PowerShell string is an
    # escape character, so "`ade`" would emit a BEL instead of the word.
    Write-Host '  ade is on your PATH in new terminals. This one still needs a restart.'
  }

  # `ade setup`'s exit code is deliberately not propagated. Reaching here means
  # the runtime is installed and the brain is registered, which is all this
  # script promises; the steps `ade setup` owns past that are enhancement, and
  # several are documented non-fatal (the brain re-fetches the agent CLIs on
  # every `ade serve`). Propagating it failed whole Dockerfiles and CI
  # provisioning runs over a flaky fetch. The summary tells the human what is
  # left, and `ade setup` still exits non-zero when a person runs it directly.
  exit 0
}
