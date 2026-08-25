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
};

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
  const sustainedStorageFaultAttempts = deps.sustainedStorageFaultAttempts ?? 3;
  let attempt = 0;
  let lastFailureSignature = "";
  let consecutiveStorageFaults = 0;
  let reportedSustainedStorageFault = false;
  // Telemetry must never become a second failure path in a retry loop, so
  // every structured event in this loop goes out through this one guard.
  const logEvent = (event: string, meta: Record<string, unknown>): void => {
    try {
      deps.logEvent?.(event, meta);
    } catch {
      // Ignored on purpose: see above.
    }
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
  while (!deps.isDone()) {
    try {
      await deps.startSyncHost();
      if (lastFailureSignature) failureLogs.clear(lastFailureSignature);
      if (attempt > 0) {
        deps.log("ADE brain mobile sync host recovered.");
        logEvent("sync.host_start_recovered", { attempts: attempt, lastFailureSignature });
      }
      return;
    } catch (error) {
      attempt += 1;
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
          if (attempt === 1) {
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
          await terminatePidAsync(owner.pid, { kill, pidAlive, sleep });
          continue;
        }
      }
      if (deps.maxAttempts != null && attempt >= deps.maxAttempts) return;
      await sleep(attempt <= fastRetryCount ? fastRetryDelayMs : slowRetryDelayMs);
    }
  }
}
