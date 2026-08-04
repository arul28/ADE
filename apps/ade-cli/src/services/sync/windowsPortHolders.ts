/**
 * Windows "who is listening on this port" queries, shared by the sync
 * listener's stale-port reclaim and the sync-host singleton's listener scan.
 *
 * It lives in its own module rather than in `sharedSyncListener` because
 * `syncHostSingleton` needs it too, and `sharedSyncListener` already imports
 * the service manager, which imports `syncHostSingleton` -- importing back the
 * other way would close that loop.
 */

export type WindowsPortHolder = {
  pid: number;
  command: string | null;
  /** Stable process birth identity used to guard against PID reuse. */
  startTime: string | null;
  /**
   * Present only for range scans, where the caller asked about a band of ports
   * rather than one it already knows. Absent (not null) for a single-port
   * diagnosis, whose port is the diagnosis's own `port`.
   */
  port?: number;
};

/**
 * PowerShell that reports every listening owner of `port` as JSON.
 *
 * `Get-NetTCPConnection` is the supported replacement for parsing `netstat`
 * output, and pairing it with `Get-CimInstance Win32_Process` gets the command
 * line and creation time in the SAME invocation — one process spawn instead of
 * the 1 + 2N that the POSIX `lsof`/`ps` path needs.
 */
export function buildWindowsPortHolderQueryArgs(port: number): string[] {
  return buildWindowsListeningPortHolderQueryArgs(port, port);
}

/**
 * The same query over a CONTIGUOUS RANGE of ports, so a caller that has to
 * enumerate the whole sync-host port band (8787-8999) pays for one PowerShell
 * start instead of 213 of them.
 *
 * `Get-NetTCPConnection -LocalPort` does accept an array, but a 213-element
 * literal is unreadable and PowerShell filters the same set just as cheaply.
 * Each holder reports the LOWEST port in the band it listens on, which is all
 * the singleton scan needs in order to name the owner.
 */
export function buildWindowsListeningPortHolderQueryArgs(
  minPort: number,
  maxPort: number,
): string[] {
  for (const port of [minPort, maxPort]) {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid port for the Windows port-holder query: ${String(port)}`);
    }
  }
  if (maxPort < minPort) {
    throw new Error(
      `Invalid port for the Windows port-holder query: ${String(maxPort)} < ${String(minPort)}`,
    );
  }
  const listeners = minPort === maxPort
    ? `Get-NetTCPConnection -LocalPort ${minPort} -State Listen -ErrorAction SilentlyContinue`
    : "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue"
      + ` | Where-Object { $_.LocalPort -ge ${minPort} -and $_.LocalPort -le ${maxPort} }`;
  const query = [
    "$ErrorActionPreference = 'Stop'",
    `$owners = @(${listeners} | Group-Object -Property OwningProcess)`,
    "$holders = @(foreach ($owner in $owners) {",
    "  $target = Get-CimInstance Win32_Process -Filter \"ProcessId = $($owner.Name)\" -ErrorAction SilentlyContinue",
    "  if ($null -eq $target) { continue }",
    "  $startTime = ''",
    "  try { $startTime = ([datetime]$target.CreationDate).ToUniversalTime().ToString('o') } catch { $startTime = '' }",
    "  $port = [int](@($owner.Group | Select-Object -ExpandProperty LocalPort | Sort-Object))[0]",
    "  [ordered]@{ pid = [int]$target.ProcessId; port = $port; command = [string]$target.CommandLine; startTime = [string]$startTime }",
    "})",
    "[Console]::Out.Write((ConvertTo-Json -InputObject @($holders) -Compress -Depth 3))",
  ].join("; ");
  return ["-NoProfile", "-NonInteractive", "-Command", query];
}

export function parseWindowsPortHolders(raw: string | null): WindowsPortHolder[] {
  const text = raw?.trim();
  // PowerShell emits nothing for an empty collection, which is a legitimate
  // "no holders" answer rather than a parse failure.
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const holders: WindowsPortHolder[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    if (typeof entry !== "object" || entry == null) continue;
    const record = entry as {
      pid?: unknown;
      command?: unknown;
      startTime?: unknown;
      port?: unknown;
    };
    const pid = Number(record.pid);
    if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
    seen.add(pid);
    const port = Number(record.port);
    // A holder owned by another user yields a null CommandLine without
    // elevation. Keep the pid: it still proves the port is genuinely occupied,
    // and `findStaleHolder` already refuses to reap a holder it cannot identify.
    const command = typeof record.command === "string" ? record.command.trim() : "";
    const startTime = typeof record.startTime === "string" ? record.startTime.trim() : "";
    holders.push({
      pid,
      command: command || null,
      startTime: startTime || null,
      // Omitted rather than nulled when absent: a single-port diagnosis already
      // knows its port, and callers must not see a null they could mistake for
      // "listening on no port".
      ...(Number.isInteger(port) && port > 0 ? { port } : {}),
    });
  }
  return holders;
}
