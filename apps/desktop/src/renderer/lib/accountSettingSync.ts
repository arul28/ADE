import { useEffect } from "react";
import { ACCOUNT_SCOPE_ALL } from "../../shared/accountSettingsScope";
import { captureError } from "../../shared/sentry/capture";
import { fetchAccountStatus, subscribeAccountStatus } from "./account";
import { isWebClientMode } from "./webClientMode";

/**
 * The pass loop behind a renderer value kept on the account as one
 * account-wide setting ("What's new" seen pages, onboarding progress): read
 * the account's copy, combine it with this computer's, write back what the
 * account lacks.
 *
 * The desktop reaches the setting through its brain, whose copy can be older
 * than the account: it pulls once per account before the first read, and an
 * empty copy it has not pulled is never written over. ADE Web reaches it
 * through the account relay. Signed out, offline or with no settings bridge,
 * a pass does nothing and this computer's copy decides.
 */

export type AccountSettingPass = {
  /** The account's value as stored, not yet validated. */
  remote: unknown;
  userId: string;
};

export type AccountSettingPassResult = {
  /** What to write to the account; null when it already holds everything. */
  write: unknown | null;
  /** The account's copy held nothing (after validation). */
  accountEmpty: boolean;
};

export type AccountSettingSyncOptions = {
  key: string;
  /** A caller waiting on a pass never waits longer than this. */
  timeoutMs: number;
  /** Sentry fingerprint for the first failed pass. */
  fingerprint: string[];
  /** Runs first in every pass with the signed-in account (null: none), before anything can fail. */
  onAccount?: (userId: string | null) => void;
  /** Combines the account's copy with this computer's, takes the result here, and says what to write back. */
  reconcile: (pass: AccountSettingPass) => AccountSettingPassResult;
};

export type AccountSettingSync = {
  /** One reconcile. Resolves when done, failed or too slow; never rejects. A call while one runs makes one more pass after it. */
  reconcile: () => Promise<void>;
  /** Whether a pass has read the account's copy for this account. */
  reconciledFor: (userId: string | null) => boolean;
};

function signedInUserId(status: Awaited<ReturnType<typeof fetchAccountStatus>> | null): string | null {
  return status?.signedIn ? status.userId?.trim() || null : null;
}

export function createAccountSettingSync(options: AccountSettingSyncOptions): AccountSettingSync {
  let running: Promise<void> | null = null;
  let rerun = false;
  let reportedFailure = false;
  /** The account whose settings the desktop brain pulled fresh this session. */
  let brainSyncedFor: string | null = null;
  let lastReconciledFor: string | null = null;

  const onePass = async (): Promise<void> => {
    const userId = signedInUserId(await fetchAccountStatus().catch(() => null));
    options.onAccount?.(userId);
    const api = window.ade?.accountSettings;
    if (!userId || !api?.get || !api.set) return;
    const web = isWebClientMode();
    if (!web && brainSyncedFor !== userId && api.sync) {
      const synced = await api.sync().catch(() => null);
      // Only a pull that reached the account counts (null: an older brain that cannot say).
      if (synced?.ok && (synced.value == null || synced.value === "ready")) brainSyncedFor = userId;
    }
    const read = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: options.key });
    if (!read.ok) return;
    // The pull and the read can span a sign-in change: take and write this copy only for the same account.
    if (signedInUserId(await fetchAccountStatus({ force: true }).catch(() => null)) !== userId) return;
    const { write, accountEmpty } = options.reconcile({ remote: read.value, userId });
    lastReconciledFor = userId;
    if (write === null) return;
    // Not pulled fresh and the account looks empty: it may be only this brain's stale copy.
    if (!web && brainSyncedFor !== userId && accountEmpty) return;
    // The fence: the brain refuses the write if another account signed in meanwhile.
    await api.set({ scope: ACCOUNT_SCOPE_ALL, key: options.key, value: write, expectedAccountUserId: userId });
  };

  const startPasses = (): Promise<void> =>
    (async () => {
      do {
        rerun = false;
        try {
          await onePass();
        } catch (error) {
          // The local copy stands; the next trigger tries again. Report the first failure only.
          if (!reportedFailure) {
            reportedFailure = true;
            captureError(error, { fingerprint: options.fingerprint, level: "warning", handled: true });
          }
        }
      } while (rerun);
    })();

  return {
    reconcile: () => {
      if (running) {
        rerun = true;
      } else {
        running = startPasses().finally(() => {
          running = null;
        });
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, options.timeoutMs);
      });
      return Promise.race([running, timeout]).finally(() => clearTimeout(timer));
    },
    reconciledFor: (userId) => userId != null && lastReconciledFor === userId,
  };
}

/**
 * Reconciles when the app opens, when an account signs in, when the account
 * settings change elsewhere, and when `subscribeLocal` reports a change here
 * (after `localDelayMs`, so a burst of changes is one pass).
 */
export function useAccountSettingSync(
  sync: AccountSettingSync,
  subscribeLocal: ReadonlyArray<(listener: () => void) => () => void>,
  localDelayMs = 0,
): void {
  useEffect(() => {
    const reconcile = () => void sync.reconcile();
    reconcile();
    let signedIn: boolean | null = null;
    const stopAccount = subscribeAccountStatus((status) => {
      if (status.signedIn === signedIn) return;
      signedIn = status.signedIn;
      if (status.signedIn) reconcile();
    });
    const stopRemote = window.ade?.accountSettings?.onChanged?.(reconcile);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const local = localDelayMs > 0
      ? () => {
        if (timer) return;
        timer = setTimeout(() => {
          timer = null;
          reconcile();
        }, localDelayMs);
      }
      : reconcile;
    const stops = subscribeLocal.map((subscribe) => subscribe(local));
    return () => {
      stopAccount();
      stopRemote?.();
      for (const stop of stops) stop();
      if (timer) clearTimeout(timer);
    };
    // The subscriptions are module-level functions passed once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, localDelayMs]);
}
