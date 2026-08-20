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

/** The credential this repair exists for. Other keys share the same file. */
const GITHUB_APP_USER_TOKEN_KEY = "github.appUserToken.v1";

/** At most one forced poll per this window, however noisy the file is. */
export const CREDENTIAL_CHANGE_POLL_COALESCE_MS = 5_000;

/**
 * How often the watcher this module installs stats the credential file.
 *
 * Deliberately slower than the store's own 250 ms default. What this replaces
 * is a FIVE-MINUTE cooldown, so reacting two seconds after the write instead of
 * a quarter of a second is not a difference anyone can perceive, and the slower
 * interval costs the file eight times fewer stats.
 */
const CREDENTIAL_CHANGE_WATCH_INTERVAL_MS = 2_000;

type WatchableCredentialStore = {
  onDidChange?(listener: () => void): () => void;
  getSync?(key: string): string | null;
  credentialStoreIdentity?(): string;
};

export type CredentialChangeRelayRepairArgs = {
  logger: { warn(message: string, meta?: Record<string, unknown>): void };
  pollNow: () => Promise<void> | void;
  /**
   * The store to watch. Defaults to the shared machine credential file, which
   * is where every ADE process reads the GitHub App credential from.
   */
  credentialStore?: WatchableCredentialStore;
  now?: () => number;
};

type SharedWatch = {
  listeners: Set<() => void>;
  dispose: () => void;
};

/**
 * One underlying file watcher per credential file per process.
 *
 * Every project runtime in this process installs a repair watcher, and they all
 * read the same machine credential file. Without this registry a machine with
 * ten open projects stats that file ten times per interval to learn the same
 * fact.
 */
const sharedWatches = new Map<string, SharedWatch>();

function subscribeShared(
  store: WatchableCredentialStore,
  onDidChange: (listener: () => void) => () => void,
  listener: () => void,
): () => void {
  let identity: string | null = null;
  try {
    identity = store.credentialStoreIdentity?.() ?? null;
  } catch {
    identity = null;
  }
  if (identity === null) return onDidChange(listener);

  const key = identity;
  let shared = sharedWatches.get(key);
  if (!shared) {
    const listeners = new Set<() => void>();
    const dispose = onDidChange(() => {
      for (const each of [...listeners]) each();
    });
    shared = { listeners, dispose };
    sharedWatches.set(key, shared);
  }
  shared.listeners.add(listener);
  return () => {
    const current = sharedWatches.get(key);
    if (!current?.listeners.delete(listener)) return;
    if (current.listeners.size > 0) return;
    sharedWatches.delete(key);
    current.dispose();
  };
}

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
  const onDidChange = store?.onDidChange;
  if (!store || typeof onDidChange !== "function") return () => undefined;
  const watched = store;

  const warnRepollFailed = (error: unknown): void => {
    args.logger.warn("automations.github_relay_credential_repoll_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  };

  /**
   * False for a store that cannot be read by key, which keeps the old
   * behaviour — every change forces a poll — because there is nothing to scope
   * the repair to.
   */
  const scoped = typeof watched.getSync === "function";

  /**
   * The App credential's current value, or the last known one when the file
   * cannot be read. Whole-file re-encryption changes every byte on disk on
   * every write, so only the decrypted value says whether THIS key moved.
   */
  const readAppUserToken = (previous: string | null): string | null => {
    if (!scoped) return previous;
    try {
      return watched.getSync?.(GITHUB_APP_USER_TOKEN_KEY) ?? null;
    } catch {
      return previous;
    }
  };

  let lastSeenAppUserToken = readAppUserToken(null);
  let lastForcedPollMs = Number.NEGATIVE_INFINITY;
  let pendingPoll: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const forcePoll = (): void => {
    lastForcedPollMs = now();
    try {
      void Promise.resolve(args.pollNow()).catch(warnRepollFailed);
    } catch (error) {
      warnRepollFailed(error);
    }
  };

  const onChange = (): void => {
    if (stopped) return;
    const token = readAppUserToken(lastSeenAppUserToken);
    // Every ADE process sees every write to this file, and account sessions
    // rotate far more often than the App credential does. Only the credential
    // the relay is waiting on is worth a forced poll.
    if (scoped && token === lastSeenAppUserToken) return;
    lastSeenAppUserToken = token;

    const nowMs = now();
    const sinceLastPoll = nowMs - lastForcedPollMs;
    if (sinceLastPoll >= CREDENTIAL_CHANGE_POLL_COALESCE_MS) {
      forcePoll();
      return;
    }
    // A single sign-in rewrites the file several times. Coalesce on the
    // trailing edge: one timer for the whole burst, and it fires after the
    // last write, so the poll always sees the final credential.
    if (pendingPoll) return;
    pendingPoll = setTimeout(() => {
      pendingPoll = null;
      if (stopped) return;
      forcePoll();
    }, CREDENTIAL_CHANGE_POLL_COALESCE_MS - sinceLastPoll);
    pendingPoll.unref?.();
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = subscribeShared(watched, onDidChange.bind(watched), onChange);
  } catch {
    return () => undefined;
  }
  return () => {
    if (stopped) return;
    stopped = true;
    if (pendingPoll) {
      clearTimeout(pendingPoll);
      pendingPoll = null;
    }
    unsubscribe();
  };
}
