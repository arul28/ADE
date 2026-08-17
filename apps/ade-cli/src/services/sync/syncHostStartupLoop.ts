import {
  isSameChannelSyncHostOwner,
  SyncHostSingletonConflictError,
} from "./syncHostSingleton";
import { createFailureLogDeduper } from "../runtime/failureLogDeduper";

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
  let attempt = 0;
  let lastFailureSignature = "";
  const failureLogs = createFailureLogDeduper({ log: deps.log });
  while (!deps.isDone()) {
    try {
      await deps.startSyncHost();
      if (lastFailureSignature) failureLogs.clear(lastFailureSignature);
      if (attempt > 0) deps.log("ADE brain mobile sync host recovered.");
      return;
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      const signature = error instanceof Error ? error.name : typeof error;
      failureLogs.note(signature, `ADE brain sync host failed: ${message}`);
      lastFailureSignature = signature;
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
