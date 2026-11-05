/**
 * A deadline that does not fail a call for time the process was not running.
 *
 * Node's timers on macOS run on `mach_continuous_time`, which keeps counting
 * while the Mac sleeps. A call made before a sleep reaches its deadline during
 * the sleep, and on wake every overdue timer fires in libuv's timers phase,
 * before the poll phase reads the reply that may already be waiting on a
 * socket. So the call failed with its answer in hand. Sentry saw it as five
 * calls failing in the same millisecond, minutes late, after a Mac slept with
 * no `suspend` or `resume` event (dark wakes send neither); a paused process
 * (App Nap, a stopped one) does the same.
 */

/**
 * A timer this late did not fire on time because the process did not run:
 * the machine slept, macOS held a hidden app back, or the thread was busy.
 * Under it, a timer is ordinary jitter.
 */
export const LATE_TIMER_MS = 5_000;

/**
 * How much longer a call whose deadline timer fired late waits for its answer.
 *
 * The answer is often already there, queued behind the timer, or a second
 * away on a brain that woke with the machine, and the handler's own fallback
 * deadlines fired at the same moment and may need one more round trip. Ten
 * seconds is enough for that and short enough that a call which really hangs
 * still ends.
 */
export const LATE_TIMER_GRACE_MS = 10_000;

export type DeadlineTimer = { cancel(): void };

/** What the deadline knew when its timer fired, before any grace. */
export type DeadlineExpiry = {
  /** How late the timer fired. */
  timerLateMs: number;
  /** CPU the process spent from arming to the timer firing (all threads). */
  cpuMs: number;
};

/**
 * Call `onExpired` once `timeoutMs` have passed. When the timer fires
 * `LATE_TIMER_MS` or more late, `onExpired` runs after one more
 * `LATE_TIMER_GRACE_MS` instead, so a reply that is already waiting can land
 * first. The expiry describes the moment the timer fired, so the CPU of the
 * wake and the grace that follow it is not counted.
 */
export function armDeadline(timeoutMs: number, onExpired: (expiry: DeadlineExpiry) => void): DeadlineTimer {
  const startedAt = Date.now();
  const startedCpu = process.cpuUsage();
  let handle = setTimeout(() => {
    const used = process.cpuUsage(startedCpu);
    const expiry: DeadlineExpiry = {
      timerLateMs: Date.now() - startedAt - timeoutMs,
      cpuMs: Math.round((used.user + used.system) / 1000),
    };
    if (expiry.timerLateMs >= LATE_TIMER_MS) {
      handle = setTimeout(() => onExpired(expiry), LATE_TIMER_GRACE_MS);
    } else {
      onExpired(expiry);
    }
  }, timeoutMs);
  return { cancel: () => clearTimeout(handle) };
}
