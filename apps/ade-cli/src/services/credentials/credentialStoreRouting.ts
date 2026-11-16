import {
  isFileBackedCredentialKey,
  normalizeCredentialKey,
  type SyncCredentialStore,
} from "./credentialStore";
import { updateCredentialKeySync } from "./updateCredentialKey";

/**
 * Stores that stand in front of the real ones: the per-key router, and the
 * store that answers every call with the reason it cannot work.
 *
 * Split out of credentialStore.ts because neither reads or writes a byte — they
 * decide which store a call belongs to. Consumers import them from this module
 * directly: re-exporting them through credentialStore.ts made the two modules
 * import each other, so the re-export was removed.
 */

/**
 * One store that keeps file-backed keys in the shared machine file and
 * everything else in `primary`.
 *
 * The desktop app's own store is Electron-only, and the migration that keeps
 * file-backed keys OUT of it only runs once. That left the reader with nowhere
 * to look: `account.session.v1` and the GitHub App token stayed in
 * `credentials.json.enc` while every desktop read went to `credentials.safe.enc`
 * and answered "not connected". Routing per key is what makes "the brain and the
 * app share this credential" true for readers, not just for writers.
 */
export function createRoutedCredentialStore(args: {
  primary: SyncCredentialStore;
  fileStore: SyncCredentialStore;
}): SyncCredentialStore {
  const storeFor = (key: string): SyncCredentialStore =>
    isFileBackedCredentialKey(normalizeCredentialKey(key)) ? args.fileStore : args.primary;
  // `getLastReadState()` describes the store's MOST RECENT read, and a caller
  // asks it immediately after the read it means. Answering from the wrong file
  // is how a readable credential gets reported as "can't read your sign-in".
  let lastReadStore: SyncCredentialStore = args.primary;
  const readStoreFor = (key: string): SyncCredentialStore => {
    lastReadStore = storeFor(key);
    return lastReadStore;
  };
  return {
    get: async (key) => readStoreFor(key).get(key),
    // Forwarded per call rather than through `lastReadStore`: this accessor
    // exists precisely so an async caller learns the state of ITS read, and
    // routing it through shared mutable state would hand back whichever file
    // some interleaved read touched last.
    getWithReadState: async (key) => {
      const store = storeFor(key);
      if (store.getWithReadState) return await store.getWithReadState(key);
      const value = await store.get(key);
      return { value, state: store.getLastReadState?.() ?? "missing" };
    },
    set: async (key, value) => storeFor(key).set(key, value),
    delete: async (key) => storeFor(key).delete(key),
    getSync: (key) => readStoreFor(key).getSync(key),
    setSync: (key, value) => storeFor(key).setSync(key, value),
    deleteSync: (key) => storeFor(key).deleteSync(key),
    // No `updateSync`. It takes the WHOLE credential map and rewrites it, and a
    // routed store has two maps in two files — so any single-file answer is
    // wrong: binding the primary's silently drops every file-backed key from
    // the view the updater is handed, and the routed keys it writes back land
    // in the file nobody reads them from. Callers that reach for it already
    // document a non-atomic get/set fallback, and that fallback routes per key,
    // which is the behaviour they actually want here.
    updateKeySync: (key, mutator) => {
      updateCredentialKeySync(storeFor(key), key, mutator);
    },
    credentialStoreIdentity: () => args.fileStore.credentialStoreIdentity?.()
      ?? args.primary.credentialStoreIdentity?.()
      ?? "ade.routed-credential-store",
    onDidChange: (listener) => {
      const unsubscribes = [
        args.primary.onDidChange?.(listener),
        args.fileStore.onDidChange?.(listener),
      ];
      return () => {
        for (const unsubscribe of unsubscribes) unsubscribe?.();
      };
    },
    getLastReadState: () => lastReadStore.getLastReadState?.() ?? "missing",
    getLastReadFailureReason: () => lastReadStore.getLastReadFailureReason?.() ?? null,
  };
}

/**
 * A store that cannot serve anything, and says why on every call.
 *
 * Built when the OS credential store is locked. It throws rather than answering
 * "no value": an empty answer reads as "never connected" and invites the user
 * to reconnect over credentials that are still on disk. Paired with the router
 * above, so the credentials that need no keychain stay reachable.
 */
export function createUnavailableCredentialStore(message: string): SyncCredentialStore {
  const refuse = (): never => {
    throw new Error(message);
  };
  return {
    get: async () => refuse(),
    set: async () => refuse(),
    delete: async () => refuse(),
    getSync: refuse,
    setSync: refuse,
    deleteSync: refuse,
  };
}

/**
 * A store that is built on its first call, not when it is made.
 *
 * The desktop's Electron-only store needs this. On macOS, the first safeStorage
 * call reads the app's key from the Keychain. A build that the Keychain does
 * not recognize (a new signature) gets a prompt, and that read holds the
 * calling thread until the person answers. Built at launch, it held the main
 * process before the first window existed, so no window opened. Built on first
 * use, it costs nothing until a key that lives in it is needed.
 *
 * `build` runs again on a later call when it throws, so a store that could not
 * be built is not kept. Until then the store reads as unreadable, never as
 * missing: "not connected" would invite a reconnect over secrets that are
 * still on disk. The reason is `no_os_key_material` (the OS has not handed
 * over the key), which never counts as corruption.
 */
export function createLazyCredentialStore(build: () => SyncCredentialStore): SyncCredentialStore {
  let store: SyncCredentialStore | null = null;
  let buildFailed = false;
  const resolve = (): SyncCredentialStore => {
    if (store) return store;
    try {
      store = build();
    } catch (error) {
      buildFailed = true;
      throw error;
    }
    buildFailed = false;
    return store;
  };
  return {
    get: async (key) => resolve().get(key),
    getWithReadState: async (key) => {
      const target = resolve();
      if (target.getWithReadState) return await target.getWithReadState(key);
      const value = await target.get(key);
      return { value, state: target.getLastReadState?.() ?? "missing" };
    },
    set: async (key, value) => resolve().set(key, value),
    delete: async (key) => resolve().delete(key),
    getSync: (key) => resolve().getSync(key),
    setSync: (key, value) => resolve().setSync(key, value),
    deleteSync: (key) => resolve().deleteSync(key),
    // Atomic when the built store is: it picks the built store's own update.
    updateKeySync: (key, mutator) => {
      updateCredentialKeySync(resolve(), key, mutator);
    },
    // Not built by a question about the last read: before the first call,
    // there was no read.
    getLastReadState: () => store?.getLastReadState?.() ?? (buildFailed ? "unreadable" : "missing"),
    getLastReadFailureReason: () => store?.getLastReadFailureReason?.() ?? (buildFailed ? "no_os_key_material" : null),
  };
}
