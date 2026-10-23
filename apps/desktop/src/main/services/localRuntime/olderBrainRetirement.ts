import { execFile } from "node:child_process";
import { resolveTrustedWindowsTool } from "../../../../../ade-cli/src/lib/trustedWindowsTools";
import { requestAdeRuntimeShutdown } from "../../../../../ade-cli/src/serviceManager/runtimeShutdownRequest";
import type { LocalRuntimeStatus } from "../../../shared/types";
import { execFileOffThread, offThreadSpawnEnabled } from "../shared/offThreadSpawn";

/**
 * Retiring an older brain that holds the machine socket, so the installed
 * service can start the current one.
 *
 * ADE-DESKTOP-8: a 1.2.91 brain that an old `ade` CLI had started on the
 * machine socket (role `agent`, no idle exit) held it for days. The service's
 * own brain failed every restart with `socket_owned_by_other`, the forced
 * service restart could not reach a process it does not own, and the desktop
 * ran on its isolated brain, without sync, until someone noticed.
 *
 * The request is the brain's own clean exit: the `shutdown` call (in every
 * brain since 1.2.0) runs the same `finish()` as its SIGTERM handler, which
 * saves each chat for restart recovery, exactly as an update does. Nothing is
 * signalled or force-killed: a brain that does not leave stays, and the
 * desktop keeps its isolated brain, as before.
 *
 * Every guard must hold. A wrong "yes" stops someone's brain; a wrong "no"
 * only keeps today's behavior.
 */

export type OlderBrainFacts = {
  skewState: LocalRuntimeStatus["versionSkew"]["state"];
  runtimeVersion: string | null;
  appVersion: string;
  pid: number | null;
  /** A packaged desktop that repairs its service. Never a dev desktop. */
  preferServiceRepair: boolean;
  /** The installed service is there to start the replacement. */
  serviceInstalled: boolean;
  quitting: boolean;
  updateInProgress: boolean;
  /** Pids that are this desktop or brains it owns. */
  ownPids: ReadonlyArray<number | null | undefined>;
  alreadyAsked: (pid: number) => boolean;
  isAlive: (pid: number) => boolean;
};

export type OlderBrainDecision =
  | { action: "skip" }
  | { action: "refuse"; reason: string }
  | { action: "ask"; pid: number };

/**
 * The synchronous guards. Only a strictly older, parseable version is a
 * candidate: a newer brain, a build or role mismatch at the same version, or an
 * unreadable version is not ours to replace.
 */
export function decideOlderBrainRetirement(
  facts: OlderBrainFacts,
  compareVersions: (left: string | null, right: string | null) => number | null,
): OlderBrainDecision {
  if (facts.skewState !== "runtime_older") return { action: "skip" };
  if (!facts.preferServiceRepair) return { action: "refuse", reason: "not_packaged" };
  if (facts.quitting) return { action: "refuse", reason: "quitting" };
  if (facts.updateInProgress) return { action: "refuse", reason: "update_in_progress" };
  if (!facts.serviceInstalled) return { action: "refuse", reason: "service_not_installed" };
  const comparison = compareVersions(facts.runtimeVersion, facts.appVersion);
  if (comparison == null || comparison >= 0) return { action: "refuse", reason: "version_not_older" };
  const pid = facts.pid;
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return { action: "refuse", reason: "no_pid" };
  if (pid === process.pid || facts.ownPids.includes(pid)) return { action: "refuse", reason: "own_process" };
  if (facts.alreadyAsked(pid)) return { action: "refuse", reason: "already_asked" };
  if (!facts.isAlive(pid)) return { action: "refuse", reason: "not_running" };
  return { action: "ask", pid };
}

/**
 * The asynchronous guards and the request. `recheck` re-reads quit and update
 * state after the ancestry lookup, which can take seconds. The request itself
 * re-reads the brain's own pid first and sends nothing when it differs (a
 * recycled pid).
 */
export async function askOlderBrainToShutDown(args: {
  pid: number;
  socketPath: string;
  recheck: () => string | null;
}): Promise<{ requested: true } | { requested: false; reason: string }> {
  if (await isCurrentProcessUnderPid(args.pid)) return { requested: false, reason: "desktop_runs_under_it" };
  const recheckRefusal = args.recheck();
  if (recheckRefusal) return { requested: false, reason: recheckRefusal };
  const result = await requestAdeRuntimeShutdown({
    pid: args.pid,
    socketPath: args.socketPath,
    timeoutMs: 3_000,
  }).catch((error: unknown) => ({
    requested: false as const,
    reason: error instanceof Error ? error.message : String(error),
  }));
  return result.requested ? result : { requested: false, reason: `request_refused: ${result.reason}` };
}

/**
 * Whether this process runs inside the process tree of `targetPid`, read
 * without blocking the main process.
 *
 * `isCurrentProcessDescendantOfPid` (serviceManager/common) answers the same
 * question with one synchronous query per ancestor, which on Windows is a
 * PowerShell CIM call with a 15 s budget. That is fine in a CLI and a frozen
 * window in the desktop. This reads the whole process table once, off the
 * event loop, and walks it here.
 *
 * It fails closed: when the table cannot be read, the answer is `true`, the
 * answer that stops a caller from shutting a brain down. A parent missing from
 * the table (it exited) ends the walk, as `ps` failing does in the CLI helper.
 */
async function isCurrentProcessUnderPid(targetPid: number): Promise<boolean> {
  if (!Number.isInteger(targetPid) || targetPid <= 0) return false;
  const parents = await readParentPidTable();
  if (!parents) return true;
  const seen = new Set<number>();
  let cursor = process.pid;
  while (cursor > 0 && !seen.has(cursor)) {
    if (cursor === targetPid) return true;
    seen.add(cursor);
    const parent = parents.get(cursor);
    if (parent == null) return false;
    cursor = parent;
  }
  return false;
}

const POSIX_TABLE_TIMEOUT_MS = 5_000;
// The cold PowerShell + CIM start on a busy host; see WINDOWS_PARENT_PID_QUERY_TIMEOUTS_MS.
const WINDOWS_TABLE_TIMEOUT_MS = 25_000;
const TABLE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

async function readParentPidTable(): Promise<Map<number, number> | null> {
  const windows = process.platform === "win32";
  const command = windows ? resolveTrustedWindowsTool("powershell") : "ps";
  const args = windows
    ? [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { [Console]::Out.WriteLine(\"$($_.ProcessId) $($_.ParentProcessId)\") }",
    ]
    : ["-A", "-o", "pid=", "-o", "ppid="];
  const output = await captureStdout(command, args, windows ? WINDOWS_TABLE_TIMEOUT_MS : POSIX_TABLE_TIMEOUT_MS);
  if (output == null) return null;
  const parents = new Map<number, number>();
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    parents.set(Number(match[1]), Number(match[2]));
  }
  // A table without this process is not a table we can trust.
  return parents.has(process.pid) ? parents : null;
}

/** The command's stdout, or null when it failed, timed out or overran the buffer. */
function captureStdout(command: string, args: string[], timeoutMs: number): Promise<string | null> {
  // On Windows even an async spawn runs CreateProcess on this thread; the
  // off-thread spawn keeps the window responsive (windows-quirks §11).
  if (offThreadSpawnEnabled()) {
    return execFileOffThread(command, args, { timeoutMs, maxBuffer: TABLE_MAX_BUFFER_BYTES })
      .then((result) => (result.error || result.exitCode !== 0 ? null : result.stdout));
  }
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: TABLE_MAX_BUFFER_BYTES, windowsHide: true },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}
