[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("install", "uninstall")]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$InstallDir,
  [Parameter(Mandatory = $true)]
  [string]$AppExecutableName,
  [ValidateSet("stable", "beta", "alpha")]
  [string]$PackageChannel = "stable"
)

# ADE's brain binds the sync host on all interfaces (0.0.0.0) so phones on the
# same wifi can reach it, and advertises itself over mDNS. Both listeners live
# in the packaged Electron executable, so without a pre-authorized rule Windows
# raises its "allow this app through the firewall" prompt on first run.
#
# Windows has no per-user firewall rule store: every write to the rule set
# requires Administrator. The ADE installer is deliberately per-user and
# non-elevating (build.nsis perMachine=false / allowElevation=false in
# apps/desktop/package.json, enforced by scripts/validate-win-artifacts.mjs), so
# this script usually runs at medium integrity and CANNOT create the rule. It
# does not pretend otherwise: when elevation is missing it makes no change and
# reports why, so the installer log states plainly that Windows will prompt once.
# It applies the rules when the installer does happen to run elevated (UAC off,
# built-in Administrator, or an admin-launched repair), and always tries to take
# them back out on uninstall.

$ErrorActionPreference = "Stop"

$SYNC_HOST_MIN_PORT = 8787   # DEFAULT_SYNC_HOST_PORT in apps/ade-cli/src/services/sync/syncProtocol.ts
$SYNC_HOST_MAX_PORT = 8999   # SYNC_HOST_MAX_PORT in the same module
$MDNS_PORT = 5353            # bonjour-service discovery used by the sync host

function Get-ShortSha256([string]$Value) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Value)))).Replace("-", "").Substring(0, 12).ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-NetshPath {
  $systemRoot = $env:SystemRoot
  if ([string]::IsNullOrWhiteSpace($systemRoot)) {
    throw "SystemRoot is unavailable; ADE cannot locate netsh.exe."
  }
  $netsh = Join-Path $systemRoot "System32\netsh.exe"
  if (-not (Test-Path -LiteralPath $netsh -PathType Leaf)) {
    throw "netsh.exe is missing from $([IO.Path]::GetDirectoryName($netsh))."
  }
  return $netsh
}

function Invoke-Netsh([string]$NetshPath, [string[]]$Arguments) {
  $output = (& $NetshPath @Arguments 2>&1 | Out-String).Trim()
  return @{ ExitCode = $LASTEXITCODE; Output = $output }
}

function Remove-Rule([string]$NetshPath, [string]$RuleName) {
  # `delete rule` removes every rule carrying the name, so running it before
  # `add rule` makes a reinstall over an existing install idempotent instead of
  # stacking duplicates. It exits 1 with "No rules match" when nothing is there,
  # which is a success for our purposes.
  $result = Invoke-Netsh $NetshPath @("advfirewall", "firewall", "delete", "rule", "name=$RuleName")
  return $result
}

function Test-RuleExists([string]$NetshPath, [string]$RuleName) {
  $result = Invoke-Netsh $NetshPath @("advfirewall", "firewall", "show", "rule", "name=$RuleName")
  return $result.ExitCode -eq 0
}

$resolvedInstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd("\")
$normalizedExecutableName = [IO.Path]::GetFileName($AppExecutableName)
if (-not [string]::Equals($normalizedExecutableName, $AppExecutableName, [StringComparison]::Ordinal) -or
    -not $normalizedExecutableName.EndsWith(".exe", [StringComparison]::OrdinalIgnoreCase)) {
  throw "The installer did not provide a valid ADE executable name."
}
$appExe = Join-Path $resolvedInstallDir $normalizedExecutableName

# Two installs of the same channel in different locations (or per-user installs
# owned by different Windows accounts) must not fight over one rule name, and
# the uninstaller has to be able to recompute the exact name it created.
$installIdentity = Get-ShortSha256 "$($PackageChannel.ToLowerInvariant())`0$($resolvedInstallDir.ToLowerInvariant())"
$syncRuleName = "ADE Sync Host ($PackageChannel-$installIdentity)"
$discoveryRuleName = "ADE LAN Discovery ($PackageChannel-$installIdentity)"

$netsh = Get-NetshPath
$elevated = Test-Elevated

if ($Action -eq "uninstall") {
  if (-not $elevated) {
    $leftovers = @($syncRuleName, $discoveryRuleName) | Where-Object { Test-RuleExists $netsh $_ }
    if ($leftovers.Count -gt 0) {
      Write-Output "ADE left its Windows Firewall rule(s) in place because the uninstaller is not running as Administrator: $($leftovers -join '; '). Remove them from Windows Defender Firewall > Inbound Rules, or re-run the uninstaller elevated."
      exit 0
    }
    Write-Output "No ADE Windows Firewall rules to remove."
    exit 0
  }
  $failures = [Collections.Generic.List[string]]::new()
  foreach ($ruleName in @($syncRuleName, $discoveryRuleName)) {
    $removal = Remove-Rule $netsh $ruleName
    if ($removal.ExitCode -ne 0 -and (Test-RuleExists $netsh $ruleName)) {
      $failures.Add("$ruleName ($($removal.Output))")
    }
  }
  if ($failures.Count -gt 0) {
    Write-Output "ADE could not remove Windows Firewall rule(s): $($failures -join '; ')"
    exit 1
  }
  Write-Output "Removed the ADE Windows Firewall rules."
  exit 0
}

if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
  throw "The packaged ADE install is incomplete: missing $appExe"
}

if (-not $elevated) {
  Write-Output "Skipped the ADE Windows Firewall rules: a per-user ADE install does not run as Administrator, and Windows has no per-user firewall rule store. Windows will ask once, the first time you use LAN sync on a network."
  exit 0
}

# Narrowest scope that still lets a phone on the same wifi reach the sync host:
# this executable only, inbound only, and only the sync port range plus mDNS.
# Public networks are deliberately excluded - being reachable on an untrusted
# network is a decision the user should make at the Windows prompt, not one the
# installer makes for them.
#
# No `remoteip=` narrowing on purpose. Windows stops raising the notification
# once ANY rule exists for a program, so a remote-address filter that misses a
# path ADE actually uses (a tailnet peer on 100.64.0.0/10, an IPv6 client, a
# phone routed from another subnet) would turn a visible prompt into a silent
# block, which is strictly worse than the bug this fixes. The profile filter is
# the scope limiter.
$ruleSpecs = @(
  @{
    Name = $syncRuleName
    Arguments = @(
      "protocol=TCP",
      "localport=$SYNC_HOST_MIN_PORT-$SYNC_HOST_MAX_PORT"
    )
    Description = "Lets devices on your local network reach the ADE sync host."
  },
  @{
    Name = $discoveryRuleName
    Arguments = @(
      "protocol=UDP",
      "localport=$MDNS_PORT"
    )
    Description = "Lets devices on your local network discover this ADE host over mDNS."
  }
)

$applied = [Collections.Generic.List[string]]::new()
foreach ($spec in $ruleSpecs) {
  Remove-Rule $netsh $spec.Name | Out-Null
  $addArguments = @(
    "advfirewall", "firewall", "add", "rule",
    "name=$($spec.Name)",
    "dir=in",
    "action=allow",
    "program=$appExe",
    "profile=private,domain",
    "enable=yes",
    "description=$($spec.Description)"
  ) + $spec.Arguments
  $result = Invoke-Netsh $netsh $addArguments
  if ($result.ExitCode -ne 0) {
    # Undo the partial rule set so a failed install never leaves a half-open
    # inbound allowance behind.
    foreach ($cleanupName in @($syncRuleName, $discoveryRuleName)) {
      Remove-Rule $netsh $cleanupName | Out-Null
    }
    Write-Output "ADE could not add the Windows Firewall rule '$($spec.Name)': $($result.Output)"
    exit 1
  }
  $applied.Add($spec.Name)
}

Write-Output "Added the ADE Windows Firewall rules: $($applied -join '; ')"
exit 0
