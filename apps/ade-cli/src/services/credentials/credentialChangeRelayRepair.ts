import { EncryptedFileCredentialStore } from "./credentialStore";

/**
 * Ends the GitHub relay's auth-pending cooldown as soon as the credential it is
 * waiting on changes on disk.
 *
 * The desktop app gets this for free: it owns both the auth service and the
 * ingress, so it calls `pollNow()` from `onAppUserAuthChanged`. The ADE brain
 * owns neither — the credential is written by whichever process ran the device
 * flow — so it watches the shared machine file that every process reads from.
 * Without this the brain sits out the full five-minute cooldown after a repair
 * the user already finished.
 *
 * Best-effort throughout: a store with no watcher, or a watcher that cannot be
 * installed, leaves the behaviour exactly as it was.
 */

/** At most one forced poll per this window, however noisy the file is. */
export const CREDENTIAL_CHANGE_POLL_COALESCE_MS = 5_000;

/**
 * How often this watcher stats the credential file.
 *
 * Deliberately slower than the store's own default. The account service already
 * watches the same file at that rate, and what this one replaces is a
 * FIVE-MINUTE cooldown — reacting two seconds after the write instead of a
 * quarter of a second is not a difference anyone can perceive, and it halves
 * the polling this file attracts.
 */
const CREDENTIAL_CHANGE_WATCH_INTERVAL_MS = 2_000;

export type CredentialChangeRelayRepairArgs = {
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  pollNow: () => Promise<void> | void;
  /**
   * The store to watch. Defaults to the shared machine credential file, which
   * is where every ADE process reads the GitHub App credential from.
   */
  credentialStore?: { onDidChange?(listener: () => void): () => void } | null;
  now?: () => number;
};

export function watchCredentialsForRelayRepair(
  args: CredentialChangeRelayRepairArgs,
): () => void {
  const now = args.now ?? (() => Date.now());
  let store = args.credentialStore;
  if (store === undefined) {
    try {
      store = new EncryptedFileCredentialStore({
        credentialChangePollIntervalMs: CREDENTIAL_CHANGE_WATCH_INTERVAL_MS,
      });
    } catch {
      return () => undefined;
    }
  }
  if (!store?.onDidChange) return () => undefined;
  let lastForcedPollMs = Number.NEGATIVE_INFINITY;
  const onChange = (): void => {
    const nowMs = now();
    // A single sign-in rewrites the file several times, and every ADE process
    // on the machine sees each write. Coalescing keeps one repair from turning
    // into a burst of relay polls.
    if (nowMs - lastForcedPollMs < CREDENTIAL_CHANGE_POLL_COALESCE_MS) return;
    lastForcedPollMs = nowMs;
    try {
      void Promise.resolve(args.pollNow()).catch((error: unknown) => {
        args.logger.warn("automations.github_relay_credential_repoll_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } catch (error) {
      args.logger.warn("automations.github_relay_credential_repoll_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };
  try {
    return store.onDidChange(onChange);
  } catch {
    return () => undefined;
  }
}
