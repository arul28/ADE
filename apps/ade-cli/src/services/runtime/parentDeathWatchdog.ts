/**
 * Parent-death watchdog for the embedded runtime profile.
 *
 * An embedded runtime is spawned by an external host (the ADE SDK) as a child
 * process. The SDK kills it on `dispose()` and from its process-exit hooks, but
 * neither of those runs when the host dies without unwinding: SIGKILL, a crashed
 * Electron renderer, a debugger detach, `kill -9` from a test harness. On POSIX
 * an orphaned child is simply reparented to init and keeps running — it does NOT
 * die with its parent. The observed symptom is accumulating runtime processes,
 * each holding an isolated ADE home and a listening socket.
 *
 * There is no portable "die with parent" primitive (Linux has PR_SET_PDEATHSIG,
 * macOS has nothing, Windows needs a job object), so this polls instead. Polling
 * is also the only approach that survives the host being SIGKILLed, which is
 * precisely the case the deliberate teardown paths miss.
 *
 * Gated to the embedded profile by its call site: no other runtime has an owner
 * whose death should end it, and a brain that exited because some unrelated pid
 * vanished would be a far worse bug than the leak this fixes.
 */

export type ParentDeathWatchdogOptions = {
  /** Pid of the process that owns this runtime. */
  parentPid: number;
  /** Poll period. Kept coarse — this trades seconds of orphan life for ~zero cost. */
  intervalMs?: number;
  /** Injectable for tests; defaults to a `process.kill(pid, 0)` probe. */
  isAlive?: (pid: number) => boolean;
  /** Called once, when the parent is first observed gone. */
  onParentGone: () => void;
  onInvalidParent?: (reason: string) => void;
};

export const DEFAULT_PARENT_DEATH_POLL_MS = 3_000;

/**
 * True when a process with this pid exists.
 *
 * `process.kill(pid, 0)` sends no signal; it only runs the kernel's permission
 * and existence checks. Three outcomes matter:
 *  - no throw  → alive.
 *  - ESRCH     → gone.
 *  - EPERM     → ALIVE but owned by another user. Reporting this as dead would
 *                make the runtime exit while its owner is still running, so it
 *                must count as alive. (Reachable on Windows, and on POSIX if the
 *                host drops privileges after spawning.)
 * Anything else is unknown; treat it as alive, because the failure this guards
 * against is exiting on a live parent, not lingering one extra poll.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
  }
}

/**
 * Rejects pids that must never be probed.
 *
 * `pid <= 0` is the dangerous case and the reason this is a named guard rather
 * than an inline check: on POSIX `process.kill(0, sig)` signals *the caller's
 * entire process group*, and a negative pid signals the group with that id. With
 * signal 0 that is only a probe, but the value would also flow into any future
 * "kill the parent" path, and a watchdog that can address a process group is a
 * loaded gun. Self-pid is rejected because it can never be observed dead, which
 * would silently disable the watchdog.
 */
export function validateParentPid(
  parentPid: number,
  selfPid: number = process.pid,
): { ok: true } | { ok: false; reason: string } {
  if (!Number.isInteger(parentPid)) {
    return { ok: false, reason: `parent pid must be an integer, got ${String(parentPid)}` };
  }
  if (parentPid <= 0) {
    return { ok: false, reason: `parent pid must be positive, got ${parentPid}` };
  }
  if (parentPid === selfPid) {
    return { ok: false, reason: "parent pid is this process — the watchdog could never fire" };
  }
  return { ok: true };
}

/**
 * Parses the spawner-supplied pid from `ADE_EMBEDDED_PARENT_PID`. Returns null
 * for absent or malformed input.
 *
 * Named for the embedded runtime rather than `readParentPid`, which is a
 * different function in `serviceManager/common.ts` that asks the OS for a
 * process's parent. Two same-named exports one import away from each other is a
 * wrong-import waiting to happen, and both return `number | null`.
 */
export function readEmbeddedParentPid(value: string | undefined | null): number | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed.length) return null;
  // Deliberately strict: Number() accepts "0x10" and "1e3", neither of which a
  // spawner would ever legitimately send, and both of which would make a typo
  // resolve to some unrelated live process. Surrounding whitespace is trimmed
  // above and does not count as malformed.
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Starts polling. Returns a stop function; safe to call more than once.
 *
 * When the parent pid is unusable the watchdog does not start and
 * `onInvalidParent` is called — the runtime keeps running rather than refusing
 * to boot, because a bad pid is the spawner's bug and killing the runtime over
 * it would turn a leak into an outage.
 */
export function startParentDeathWatchdog(
  options: ParentDeathWatchdogOptions,
): () => void {
  const {
    parentPid,
    intervalMs = DEFAULT_PARENT_DEATH_POLL_MS,
    isAlive = processIsAlive,
    onParentGone,
    onInvalidParent,
  } = options;

  const validation = validateParentPid(parentPid);
  if (!validation.ok) {
    onInvalidParent?.(validation.reason);
    return () => {};
  }

  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (isAlive(parentPid)) return;
    // Stop before notifying: onParentGone triggers shutdown, and a second tick
    // firing during teardown would run the shutdown path twice.
    stopped = true;
    clearInterval(timer);
    onParentGone();
  }, Math.max(250, Math.floor(intervalMs)));

  // Never hold the event loop open. The runtime stays alive on its own server
  // handles; a referenced timer here would keep a shutting-down process from
  // exiting for up to one full interval.
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  };
}
