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

/**
 * What one read of the App credential produced.
 *
 * "The read failed" is a separate answer from "the value is null", because the
 * two must lead to opposite decisions: an absent credential is a fact worth
 * comparing against, an unreadable store is no information at all.
 */
type AppUserTokenRead =
  | { kind: "value"; value: string | null }
  | { kind: "read_failed" };

type AppUserTokenListener = (read: AppUserTokenRead) => void;

/**
 * Reads the App credential, or reports that it could not be read.
 *
 * A store with no `getSync` is reported the same way a throwing one is: there
 * is nothing to scope the repair to, so every change has to force a poll.
 */
function readAppUserToken(store: WatchableCredentialStore): AppUserTokenRead {
  const getSync = store.getSync;
  if (typeof getSync !== "function") return { kind: "read_failed" };
  try {
    return { kind: "value", value: getSync.call(store, GITHUB_APP_USER_TOKEN_KEY) ?? null };
  } catch {
    return { kind: "read_failed" };
  }
}

type SharedWatch = {
  listeners: Set<AppUserTokenListener>;
  /**
   * The most recent read over this file, and the baseline a listener that joins
   * later starts from. Kept here so N runtimes cost ONE locked decrypt per
   * change instead of one each.
   */
  lastRead: AppUserTokenRead;
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

function createWatch(
  store: WatchableCredentialStore,
  onDidChange: (listener: () => void) => () => void,
): SharedWatch {
  const listeners = new Set<AppUserTokenListener>();
  const watch: SharedWatch = {
    listeners,
    lastRead: readAppUserToken(store),
    dispose: () => undefined,
  };
  watch.dispose = onDidChange(() => {
    const read = readAppUserToken(store);
    watch.lastRead = read;
    for (const each of [...listeners]) {
      try {
        each(read);
      } catch {
        // Per-subscriber isolation, the same guarantee the store's own change
        // watcher documents: one runtime's repair throwing must not stop the
        // other runtimes on this file from hearing about the change.
      }
    }
  });
  return watch;
}

function subscribeShared(
  store: WatchableCredentialStore,
  onDidChange: (listener: () => void) => () => void,
  listener: AppUserTokenListener,
): { baseline: AppUserTokenRead; unsubscribe: () => void } {
  let identity: string | null = null;
  try {
    identity = store.credentialStoreIdentity?.() ?? null;
  } catch {
    identity = null;
  }
  if (identity === null) {
    const watch = createWatch(store, onDidChange);
    watch.listeners.add(listener);
    return {
      baseline: watch.lastRead,
      unsubscribe: () => {
        if (!watch.listeners.delete(listener)) return;
        watch.dispose();
      },
    };
  }

  const key = identity;
  let shared = sharedWatches.get(key);
  if (!shared) {
    shared = createWatch(store, onDidChange);
    sharedWatches.set(key, shared);
  }
  shared.listeners.add(listener);
  return {
    baseline: shared.lastRead,
    unsubscribe: () => {
      const current = sharedWatches.get(key);
      if (!current?.listeners.delete(listener)) return;
      if (current.listeners.size > 0) return;
      sharedWatches.delete(key);
      current.dispose();
    },
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
   * The last read this watcher acted on. Whole-file re-encryption changes every
   * byte on disk on every write, so only the decrypted value says whether THIS
   * key moved.
   */
  let lastSeenAppUserToken: AppUserTokenRead = { kind: "read_failed" };
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

  const onChange = (read: AppUserTokenRead): void => {
    if (stopped) return;
    const previous = lastSeenAppUserToken;
    lastSeenAppUserToken = read;
    // Every ADE process sees every write to this file, and account sessions
    // rotate far more often than the App credential does. Only the credential
    // the relay is waiting on is worth a forced poll.
    //
    // Fail OPEN when the read did not produce a value: a store that cannot be
    // decrypted right now tells us nothing about whether the App credential
    // moved, and the cost of a poll nobody needed is one HTTP call, while the
    // cost of skipping one is the full five-minute cooldown. The same rule run
    // against the baseline is what keeps an unreadable store at install time
    // from suppressing every later poll.
    if (
      read.kind === "value"
      && previous.kind === "value"
      && read.value === previous.value
    ) {
      return;
    }

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
    const subscription = subscribeShared(watched, onDidChange.bind(watched), onChange);
    lastSeenAppUserToken = subscription.baseline;
    unsubscribe = subscription.unsubscribe;
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
