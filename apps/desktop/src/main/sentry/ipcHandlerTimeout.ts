/**
 * How an `ipcMain.handle` call ends when its handler did not answer in time,
 * and how to tell a hang from a process that was not running. See
 * `shared/deadlineTimer.ts` for why a late timer is the sign of the second.
 */
import { LATE_TIMER_MS, type DeadlineExpiry } from "../../shared/deadlineTimer";

/**
 * The share of a timer's lateness the process may have spent on the CPU and
 * still count as not having run. A main thread blocked by work burns about a
 * second of CPU for every second its timers wait; a sleeping or held-back
 * process burns almost none. The brain's watchdog draws the same line
 * (`BRAIN_LOOP_PAUSE_UNEXPLAINED_FRACTION`).
 */
export const IPC_PAUSED_MAX_CPU_FRACTION = 0.25;

/**
 * The error an IPC call rejects with when its handler did not answer in
 * time. The message is the one every IPC timeout has always had, so issue
 * titles and grouping do not change; `expiry` says how late the timer was
 * and what the process spent on the CPU until then.
 */
export class IpcHandlerTimeoutError extends Error {
  constructor(
    channel: string,
    limitMs: number,
    callId: number,
    readonly expiry: DeadlineExpiry,
  ) {
    super(`IPC handler for '${channel}' timed out after ${limitMs}ms (callId=${callId})`);
  }
}

/**
 * Whether a call's deadline passed while the process was not running: its
 * timer fired late and the process spent too little CPU in the meantime to
 * have been busy. A main thread stuck in a synchronous system call also burns
 * little CPU and reads as a pause here; such a call is still logged, with its
 * lateness and CPU time.
 */
export function ipcTimerFiredWhilePaused(timerLateMs: number, cpuMsDuringCall: number): boolean {
  return timerLateMs >= LATE_TIMER_MS && cpuMsDuringCall < timerLateMs * IPC_PAUSED_MAX_CPU_FRACTION;
}
