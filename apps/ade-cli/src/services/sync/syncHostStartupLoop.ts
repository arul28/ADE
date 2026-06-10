import {
  isSameChannelSyncHostOwner,
  SyncHostSingletonConflictError,
} from "./syncHostSingleton";

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
// A conflict with ANOTHER channel's live brain is different — it means a
// human deliberately launched a second build. Waiting would leave this brain
// running without mobile sync, which reads as "phone mysteriously frozen /
// talking to old code" rather than an error. Real builds never run sync-less:
// the conflict is rethrown so the caller can fail brain startup with the
// quit instructions in the message.
export async function runSyncHostStartupLoop(deps: SyncHostStartupLoopDeps): Promise<void> {
  const kill = deps.kill ?? defaultKill;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const sleep = deps.sleep ?? defaultSleep;
  const fastRetryDelayMs = deps.fastRetryDelayMs ?? 2_000;
  const slowRetryDelayMs = deps.slowRetryDelayMs ?? 30_000;
  const fastRetryCount = deps.fastRetryCount ?? 5;
  let attempt = 0;
  let lastLoggedMessage = "";
  while (!deps.isDone()) {
    try {
      await deps.startSyncHost();
      if (attempt > 0) deps.log("ADE brain mobile sync host recovered.");
      return;
    } catch (error) {
      attempt += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (message !== lastLoggedMessage) {
        deps.log(`ADE brain sync host failed: ${message}`);
        lastLoggedMessage = message;
      }
      if (error instanceof SyncHostSingletonConflictError) {
        const owner = error.conflict.owner;
        if (owner.pid !== process.pid && !isSameChannelSyncHostOwner(owner, deps.env)) {
          throw error;
        }
        const serviceMainPid = deps.getServiceMainPid?.() ?? null;
        if (
          owner.pid !== process.pid
          && serviceMainPid === process.pid
          && isSameChannelSyncHostOwner(owner, deps.env)
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
