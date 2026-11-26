import type { ChildProcess } from "node:child_process";
import type { Logger } from "../logging/logger";

/** After SIGTERM, how long a media process gets to delete its partial file before SIGKILL. */
const KILL_GRACE_MS = 3_000;
/**
 * After SIGKILL, how long to wait for the exit before giving the caller its
 * answer anyway. A process stuck inside the kernel (a drive that stopped
 * answering mid-write) cannot die until that call returns, and it may never.
 */
const STUCK_GRACE_MS = 10_000;

const stuckErrors = new WeakSet<object>();

/**
 * Whether a media call failed because its process is stuck on a drive that
 * stopped answering. Nothing more on that drive will answer either, so no
 * cleanup, retry or fallback may touch it: each would hang the same way, and
 * a synchronous one would freeze the whole process.
 */
export function isStuckMediaProcessError(error: unknown): boolean {
  return typeof error === "object" && error !== null && stuckErrors.has(error);
}

/**
 * Stops a media child: SIGTERM first (it deletes its partial output on it),
 * SIGKILL after the grace period, and when even that does not end it, lets go
 * of it and settles the caller with `reason`, marked stuck
 * ({@link isStuckMediaProcessError}). Returns the timer, for the caller's
 * `close` handler to clear.
 */
export function stopMediaChild(args: {
  child: ChildProcess;
  reason: Error;
  label: string;
  /** The log event written when the process cannot be ended. */
  stuckEvent: string;
  logger: Logger | null;
  isSettled: () => boolean;
  settle: (error: Error) => void;
  onTimer: (timer: NodeJS.Timeout) => void;
}): void {
  const { child } = args;
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null;
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (exited()) return;
    child.kill("SIGKILL");
    const stuckTimer = setTimeout(() => {
      if (args.isSettled() || exited()) return;
      stuckErrors.add(args.reason);
      args.logger?.warn(args.stuckEvent, { label: args.label, pid: child.pid ?? null });
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      args.settle(args.reason);
    }, STUCK_GRACE_MS);
    stuckTimer.unref?.();
    args.onTimer(stuckTimer);
  }, KILL_GRACE_MS);
  killTimer.unref?.();
  args.onTimer(killTimer);
}
