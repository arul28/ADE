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
 * than the account: it pulls once per account before the first read, and
 * writes only once a pull reached the account (an older copy written back
 * would replace newer answers). ADE Web reaches it through its own account
 * settings bridge (the relay, or the connected computer for some keys) and,
 * since it hears only its own writes, reads again when the page comes back
 * into view. Signed out, offline or with no settings bridge,
 * a pass does nothing and this computer's copy decides.
 */

export type AccountValuePass = {
  /** The account's value as stored, not yet validated. */
  remote: unknown;
  userId: string;
  /** The read is the account's current copy (ADE Web, or a desktop brain that pulled), not a possibly stale cache. */
  fresh: boolean;
};

export type AccountValuePassResult = {
  /** What to write to the account; null when it already holds everything. */
  write: unknown | null;
  /** False when the pass left this computer's copy as it was (it waits for a fresh read). */
  taken?: boolean;
};

export type AccountValueSyncOptions = {
  key: string;
  /** A caller waiting on a pass never waits longer than this. */
  timeoutMs: number;
  /** Sentry fingerprint for the first failed pass. */
  fingerprint: string[];
  /** Runs first in every pass with the signed-in account (null: none), before anything can fail. */
  onAccount?: (userId: string | null) => void;
  /** Combines the account's copy with this computer's, takes the result here, and says what to write back. */
  reconcile: (pass: AccountValuePass) => AccountValuePassResult;
};

export type AccountValueSync = {
  /** One reconcile. Resolves when done, failed or too slow; never rejects. A call while one runs makes one more pass after it. */
  reconcile: () => Promise<void>;
  /** Whether a pass has read the account's copy for this account. */
  reconciledFor: (userId: string | null) => boolean;
};

function signedInUserId(status: Awaited<ReturnType<typeof fetchAccountStatus>> | null): string | null {
  return status?.signedIn ? status.userId?.trim() || null : null;
}

/** After a failed brain pull, the next one waits this long. */
const PULL_RETRY_MS = 5 * 60_000;

export function createAccountValueSync(options: AccountValueSyncOptions): AccountValueSync {
  let running: Promise<void> | null = null;
  let rerun = false;
  let reportedFailure = false;
  /** The account whose settings the desktop brain pulled fresh this session. */
  let brainSyncedFor: string | null = null;
  /** The account whose pull last failed, and when: its next try waits, so offline passes do not each run a full brain sync. */
  let pullFailed: { userId: string; at: number } | null = null;
  let lastReconciledFor: string | null = null;

  const onePass = async (): Promise<void> => {
    const userId = signedInUserId(await fetchAccountStatus().catch(() => null));
    options.onAccount?.(userId);
    const api = window.ade?.accountSettings;
    if (!userId || !api?.get || !api.set) return;
    const web = isWebClientMode();
    const coolingDown = pullFailed?.userId === userId && Date.now() - pullFailed.at < PULL_RETRY_MS;
    if (!web && brainSyncedFor !== userId && api.sync && !coolingDown) {
      const synced = await api.sync().catch(() => null);
      // Only a pull that reached the account counts (null: an older brain that cannot say).
      if (synced?.ok && (synced.value == null || synced.value === "ready")) brainSyncedFor = userId;
      else pullFailed = { userId, at: Date.now() };
    }
    const read = await api.get({ scope: ACCOUNT_SCOPE_ALL, key: options.key });
    if (!read.ok) return;
    // The pull and the read can span a sign-in change: take and write this copy only for the same account.
    // Forced: a sign-in made in another window or through the CLI never reaches this window's cached status.
    if (signedInUserId(await fetchAccountStatus({ force: true }).catch(() => null)) !== userId) return;
    const fresh = web || brainSyncedFor === userId;
    const { write, taken } = options.reconcile({ remote: read.value, userId, fresh });
    if (taken !== false) lastReconciledFor = userId;
    // Not fresh: the read may be only this brain's stale copy. A later pass that pulled writes it.
    if (write === null || !fresh) return;
    // The fence: the brain refuses the write if another account signed in meanwhile; the next pass is that account's.
    const written = await api.set({ scope: ACCOUNT_SCOPE_ALL, key: options.key, value: write, expectedAccountUserId: userId });
    if (!written.ok && "rejected" in written) console.debug(`[account] ${options.key} write refused: the account changed`);
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

const WEB_REVISIT_MIN_MS = 60_000;

/**
 * Reconciles when the app opens, when an account signs in, when the account
 * settings change elsewhere (in ADE Web: when the page comes back into view),
 * and when `subscribeLocal` reports a change here (after `localDelayMs`, so a
 * burst of changes is one pass).
 */
export function useAccountValueSync(
  sync: AccountValueSync,
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
    // ADE Web hears only its own writes: read again when the page comes back, at most once a minute.
    let lastVisibleRead = Date.now();
    const onVisible = () => {
      if (document.visibilityState !== "visible" || Date.now() - lastVisibleRead < WEB_REVISIT_MIN_MS) return;
      lastVisibleRead = Date.now();
      reconcile();
    };
    const web = isWebClientMode();
    if (web) document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopAccount();
      stopRemote?.();
      for (const stop of stops) stop();
      if (timer) clearTimeout(timer);
      if (web) document.removeEventListener("visibilitychange", onVisible);
    };
    // The subscriptions are module-level functions passed once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sync, localDelayMs]);
}
