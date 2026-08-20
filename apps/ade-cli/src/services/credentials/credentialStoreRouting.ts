import {
  isFileBackedCredentialKey,
  normalizeCredentialKey,
  type SyncCredentialStore,
} from "./credentialStore";

/**
 * Stores that stand in front of the real ones: the per-key router, and the
 * store that answers every call with the reason it cannot work.
 *
 * Split out of credentialStore.ts because neither reads or writes a byte — they
 * decide which store a call belongs to — and both are re-exported from there,
 * so no consumer has to know they moved.
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
      const value = await readStoreFor(key).get(key);
      return { value, state: store.getLastReadState?.() ?? "missing" };
    },
    set: async (key, value) => storeFor(key).set(key, value),
    delete: async (key) => storeFor(key).delete(key),
    getSync: (key) => readStoreFor(key).getSync(key),
    setSync: (key, value) => storeFor(key).setSync(key, value),
    deleteSync: (key) => storeFor(key).deleteSync(key),
    // A whole-map updater cannot be split across two files, so it keeps the
    // meaning it had before routing existed: it updates the primary store.
    updateSync: args.primary.updateSync?.bind(args.primary),
    updateKeySync: (key, mutator) => {
      const store = storeFor(key);
      if (store.updateKeySync) {
        store.updateKeySync(key, mutator);
        return;
      }
      const next = mutator(store.getSync(key));
      if (next === undefined) return;
      if (next === null) store.deleteSync(key);
      else store.setSync(key, next);
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
