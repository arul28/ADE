/**
 * Joining the shared ticks only for an account with ADE Cloud (F1). An
 * account without ADE Cloud, or a signed-out one, gets no periodic sync and
 * no timer from this service: the ticks are left, and the answer is not
 * asked again on a timer. A change is heard from `cloudAccess.ts` whenever
 * any caller in this process asks, and at account sign-in and sign-out.
 */

import {
  ACCESS_RECHECK_MAX_MS,
  ACCESS_RECHECK_MIN_MS,
  type CloudAccessState,
  type SyncShared,
} from "./providerLoginSyncShared";

export function createAccess(s: SyncShared) {
  const { deps, settleTimers, ticks, jobs } = s;

  let accessRecheck: ReturnType<typeof setTimeout> | null = null;
  let accessRecheckDelayMs = ACCESS_RECHECK_MIN_MS;
  let accessGeneration = 0;

  function joinTicks(): void {
    if (ticks.length) return;
    const vault = deps.vault();
    if (vault) {
      ticks.push(vault.startPeriodicSync(undefined, (syncStatus) => {
        if (syncStatus === "ready") void jobs.pass();
      }));
    }
    const releaseSettings = deps.settings()?.startPeriodicSync?.();
    if (releaseSettings) ticks.push(releaseSettings);
    if (!ticks.length) return;
    deps.logger.info("provider_login.ticks_joined", {});
    // One pass now from the cached vault (no network): capture starts, and a
    // cloud computer applies at boot without waiting for the first tick.
    void jobs.pass();
  }

  function leaveTicks(): void {
    jobs.stopRenewals();
    jobs.disarmAll();
    if (!ticks.length) return;
    for (const release of ticks.splice(0)) release();
    for (const timer of settleTimers.values()) clearTimeout(timer);
    settleTimers.clear();
    deps.logger.info("provider_login.ticks_left", {});
  }

  function clearAccessRecheck(): void {
    if (accessRecheck) clearTimeout(accessRecheck);
    accessRecheck = null;
  }

  /** Read the ADE Cloud answer (free when cached) and join or leave the ticks to match. */
  function refreshAccess(): Promise<CloudAccessState | null> {
    const pending = readAndMatchAccess().finally(() => {
      if (s.accessPending === pending) s.accessPending = null;
    });
    s.accessPending = pending;
    return pending;
  }

  async function readAndMatchAccess(): Promise<CloudAccessState | null> {
    if (deps.staticOff) return null;
    const generation = ++accessGeneration;
    const state: CloudAccessState = !deps.accountUserId() || !deps.vault()
      ? "signed_out"
      : await deps.cloudAccess().catch((): CloudAccessState => "unreadable");
    // A newer check (a sign-out during the ask) decides instead.
    if (generation !== accessGeneration) return state;
    if (state === "ready") joinTicks();
    else leaveTicks();
    if (state === "unreadable") {
      // Not an answer about the account: ask again later, backing off, until there is one.
      clearAccessRecheck();
      accessRecheck = setTimeout(() => {
        accessRecheck = null;
        void refreshAccess();
      }, accessRecheckDelayMs);
      accessRecheck.unref?.();
      accessRecheckDelayMs = Math.min(accessRecheckDelayMs * 2, ACCESS_RECHECK_MAX_MS);
    } else {
      clearAccessRecheck();
      accessRecheckDelayMs = ACCESS_RECHECK_MIN_MS;
    }
    return state;
  }

  return { refreshAccess, leaveTicks, clearAccessRecheck };
}
