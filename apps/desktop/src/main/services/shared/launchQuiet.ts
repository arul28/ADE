/**
 * The first seconds of a process belong to the launch.
 *
 * On a cold start the disk is the slowest part, and the person's first
 * actions (the first window, a new thread, the first send) wait on it.
 * Background work that starts a provider CLI only to refresh something a
 * screen already shows (a usage poll, a model list warm) reads the whole CLI
 * from disk: codex, claude, grok and droid are 40 to 80 MB each. Such work
 * waits until this process has run for {@link LAUNCH_QUIET_MS}, and what was
 * queued during that time then runs one job at a time, so at most one of
 * those CLIs starts at once.
 *
 * Work a person asked for (a Refresh, opening the model picker, a send) does
 * not come through here and runs at once.
 *
 * Only a long-lived process that a launch starts has a quiet period: the
 * desktop main process and the brain (`ade serve`) arm it when they start.
 * Anything else (a one-shot CLI command, a test) never waits.
 */

/** How long after the process starts background CLI work waits. */
export const LAUNCH_QUIET_MS = 8_000;

let armed = false;

/** Called once by a process that a launch starts (desktop main, the brain). */
export function armLaunchQuiet(): void {
  armed = true;
}

/** Milliseconds until the launch quiet period ends; 0 once it has, or when this process never armed it. */
export function launchQuietRemainingMs(uptimeMs: number = process.uptime() * 1000): number {
  if (!armed) return 0;
  return Math.max(0, Math.ceil(LAUNCH_QUIET_MS - uptimeMs));
}

let tail: Promise<void> = Promise.resolve();
let queued = 0;

function waitForLaunchQuiet(): Promise<void> {
  const remaining = launchQuietRemainingMs();
  if (remaining <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, remaining);
    // A pending wait must never hold the process open.
    (timer as { unref?: () => void }).unref?.();
  });
}

/**
 * Runs `task` once the launch quiet period is over. Jobs queued before then
 * run one after another; once the queue is empty and the period is over, a
 * job runs at once. The result (or error) is the task's own.
 */
export function runAfterLaunchQuiet<T>(task: () => Promise<T>): Promise<T> {
  if (queued === 0 && launchQuietRemainingMs() <= 0) return task();
  queued += 1;
  const run = tail.then(waitForLaunchQuiet).then(task);
  tail = run.then(
    () => undefined,
    () => undefined,
  ).finally(() => {
    queued -= 1;
  });
  return run;
}
