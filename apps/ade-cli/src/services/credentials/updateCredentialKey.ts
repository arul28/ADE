/**
 * One ladder for "change one credential key", held in one place.
 *
 * Six call sites used to write the same three rungs by hand — `updateKeySync`,
 * then `updateSync` wrapped over the whole map, then a plain get/set — and each
 * copy was a chance to get the map wrapper subtly wrong. The rungs are ordered
 * by how much of a race they close:
 *
 * 1. `updateKeySync` — atomic for ONE key. First, because the routed desktop
 *    store can answer for one key but not for the whole credential map.
 * 2. `updateSync` — atomic over the whole map, wrapped so the caller still
 *    writes a per-key mutator.
 * 3. get/set — no atomicity at all. Correct inside one process, and the only
 *    stores that get this far are process-local ones.
 *
 * A caller that must NOT take the third rung asks `supportsAtomicCredentialUpdate`
 * first: a compare-and-swap degraded to check-then-set is not a weaker version
 * of the same write, it is a different write that can clobber a peer.
 */

/**
 * The smallest store shape this helper needs.
 *
 * Structural on purpose: `SyncCredentialStore` satisfies it, and so does the
 * duck type the desktop GitHub App service declares for its own store. Neither
 * module has to import the other's type to share this ladder.
 */
export type UpdatableCredentialStore = {
  getSync(key: string): string | null | undefined;
  setSync(key: string, value: string): void;
  deleteSync(key: string): void;
  updateSync?(updater: (values: Record<string, string>) => boolean | void): void;
  updateKeySync?(
    key: string,
    mutator: (current: string | null) => string | null | undefined,
  ): void;
};

/** Which rung of the ladder actually ran. */
export type CredentialKeyUpdateMode = "atomic" | "read_modify_write";

/** True when `updateCredentialKeySync` can write this store without a race. */
export function supportsAtomicCredentialUpdate(store: UpdatableCredentialStore): boolean {
  return typeof store.updateKeySync === "function" || typeof store.updateSync === "function";
}

/**
 * Applies `mutator` to one key and reports which rung of the ladder ran.
 *
 * The mutator sees the current value, or `null` when the key is absent. Return
 * `undefined` to write nothing, `null` to delete the key, or a string to store
 * it.
 */
export function updateCredentialKeySync(
  store: UpdatableCredentialStore,
  key: string,
  mutator: (current: string | null) => string | null | undefined,
): CredentialKeyUpdateMode {
  const updateKeySync = store.updateKeySync;
  if (updateKeySync) {
    updateKeySync.call(store, key, mutator);
    return "atomic";
  }
  const updateSync = store.updateSync;
  if (updateSync) {
    updateSync.call(store, (values) => {
      const next = mutator(values[key] ?? null);
      if (next === undefined) return false;
      if (next === null) {
        delete values[key];
        return true;
      }
      values[key] = next;
      return true;
    });
    return "atomic";
  }
  const next = mutator(store.getSync(key) ?? null);
  if (next === undefined) return "read_modify_write";
  if (next === null) store.deleteSync(key);
  else store.setSync(key, next);
  return "read_modify_write";
}
