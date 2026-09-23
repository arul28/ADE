/**
 * Shared pieces of the startup sweeps that reap processes a dead owner left
 * behind (the OpenCode server sweep and the Cursor SDK worker sweep).
 *
 * Each sweep keeps its own listing and its own rule for what counts as an
 * orphan. What they share is how a listing parses and how an orphan dies:
 * SIGTERM then SIGKILL on POSIX, and `taskkill /T /F` on both passes on
 * Windows, which has no signals.
 */

export type ProcessRow = { pid: number; ppid: number; command: string };

/**
 * Parses `ps -axo pid=,ppid=,command=` output.
 *
 * Also parses `<pid>\t<ppid>\t<command line>` rows, which is what a Windows
 * CIM query prints when it formats its rows that way. Tabs, because a Windows
 * command line starts with a quoted path that can hold spaces.
 */
export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" });
  }
  return rows;
}

const PROCESS_EXIT_POLL_MS = 50;

/** Polls until `pid` is gone. Resolves false when it outlives `timeoutMs`. */
export async function waitForProcessExit(
  pid: number,
  args: {
    timeoutMs: number;
    isAlive: (pid: number) => boolean;
    waitMs: (ms: number) => Promise<void>;
  },
): Promise<boolean> {
  const attempts = Math.max(1, Math.ceil(args.timeoutMs / PROCESS_EXIT_POLL_MS));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!args.isAlive(pid)) return true;
    await args.waitMs(PROCESS_EXIT_POLL_MS);
  }
  return !args.isAlive(pid);
}

export type OrphanTerminationDeps = {
  platform: NodeJS.Platform;
  /** How long each pass waits for the process to exit. */
  graceMs: number;
  isAlive: (pid: number) => boolean;
  waitMs: (ms: number) => Promise<void>;
  /** POSIX only. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Windows only: `taskkill /PID <pid> /T /F`. */
  killTree: (pid: number) => unknown;
  /**
   * Runs before each kill. False skips that kill and every later one.
   *
   * A pid freed during a grace can be reused (fast on Windows), and
   * `taskkill /T /F` takes the whole tree of whatever holds the pid now. A
   * sweep that lists once and then kills through several graces uses this to
   * confirm the pid still names the orphan.
   */
  confirm?: (pid: number) => boolean | Promise<boolean>;
};

/**
 * Terminates one orphan, escalating once if it survives the grace.
 *
 * Returns true when the process is gone. When `confirm` stops a kill, the
 * result is whether the pid is gone anyway.
 */
export async function terminateOrphanProcess(pid: number, deps: OrphanTerminationDeps): Promise<boolean> {
  const passes: Array<NodeJS.Signals | null> = deps.platform === "win32" ? [null, null] : ["SIGTERM", "SIGKILL"];
  for (const signal of passes) {
    if (deps.confirm && !(await deps.confirm(pid))) return !deps.isAlive(pid);
    if (signal) deps.kill(pid, signal);
    else await deps.killTree(pid);
    if (await waitForProcessExit(pid, { timeoutMs: deps.graceMs, isAlive: deps.isAlive, waitMs: deps.waitMs })) {
      return true;
    }
  }
  return false;
}
