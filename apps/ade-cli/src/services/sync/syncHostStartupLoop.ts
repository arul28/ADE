import {
  isSameChannelSyncHostOwner,
  SyncHostSingletonConflictError,
} from "./syncHostSingleton";
import { createFailureLogDeduper } from "../runtime/failureLogDeduper";
import {
  classifyStorageFault,
  type StorageFault,
} from "../../../../desktop/src/main/services/storage/storageErrnoClassifier";

export type SyncHostStartupLoopDeps = {
  startSyncHost: () => Promise<unknown>;
  isDone: () => boolean;
  log: (message: string) => void;
  // Main pid of the channel's installed runtime service. Only the brain that
  // IS that service child may take over the sync singleton from a stale
  // same-channel sibling; everything else waits, so two recovering brains can
  // never kill each other in a loop.
  getServiceMainPid?: () => number | null;
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  pidAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  /**
   * Where a classified storage fault is recorded so the desktop can show it.
   * Wired at the call site to the machine-scoped last-failure report, which is
   * the same file the recovery screen and `ade doctor` already read.
   */
  recordStorageFault?: (fault: StorageFault, detail: string) => void;
  /**
   * The structured half of {@link SyncHostStartupLoopDeps.log}.
   *
   * Every sync-host failure this loop has ever reported went out as free text
   * on stderr and reached `launchd.err.log` and nowhere else — so the most
   * frequent brain failure in the fleet was invisible to `brain.jsonl`, to the
   * diagnostic report's structured sections, and to telemetry. This carries the
   * same failures as facts, at the same deduped cadence as the human line.
   */
  logEvent?: (event: string, meta: Record<string, unknown>) => void;
  /**
   * Called once when storage faults have persisted past
   * {@link SyncHostStartupLoopDeps.sustainedStorageFaultAttempts} consecutive
   * attempts.
   *
   * The auto-diagnostics trigger used to hang off the account publisher, which
   * exists only while this brain holds the sync-host lease — a lease taken only
   * once the sync host starts. So the machines that could not start a sync host
   * were exactly the machines that could never report why. This fires straight
   * off the failure instead, with no publisher in the path.
   *
   * ONCE per loop: the sender's own per-code daily slot bounds the rest, but a
   * loop that asked on every retry would spend the install's whole daily budget
   * on one fault in the first two minutes.
   */
  onSustainedStorageFault?: (event: {
    fault: StorageFault;
    detail: string;
    attempt: number;
  }) => void;
  sustainedStorageFaultAttempts?: number;
  env?: NodeJS.ProcessEnv;
  fastRetryDelayMs?: number;
  slowRetryDelayMs?: number;
  fastRetryCount?: number;
  maxAttempts?: number;
  /**
   * Injectable clock, so the conflict log cadence can be tested without
   * wall-clock waits. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * How often a still-persisting sync-host conflict is restated after its first
   * occurrence. Ten minutes: the condition is "the other ADE app is open", which
   * can last for days, and the generic one-minute retry summary is what turned
   * it into 9,700 log lines. Overridable for tests.
   */
  conflictSummaryIntervalMs?: number;
  /**
   * Treat a first-attempt cross-channel conflict as retryable instead of
   * rethrowing it. Brain STARTUP wants the throw (fail loudly with quit
   * instructions); a RE-HOST after a lost lease is already serving and must
   * wait the foreign owner out instead.
   */
  retryFirstConflict?: boolean;
  /**
   * How long one `startSyncHost` attempt may run before the loop reports it as
   * stuck. The attempt is not abandoned (it cannot be cancelled, and starting a
   * second one beside it would race it for the lease): the loop keeps waiting
   * on the SAME attempt, restating that it is still waiting at the deduped
   * cadence, so a hung project boot or listener bind is visible in
   * `brain.jsonl` instead of a silent brain that never hosts sync.
   */
  attemptTimeoutMs?: number;
};

/**
 * Why an activated project scope is not hosting phone sync, in one sentence
 * for `brain.jsonl` and the desktop. `status` is the scope's own sync snapshot
 * (null when it could not be read).
 */
export function describeScopeNotHostingSync(
  projectName: string,
  status: {
    role?: string | null;
    currentBrain?: { name?: string | null; lastSeenAt?: string | null } | null;
    crdtSyncAvailable?: boolean;
  } | null,
  nowMs: number = Date.now(),
): string {
  if (status?.crdtSyncAvailable === false) {
    return `ADE brain is not hosting phone sync: the CRDT database extension did not load for project "${projectName}", so phone sync is unavailable on this computer.`;
  }
  if (status?.role === "viewer") {
    const brainName = status.currentBrain?.name?.trim() || "another ADE";
    const lastSeenMs = status.currentBrain?.lastSeenAt ? Date.parse(status.currentBrain.lastSeenAt) : Number.NaN;
    const seen = Number.isFinite(lastSeenMs)
      ? ` (last seen ${Math.max(0, Math.round((nowMs - lastSeenMs) / 1000))}s ago)`
      : "";
    return `ADE brain is not hosting phone sync: project "${projectName}" still follows ${brainName}${seen} as its sync host. Retrying; this brain takes over once that host has been gone for a few minutes.`;
  }
  return `ADE brain is not hosting phone sync: project "${projectName}" is active but its sync host did not start. Retrying.`;
}

export class SyncHostStartTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`ADE brain sync host start has not finished after ${Math.round(waitedMs / 1000)}s; still waiting on it.`);
    this.name = "SyncHostStartTimeoutError";
  }
}

export type SyncHostRehostWatchDeps = {
  /** `onSyncHostSingletonAuthorityChanged`. */
  onAuthorityChanged: (handler: (held: boolean) => void) => () => void;
  /** `holdsSyncHostSingleton`. */
  holds: () => boolean;
  isDone: () => boolean;
  /** Runs the startup loop again. Its own failures are already logged. */
  rehost: () => Promise<void>;
  log: (message: string) => void;
  logEvent?: (event: string, meta: Record<string, unknown>) => void;
  /** How long a loss may last before it counts; a project switch reads false for a beat. */
  graceMs: number;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Re-host after a lost lease, instead of staying a viewer until a restart.
 *
 * The startup loop returns once the host is up and never runs again. On
 * 2026-09-21 a dev-build brain took the machine-wide lease from the installed
 * ADE, and when that dev brain exited nobody hosted sync: the installed brain
 * sat as a viewer for over an hour, the Connections card said "sync hasn't
 * started", Reconnect refused, and the only fix was a manual service restart.
 * This watches authority transitions and re-runs the loop when a loss outlives
 * the switch grace, so a foreign owner's exit hands sync back on its own.
 */
export function watchSyncHostAuthorityForRehost(deps: SyncHostRehostWatchDeps): () => void {
  const sleep = deps.sleep ?? defaultSleep;
  let rehosting = false;
  let stopped = false;
  const unsubscribe = deps.onAuthorityChanged((held) => {
    if (held || rehosting || stopped) return;
    void (async () => {
      await sleep(deps.graceMs);
      if (stopped || deps.isDone() || deps.holds() || rehosting) return;
      rehosting = true;
      deps.log("ADE brain lost the mobile sync host lease; trying to host again.");
      deps.logEvent?.("sync.host_rehost_started", {});
      try {
        await deps.rehost();
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        deps.log(`ADE brain could not re-host mobile sync: ${message}`);
        deps.logEvent?.("sync.host_rehost_failed", { error: message });
      } finally {
        rehosting = false;
      }
    })();
  });
  return () => {
    stopped = true;
    unsubscribe();
  };
}

function defaultKill(pid: number, signal: NodeJS.Signals | number): void {
  process.kill(pid, signal);
}

function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

async function terminatePidAsync(
  pid: number,
  deps: Required<Pick<SyncHostStartupLoopDeps, "kill" | "pidAlive" | "sleep">>,
): Promise<void> {
  if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid) return;
  try {
    deps.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (!deps.pidAlive(pid)) return;
    await deps.sleep(100);
  }
  try {
    deps.kill(pid, "SIGKILL");
  } catch {
    // best effort
  }
}

// Keeps retrying mobile sync host startup until it succeeds or the brain
// shuts down. Same-channel conflicts are transient by nature (update races,
// restart overlap, a stale sibling about to be evicted), so they retry:
// squatters die, upgrades finish, and the next attempt should win.
//
// A conflict with ANOTHER channel's live brain gets one rethrow so brain
// STARTUP can fail loudly with quit instructions — but only while startup can
// still abort (attempt 1). Once this brain is serving (or when the caller
// survives the throw and keeps running), permanently giving up would strand
// every paired phone on the ingress fallback — connected but with all
// requests dropped — until a manual brain restart. A dev-build brain that
// grabs the singleton and later exits must hand sync back automatically, so
// cross-channel conflicts after the first attempt keep retrying on the slow
// cadence and recover the moment the foreign owner disappears.
export async function runSyncHostStartupLoop(deps: SyncHostStartupLoopDeps): Promise<void> {
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const fastRetryDelayMs = deps.fastRetryDelayMs ?? 2_000;
  const slowRetryDelayMs = deps.slowRetryDelayMs ?? 30_000;
  const fastRetryCount = deps.fastRetryCount ?? 5;
  const attemptTimeoutMs = Math.max(1, deps.attemptTimeoutMs ?? 120_000);
  const sustainedStorageFaultAttempts = deps.sustainedStorageFaultAttempts ?? 3;
  let attempt = 0;
  let lastFailureSignature = "";
  let consecutiveStorageFaults = 0;
  let reportedSustainedStorageFault = false;
  const now = deps.now ?? Date.now;
  const conflictSummaryIntervalMs = deps.conflictSummaryIntervalMs ?? 10 * 60_000;
  let conflictOccurrences = 0;
  let lastConflictLoggedAt = 0;
  // Telemetry must never become a second failure path in a retry loop, so
  // every structured event in this loop goes out through this one guard.
  const logEvent = (event: string, meta: Record<string, unknown>): void => {
    try {
      deps.logEvent?.(event, meta);
    } catch {
      // Ignored on purpose: see above.
    }
  };
  /**
   * A sync-host conflict is not a transient failure: it means another ADE app
   * on this computer is open and owns sync. The generic deduper restates every
   * failure once a minute, which is how one Alpha brain logged the same
   * multi-line conflict 9,700 times. Keep the first occurrence's full detail —
   * it carries the quit command — then at most one single-line restatement per
   * `conflictSummaryIntervalMs`, with a count so the line still ages honestly.
   */
  const noteSyncHostConflict = (
    error: SyncHostSingletonConflictError,
    conflictAttempt: number,
  ): void => {
    const owner = error.conflict.owner;
    conflictOccurrences += 1;
    const at = now();
    if (conflictOccurrences === 1) {
      lastConflictLoggedAt = at;
      deps.log(error.message);
      logEvent("sync.host_start_failed", {
        signature: "SyncHostSingletonConflictError",
        attempt: conflictAttempt,
        code: "sync_host_singleton_conflict",
        ownerApp: owner.appName ?? null,
        ownerPid: owner.pid,
        ownerPort: owner.port ?? null,
        occurrences: 1,
        message: error.message,
      });
      return;
    }
    if (at - lastConflictLoggedAt < conflictSummaryIntervalMs) return;
    lastConflictLoggedAt = at;
    const line = `ADE brain sync host still blocked by ${owner.appName ?? "another ADE app"} (pid ${owner.pid}); ${conflictOccurrences} occurrences.`;
    deps.log(line);
    logEvent("sync.host_start_failed", {
      signature: "SyncHostSingletonConflictError",
      attempt: conflictAttempt,
      code: "sync_host_singleton_conflict",
      ownerApp: owner.appName ?? null,
      ownerPid: owner.pid,
      ownerPort: owner.port ?? null,
      occurrences: conflictOccurrences,
      message: line,
    });
  };
  // The deduper decides WHETHER this failure gets narrated (first occurrence,
  // then once a minute); routing the structured event through the same
  // callback is what keeps the two halves of the same failure at the same
  // cadence instead of flooding `brain.jsonl` every 2s.
  const failureLogs = createFailureLogDeduper({
    log: (message, meta) => {
      deps.log(message);
      logEvent("sync.host_start_failed", { ...meta, message });
    },
  });
  // The attempt that is still running, when the previous wait on it timed out.
  // Awaited again rather than replaced, so two starts never race for the lease.
  let pendingAttempt: Promise<{ ok: true } | { ok: false; error: unknown }> | null = null;
  let pendingAttemptStartedAt = 0;
  while (!deps.isDone()) {
    try {
      if (!pendingAttempt) {
        pendingAttemptStartedAt = now();
        pendingAttempt = Promise.resolve()
          .then(() => deps.startSyncHost())
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
      }
      let timer: ReturnType<typeof setTimeout> | null = null;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), attemptTimeoutMs);
        timer.unref?.();
      });
      let settled: Awaited<NonNullable<typeof pendingAttempt>> | "timeout";
      try {
        settled = await Promise.race([pendingAttempt, timedOut]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (settled === "timeout") {
        throw new SyncHostStartTimeoutError(now() - pendingAttemptStartedAt);
      }
      pendingAttempt = null;
      if (!settled.ok) throw settled.error;
      if (lastFailureSignature) failureLogs.clear(lastFailureSignature);
      // A recovery re-arms the conflict narration: a later conflict with a
      // different app should get its own first-occurrence full detail.
      conflictOccurrences = 0;
      lastConflictLoggedAt = 0;
      if (attempt > 0) {
        deps.log("ADE brain mobile sync host recovered.");
        logEvent("sync.host_start_recovered", { attempts: attempt, lastFailureSignature });
      } else {
        // A first-attempt success used to leave no trace at all, so a brain
        // whose sync host never started looked exactly like one whose started.
        logEvent("sync.host_started", { attempts: 1 });
      }
      return;
    } catch (error) {
      attempt += 1;
      if (error instanceof SyncHostStartTimeoutError) {
        // Still running: no sleep, the next pass waits on the same attempt.
        lastFailureSignature = error.name;
        failureLogs.note(error.name, error.message, {
          signature: error.name,
          attempt,
          code: "sync_host_start_timeout",
          waitedMs: error.waitedMs,
        });
        if (deps.maxAttempts != null && attempt >= deps.maxAttempts) return;
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      // A storage fault is permanent until the provider (or the disk, or the
      // mount) comes back, so it gets the classified sentence in the log, a
      // recorded failure the UI can show, and the slow cadence — never the raw
      // errno on a two-second loop, which is what reached the user.
      const storageFault = classifyStorageFault(error);
      const signature = storageFault
        ? storageFault.code
        : error instanceof Error ? error.name : typeof error;
      consecutiveStorageFaults = storageFault ? consecutiveStorageFaults + 1 : 0;
      if (error instanceof SyncHostSingletonConflictError) {
        // Conflict narration has its own cadence and its own single-line repeat
        // (see `noteSyncHostConflict`); routing it through the generic deduper
        // is what produced a multi-line message every minute.
        noteSyncHostConflict(error, attempt);
      } else {
        failureLogs.note(
          signature,
          storageFault
            ? `ADE brain sync host failed: ${storageFault.message}`
            : `ADE brain sync host failed: ${message}`,
          {
            signature,
            attempt,
            code: storageFault?.code ?? null,
            errno: storageFault?.errno ?? null,
            provider: storageFault?.provider ?? null,
          },
        );
      }
      lastFailureSignature = signature;
      if (storageFault) {
        try {
          deps.recordStorageFault?.(storageFault, message);
        } catch {
          // Recording the fault must not become a second failure path.
        }
        if (
          !reportedSustainedStorageFault
          && consecutiveStorageFaults >= sustainedStorageFaultAttempts
        ) {
          reportedSustainedStorageFault = true;
          try {
            deps.onSustainedStorageFault?.({ fault: storageFault, detail: message, attempt });
          } catch {
            // Same rule: asking for a diagnostic report is never allowed to
            // break the retry that might still recover this machine.
          }
        }
        if (deps.maxAttempts != null && attempt >= deps.maxAttempts) return;
        await sleep(slowRetryDelayMs);
        continue;
      }
      if (error instanceof SyncHostSingletonConflictError) {
        const owner = error.conflict.owner;
        const sameChannelOwner = isSameChannelSyncHostOwner(owner, deps.env);
        if (owner.pid !== process.pid && !sameChannelOwner) {
          // First attempt: let brain startup fail loudly (caller shows quit
          // instructions). Later attempts: the brain is already serving —
          // keep watching so sync recovers when the foreign owner exits.
          if (attempt === 1 && !deps.retryFirstConflict) {
            throw error;
          }
          if (deps.maxAttempts != null && attempt >= deps.maxAttempts) return;
          await sleep(slowRetryDelayMs);
          continue;
        }
        const serviceMainPid = deps.getServiceMainPid?.() ?? null;
        if (
          owner.pid !== process.pid
          && serviceMainPid === process.pid
          && sameChannelOwner
        ) {
          deps.log(
            `ADE brain taking over mobile sync from stale ${owner.appName ?? "ADE"} brain (pid ${owner.pid}).`,
          );
          logEvent("sync.host_takeover_stale_owner", {
            attempt,
            ownerApp: owner.appName ?? null,
            ownerPid: owner.pid,
          });
          await terminatePidAsync(owner.pid, { kill, pidAlive, sleep });
          continue;
        }
      }
      if (deps.maxAttempts != null && attempt >= deps.maxAttempts) return;
      await sleep(attempt <= fastRetryCount ? fastRetryDelayMs : slowRetryDelayMs);
    }
  }
}
