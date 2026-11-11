/**
 * The sign-in sync service in the brain (P5). It carries the person's
 * provider sign-ins between their computers through the account vault:
 *
 * - Capture (`providerLoginCapture.ts`): a sign-in made on this computer goes
 *   into the account, only while the account has ADE Cloud and the person
 *   switched its sign-ins on.
 * - Apply (`providerLoginApplyPass.ts`): a cloud computer writes the sign-in
 *   the account picked for each provider.
 * - The gate (`providerLoginGate.ts`): a cloud computer checks the copy
 *   before a turn, with a short wait when it is about to expire.
 * - Renewal (`providerLoginTakeover.ts`): the owner computer renews ahead of
 *   expiry; when it is off, a cloud computer takes the renewal over, and the
 *   origin writes the newer copy back when it wakes.
 * - The person's reads (`providerLoginAllow.ts`): the Keychain on a Mac and
 *   Copilot's GitHub CLI login.
 * - The person's writes (`providerLoginWrites.ts`) and the status
 *   (`providerLoginStatus.ts`).
 * - The ticks (`providerLoginAccess.ts`): the service rides the vault and
 *   settings ticks only for an account with ADE Cloud.
 *
 * Every job shares one state object (`providerLoginSyncShared.ts`). This file
 * builds them and returns the service.
 *
 * Never logs a value, a hash or a file's content: events carry the provider,
 * the slot, sizes and reason codes.
 */

import type { ProviderLoginProvider, ProviderLoginStatus } from "../../../shared/types/providerLogins";
import { onProviderLoginChanged } from "../ai/providerLoginChanged";
import { createAccess } from "./providerLoginAccess";
import { createAllow } from "./providerLoginAllow";
import { createApplyPass } from "./providerLoginApplyPass";
import { createCapture } from "./providerLoginCapture";
import { PROVIDER_LOGIN_CARRY } from "./providerLoginCarry";
import { setCopilotCarriedToken } from "./providerLoginCopilotEnv";
import { createGate } from "./providerLoginGate";
import { installProviderLoginGate } from "./providerLoginHooks";
import { removeProviderLoginState } from "./providerLoginState";
import { createStatus } from "./providerLoginStatus";
import { OFF_MESSAGES, createSyncShared, type ProviderLoginSyncDeps, type SyncJobs } from "./providerLoginSyncShared";
import { createTakeover } from "./providerLoginTakeover";
import { createWrites } from "./providerLoginWrites";

export type {
  CloudAccessState,
  ProviderLoginSettings,
  ProviderLoginSyncDeps,
  ProviderLoginVault,
} from "./providerLoginSyncShared";

export function createProviderLoginSync(deps: ProviderLoginSyncDeps) {
  const s = createSyncShared(deps);
  const { bundleMemos, localStates, metaMemo, settleMs, settleTimers, ticks } = s;
  const releases: Array<() => void> = [];

  const capture = createCapture(s);
  const { status } = createStatus(s);
  const { saveSetting, writes } = createWrites(s);
  const apply = createApplyPass(s);
  const { gate } = createGate(s);
  const takeover = createTakeover(s);
  const allow = createAllow(s);
  const access = createAccess(s);
  // The jobs call each other only when they run, never while they are built.
  const jobs: SyncJobs = {
    ...capture,
    status,
    saveSetting,
    runApply: apply.runApply,
    loadApplied: apply.loadApplied,
    isAppliedBundle: apply.isAppliedBundle,
    ownedPlaceFor: apply.ownedPlaceFor,
    noteOwnedCopy: apply.noteOwnedCopy,
    ...takeover,
    keychainStatus: allow.keychainStatus,
    ghCliStatus: allow.ghCliStatus,
    ghCliMessage: allow.ghCliMessage,
    leaveTicks: access.leaveTicks,
  };
  Object.assign(s.jobs, jobs);
  const { pass } = capture;
  const { refreshAccess } = access;

  return {
    /**
     * Hear sign-ins on this computer and check the account's ADE Cloud answer
     * once. The vault and settings ticks are joined only while that answer is
     * "ready" (`refreshAccess`). Does nothing when capture can never run here.
     */
    start(): void {
      if (deps.staticOff || releases.length) return;
      releases.push(onProviderLoginChanged((provider) => {
        if (!ticks.length) return;
        const row = PROVIDER_LOGIN_CARRY.find((entry) => entry.provider === provider);
        if (!row || row.carry !== "carried") return;
        clearTimeout(settleTimers.get(provider));
        const timer = setTimeout(() => {
          settleTimers.delete(provider);
          void pass([row.provider]);
        }, settleMs);
        timer.unref?.();
        settleTimers.set(provider, timer);
      }));
      const releaseAccess = deps.onCloudAccessChanged?.(() => void refreshAccess());
      if (releaseAccess) releases.push(releaseAccess);
      if (deps.cloudComputer) {
        installProviderLoginGate(gate);
        releases.push(() => installProviderLoginGate(null));
      }
      void refreshAccess();
    },
    stop(): void {
      for (const release of releases.splice(0)) release();
      access.leaveTicks();
      access.clearAccessRecheck();
      for (const timer of settleTimers.values()) clearTimeout(timer);
      settleTimers.clear();
    },
    refreshAccess,
    ...writes,
    allowKeychain: allow.allowKeychain,
    allowGitHubCli: allow.allowGitHubCli,
    pass,
    status,
    /** The person's "look now": one pass (still behind every gate), then the status. */
    async captureNow(provider?: ProviderLoginProvider | null): Promise<ProviderLoginStatus> {
      await pass(provider ? [provider] : null);
      return await status(provider);
    },
    /** On ADE sign-out: drop the marks; the vault purge removes the account copy here. */
    forgetAccount(): void {
      // An apply in flight for this account stops before its next write, and
      // on a cloud computer the account's sign-ins leave with the account.
      apply.forgetApplied();
      bundleMemos.clear();
      localStates.clear();
      metaMemo.clear();
      s.stateCache = null;
      // The GitHub CLI choice leaves with the marks file: another account starts with it off.
      s.ghMemo = null;
      s.ghForce = false;
      setCopilotCarriedToken(null);
      try {
        removeProviderLoginState(deps.adeDir);
      } catch (error) {
        // Nothing secret is in it; the next account's load starts it over anyway.
        deps.logger.warn("provider_login.state_remove_failed", { code: (error as NodeJS.ErrnoException)?.code ?? null });
      }
    },
  };
}

export type ProviderLoginSync = ReturnType<typeof createProviderLoginSync>;

let processSync: ProviderLoginSync | null = null;

/** The brain installs its one service here at start; the actions read it. */
export function installProviderLoginSync(sync: ProviderLoginSync | null): void {
  processSync?.stop();
  processSync = sync;
  sync?.start();
}

export function providerLoginSync(): ProviderLoginSync | null {
  return processSync;
}

export const PROVIDER_LOGIN_NOT_THIS_RUNTIME = OFF_MESSAGES.not_this_runtime;
