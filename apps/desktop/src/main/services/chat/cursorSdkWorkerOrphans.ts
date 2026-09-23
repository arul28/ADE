import { execFile } from "node:child_process";
import type { Logger } from "../logging/logger";
import { killWindowsProcessTreeAsync, windowsPowerShellCommand } from "../shared/processExecution";
import { parseProcessRows, terminateOrphanProcess, type ProcessRow } from "../shared/processOrphans";
import { CURSOR_SDK_KILL_ESCALATION_MS } from "./cursorSdkPolicy";
import { readCursorSdkOwnerPid } from "./cursorSdkWorkerGuards";
import { processIsAlive } from "../../../../../ade-cli/src/services/runtime/parentDeathWatchdog";

export type CursorSdkOrphanSweepDeps = {
  platform?: NodeJS.Platform;
  selfPid?: number;
  listProcesses?: () => Promise<ProcessRow[]>;
  isAlive?: (pid: number) => boolean;
  /** POSIX only. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows only: `taskkill /PID <pid> /T /F`. */
  killTree?: (pid: number) => boolean | Promise<boolean>;
  waitMs?: (ms: number) => Promise<void>;
};

export type CursorSdkOrphanSweepResult = {
  recoveredPids: number[];
  failedPids: number[];
};

/** Script name of the worker bundle. Both the desktop and CLI builds use it. */
const CURSOR_SDK_WORKER_SCRIPT_PATTERN = /(?:^|[\\/"\s])cursorSdkWorker\.cjs(?=["\s]|$)/;
/**
 * An installed app running the worker from its own bundle:
 * `/Applications/ADE Beta.app/Contents/MacOS/ADE Beta /Applications/ADE Beta.app/Contents/Resources/…/cursorSdkWorker.cjs`.
 * The backreferences pin the executable to `<Name>.app/Contents/MacOS/<Name>`
 * and the script to that same bundle, so a folder that is merely named ADE
 * does not match.
 */
const LEGACY_APP_WORKER_PATTERN =
  /^"?(\/(?:[^\n]*\/)?(ADE(?: Beta| Alpha)?)\.app)\/Contents\/MacOS\/\2"?\s+"?\1\/Contents\/Resources\/(?:[^\n"]*\/)?cursorSdkWorker\.cjs"?\s*$/;
/**
 * `node` or Electron running the worker from an absolute path, as a dev brain
 * or the npm CLI forks it. Neither path may hold a space, so a command such as
 * `tail -f /x/cursorSdkWorker.cjs` cannot pass for one.
 */
const LEGACY_NODE_WORKER_PATTERN =
  /^"?(?:[^\s"]*[\\/])?(?:node|nodejs|electron|Electron)(?:\.exe)?"?\s+"?(?:\/|[A-Za-z]:[\\/])[^\s"]*[\\/]cursorSdkWorker\.cjs"?\s*$/;

/**
 * Whether a command line is a worker as builds before the owner marker forked
 * it: `fork(workerPath, [])`, so a node, Electron, or ADE executable followed
 * by the absolute script path and nothing after it.
 */
export function isLegacyCursorSdkWorkerCommand(command: string): boolean {
  const trimmed = command.trim();
  return LEGACY_APP_WORKER_PATTERN.test(trimmed) || LEGACY_NODE_WORKER_PATTERN.test(trimmed);
}

/**
 * Pick the Cursor SDK workers that no live brain owns.
 *
 * A worker with the owner marker is an orphan only when that owner is dead.
 * A live owner may be another brain (a dev brain next to the installed one),
 * so its workers are never touched.
 *
 * A worker from a build before the marker is an orphan only on POSIX with
 * ppid 1: it was reparented to init, so no brain holds its IPC channel. Its
 * whole command line must also be the exact shape old builds forked, so a
 * reparented `tail -f …/cursorSdkWorker.cjs` is not taken for one. Windows
 * keeps a dead parent's pid as the ppid and recycles pids fast, so an
 * unmarked worker there cannot be judged safely and is left alone.
 */
export function selectOrphanedCursorSdkWorkers(
  rows: readonly ProcessRow[],
  args: { selfPid: number; platform: NodeJS.Platform; isAlive: (pid: number) => boolean },
): Array<{ pid: number; ppid: number; ownerPid: number | null }> {
  const orphans: Array<{ pid: number; ppid: number; ownerPid: number | null }> = [];
  for (const row of rows) {
    if (row.pid === args.selfPid) continue;
    if (!CURSOR_SDK_WORKER_SCRIPT_PATTERN.test(row.command)) continue;
    const ownerPid = readCursorSdkOwnerPid(row.command);
    const orphaned = ownerPid != null
      ? ownerPid !== args.selfPid && !args.isAlive(ownerPid)
      : args.platform !== "win32" && row.ppid === 1 && isLegacyCursorSdkWorkerCommand(row.command);
    if (orphaned) orphans.push({ pid: row.pid, ppid: row.ppid, ownerPid });
  }
  return orphans;
}

function execFileStdout(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 50 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : String(stdout ?? "")),
    );
  });
}

/**
 * Lists the processes the sweep judges. On POSIX that is every process, and
 * `selectOrphanedCursorSdkWorkers` picks the workers out.
 *
 * Async on purpose: this runs at startup, and a synchronous PowerShell CIM
 * query can block the event loop for seconds on Windows.
 */
async function listCursorSdkWorkerProcesses(platform: NodeJS.Platform): Promise<ProcessRow[]> {
  if (platform === "win32") {
    // `Get-CimInstance`, not the deprecated wmic. Tab-separated because a
    // Windows command line starts with a quoted, space-bearing path.
    const script = "Get-CimInstance Win32_Process -ErrorAction SilentlyContinue"
      + " | Where-Object { $_.CommandLine -like '*cursorSdkWorker*' }"
      + " | ForEach-Object { \"$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)\" }";
    const stdout = await execFileStdout(
      windowsPowerShellCommand(platform),
      ["-NoProfile", "-NonInteractive", "-Command", script],
    );
    return parseProcessRows(stdout);
  }
  return parseProcessRows(await execFileStdout("ps", ["-ww", "-axo", "pid=,ppid=,command="]));
}

function killProcessQuietly(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // Already gone, or not ours to signal.
  }
}

let cursorSdkOrphanSweep: Promise<CursorSdkOrphanSweepResult> | null = null;

/** Lets a test run the once-per-process sweep again. */
export function resetCursorSdkWorkerOrphanSweepForTests(): void {
  cursorSdkOrphanSweep = null;
}

/**
 * Terminates Cursor SDK workers whose brain is gone.
 *
 * A brain that dies without unwinding (the loop watchdog SIGKILLs it) cannot
 * dispose its workers. Current workers exit on their own when the IPC channel
 * closes, but a worker from an older build spins at 100% CPU and ignores
 * SIGTERM. So POSIX escalates SIGTERM to SIGKILL, and Windows uses
 * `taskkill /T /F` on both passes.
 *
 * The brain (`ade serve`) and desktop main each call this once at startup,
 * like `recoverManagedOpenCodeOrphans`. Later calls get the first result.
 */
export function recoverCursorSdkWorkerOrphans(args: {
  logger?: Logger;
  deps?: CursorSdkOrphanSweepDeps;
} = {}): Promise<CursorSdkOrphanSweepResult> {
  if (cursorSdkOrphanSweep) return cursorSdkOrphanSweep;
  const deps = args.deps ?? {};
  const platform = deps.platform ?? process.platform;
  const selfPid = deps.selfPid ?? process.pid;
  const isAlive = deps.isAlive ?? processIsAlive;
  const listProcesses = deps.listProcesses ?? (() => listCursorSdkWorkerProcesses(platform));
  const findOrphans = async () => selectOrphanedCursorSdkWorkers(await listProcesses(), {
    selfPid,
    platform,
    isAlive,
  });
  const sweep = (async (): Promise<CursorSdkOrphanSweepResult> => {
    const orphans = await findOrphans();
    // Every kill re-lists first, the first one too. A current worker can exit
    // on its own once its owner's channel closes, so a listed pid can be freed
    // and reused (fast on Windows) before any signal, and `taskkill /T /F`
    // would take the new owner's whole tree.
    const confirm = async (pid: number): Promise<boolean> =>
      (await findOrphans()).some((candidate) => candidate.pid === pid);
    const terminationDeps = {
      platform,
      graceMs: CURSOR_SDK_KILL_ESCALATION_MS,
      isAlive,
      waitMs: deps.waitMs ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      kill: deps.kill ?? killProcessQuietly,
      killTree: deps.killTree ?? ((pid: number) => killWindowsProcessTreeAsync(pid)),
      confirm,
    };
    const recoveredPids: number[] = [];
    const failedPids: number[] = [];
    for (const orphan of orphans) {
      const exited = await terminateOrphanProcess(orphan.pid, terminationDeps);
      (exited ? recoveredPids : failedPids).push(orphan.pid);
      args.logger?.warn(
        exited ? "agent_chat.cursor_sdk_worker_orphan_recovered" : "agent_chat.cursor_sdk_worker_orphan_recovery_failed",
        { pid: orphan.pid, ppid: orphan.ppid, ownerPid: orphan.ownerPid },
      );
    }
    return { recoveredPids, failedPids };
  })();
  cursorSdkOrphanSweep = sweep;
  return sweep;
}
