import path from "node:path";
import { powerShellSingleQuotedLiteral } from "./common";

/**
 * ADE-160. Three guards run before any brain work, in this order:
 *
 * 1. Session probe. The Run entry fires at EVERY logon of the user, so a
 *    Remote Desktop session, a Windows Desktop child session, or fast user
 *    switching starts a supervisor too. The probe only records which session
 *    this is (and whether a console session exists at all); it no longer
 *    decides whether a brain may start. It used to refuse every session but
 *    the active console session, which meant no brain could start at all
 *    while the user worked over Remote Desktop (RDP moves the user's session
 *    off the console and gives the console a fresh one), and none on a host
 *    with no console session (0xFFFFFFFF: Windows Sandbox, headless VMs,
 *    RDP-only servers).
 * 2. Child-session branch. Outside the console session, a usable short-lived
 *    launch request in `<adeDir>\windows-desktop\child-launch.json` means the
 *    Windows Desktop feature opened this session for its driver. The launcher
 *    starts that driver (hidden, no wait) so it can connect back to the brain
 *    over the pipe, and exits -- a child session never starts a brain, even
 *    when the mutex below happens to be free. With no usable request it falls
 *    through to the mutex.
 * 3. Single-instance mutex. This, not the session, is what keeps one brain
 *    per user and channel. `Global\` rather than `Local\` on purpose: a
 *    `Local\` name is per session and would not exclude the second session.
 *    The name is baked in at render time (channel launcher hash + the user's
 *    SID), so every session of the account computes the same one. A
 *    supervisor that cannot take it logs why and exits 0, leaving the owner
 *    alone, so a second session never starts a second brain. The handle is
 *    held for the supervisor's lifetime; Windows releases it when the process
 *    exits, including when the session that hosts it signs out, and the next
 *    supervisor start in any session (the Run entry at the next logon, the
 *    desktop app's service install, `ade brain start`) takes over.
 *
 * A brain that runs outside the console session ends when that session signs
 * out (disconnecting RDP does not end it), and Windows Desktop private
 * screens need the brain on the console. Both are reported, not refused:
 * `ade doctor` shows the brain's session.
 *
 * Every line logs through `Write-SupervisorLog`, which the launcher defines first.
 */
export function renderWindowsSupervisorGuardLines(options: {
  /** The cross-session single-instance mutex name. */
  mutexName: string;
  /** Resolved ADE home; omitted only by callers that predate Windows Desktop. */
  adeDir?: string;
}): string[] {
  const { mutexName } = options;
  const childLaunchPath = options.adeDir
    ? path.win32.join(options.adeDir, "windows-desktop", "child-launch.json")
    : null;
  return [
    `$mutexName = ${powerShellSingleQuotedLiteral(mutexName)}`,
    `$childLaunchPath = ${
      childLaunchPath ? powerShellSingleQuotedLiteral(childLaunchPath) : "$null"
    }`,
    "$mutexApiReady = $false",
    "$sessionApiReady = $false",
    // C# 5 only, like the launcher's JobApi block: Windows PowerShell 5.1 compiles
    // Add-Type sources with the .NET Framework compiler.
    "try {",
    "  Add-Type -Namespace AdeSupervisor -Name SessionApi -MemberDefinition @'",
    "[DllImport(\"kernel32.dll\")]",
    "public static extern uint WTSGetActiveConsoleSessionId();",
    "'@",
    "  $sessionApiReady = $true",
    "} catch { }",
    // `CreateMutex` through the API rather than New-Object: the
    // already-exists answer comes back in GetLastWin32Error, which PowerShell's
    // New-Object cannot surface from a [ref] argument reliably.
    "try {",
    "  Add-Type -Namespace AdeSupervisor -Name MutexApi -MemberDefinition @'",
    "[DllImport(\"kernel32.dll\", SetLastError=true, CharSet=CharSet.Unicode)]",
    "public static extern IntPtr CreateMutex(IntPtr attributes, bool initialOwner, string name);",
    "'@",
    "  $mutexApiReady = $true",
    "} catch { }",
    "$inConsoleSession = $false",
    "if ($sessionApiReady) {",
    "  try {",
    "    $consoleSessionId = [AdeSupervisor.SessionApi]::WTSGetActiveConsoleSessionId()",
    "    $currentSessionId = [uint32][System.Diagnostics.Process]::GetCurrentProcess().SessionId",
    "    $inConsoleSession = ($consoleSessionId -ne [uint32]::MaxValue) -and ($currentSessionId -eq $consoleSessionId)",
    "  } catch {",
    "    Write-SupervisorLog \"session check failed; refusing to start a brain: $($_.Exception.Message)\"",
    "    exit 1",
    "  }",
    "}",
    "if (-not $sessionApiReady) { Write-SupervisorLog 'session API unavailable; refusing to start a brain'; exit 1 }",
    "$consoleLabel = if ($consoleSessionId -eq [uint32]::MaxValue) { 'none' } else { [string]$consoleSessionId }",
    "if (-not $inConsoleSession) {",
    "  Write-SupervisorLog \"not the console session (current=$currentSessionId console=$consoleLabel)\"",
    "  if (-not [string]::IsNullOrEmpty($childLaunchPath) -and (Test-Path -LiteralPath $childLaunchPath -PathType Leaf)) {",
    "    try {",
    "      $child = (Get-Content -LiteralPath $childLaunchPath -Raw -ErrorAction Stop) | ConvertFrom-Json",
    "      $driverPath = [string]$child.driverPath",
    "      $expiresAt = [DateTimeOffset]::MinValue",
    "      $expiryOk = [DateTimeOffset]::TryParse([string]$child.expiresAt, [ref]$expiresAt) -and ($expiresAt -gt [DateTimeOffset]::UtcNow)",
    "      $driverOk = (-not [string]::IsNullOrEmpty($driverPath)) -and (Test-Path -LiteralPath $driverPath -PathType Leaf) -and ($driverPath -match 'ade-desktop-driver\\.exe$')",
    "      if ($expiryOk -and $driverOk) {",
    "        $childArgs = @($child.args | ForEach-Object { [string]$_ })",
    "        Start-Process -FilePath $driverPath -ArgumentList $childArgs -WindowStyle Hidden",
    "        Write-SupervisorLog 'child session: started the desktop driver'",
    "        exit 0",
    "      }",
    "      Write-SupervisorLog \"child session: child-launch.json is not usable (expiry=$expiryOk driver=$driverOk)\"",
    "    } catch {",
    "      Write-SupervisorLog \"child session: child-launch.json could not be used: $($_.Exception.Message)\"",
    "    }",
    "  }",
    "}",
    "$mutexHandle = [IntPtr]::Zero",
    "if ($mutexApiReady) {",
    "  $mutexHandle = [AdeSupervisor.MutexApi]::CreateMutex([IntPtr]::Zero, $true, $mutexName)",
    "  $mutexError = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()",
    "  if ($mutexHandle -eq [IntPtr]::Zero) {",
    "    Write-SupervisorLog \"could not create the supervisor mutex $mutexName (error $mutexError); refusing to start a brain\"",
    "    exit 1",
    "  } elseif ($mutexError -eq 183) {",
    // ERROR_ALREADY_EXISTS: another supervisor of this account and channel
    // already holds it — the ADE-160 case. Leave the owner alone.
    "    Write-SupervisorLog \"another ADE supervisor already owns $mutexName; exiting\"",
    "    exit 0",
    "  }",
    "} else {",
    "  Write-SupervisorLog 'supervisor mutex API unavailable; refusing to start a brain'",
    "  exit 1",
    "}",
    "if (-not $inConsoleSession) {",
    "  Write-SupervisorLog \"no other supervisor is running; starting the brain in session $currentSessionId (console=$consoleLabel). It ends if this session signs out.\"",
    "}",
  ];
}
