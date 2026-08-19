/**
 * Read one credential AND learn whether the store could be read at all, in a
 * single call.
 *
 * The invariant this exists to keep: an undecryptable credential store returns
 * an EMPTY view rather than throwing, so "no token" and "a token ADE cannot
 * read" are the same answer — and only `getLastReadState()` tells them apart.
 * That method describes the store's MOST RECENT read, so it must be consulted
 * immediately after the `getSync`/`get` it is being asked about; asking a moment
 * later answers about somebody else's read. Pairing the two here is what makes
 * the ordering impossible to get wrong, instead of a comment each caller has to
 * remember. Getting it wrong is what told users with working credentials that
 * they were "not connected", and invited them to reconnect over them.
 *
 * "Immediately after" is free on the sync path and impossible on the async one:
 * resolving `get()` costs at least one tick, and the same store is read by App
 * user authentication, so another read can land inside that gap. Async stores
 * therefore hand back the state alongside the value (`getWithReadState`) rather
 * than being asked for it afterwards.
 *
 * A store that throws is unreadable too — the Electron safeStorage store
 * reports decrypt failures that way rather than by returning `{}`.
 */

export type CredentialReadStateResult = {
  value: string | null;
  unreadable: boolean;
};

type SyncCredentialReader = {
  getSync(key: string): string | null | undefined;
  getLastReadState?(): string;
};

type AsyncCredentialReader = {
  get(key: string): Promise<string | null | undefined>;
  getLastReadState?(): string;
  /**
   * Preferred over `get` + `getLastReadState()`: it returns the state produced
   * by THIS read. `getLastReadState()` describes the store's most recent read,
   * and an async caller only gets to ask once its own read has resolved — by
   * which point a read from elsewhere (the same store backs App user auth) can
   * have landed and moved the answer. The sync path has no such gap, so only
   * the async one needs this.
   */
  getWithReadState?(key: string): Promise<{
    value: string | null | undefined;
    state: string;
  }>;
};

function toResult(
  value: string | null | undefined,
  store: { getLastReadState?(): string },
): CredentialReadStateResult {
  const trimmed = value?.trim() ?? "";
  return {
    value: trimmed || null,
    unreadable: store.getLastReadState?.() === "unreadable",
  };
}

/** `onError` lets a caller log the throw it would otherwise never see. */
export function readCredentialWithState(
  store: SyncCredentialReader,
  key: string,
  options: { onError?: (error: unknown) => void } = {},
): CredentialReadStateResult {
  try {
    return toResult(store.getSync(key), store);
  } catch (error) {
    options.onError?.(error);
    return { value: null, unreadable: true };
  }
}

export async function readCredentialWithStateAsync(
  store: AsyncCredentialReader,
  key: string,
  options: { onError?: (error: unknown) => void } = {},
): Promise<CredentialReadStateResult> {
  try {
    if (store.getWithReadState) {
      const read = await store.getWithReadState(key);
      const trimmed = read.value?.trim() ?? "";
      return { value: trimmed || null, unreadable: read.state === "unreadable" };
    }
    // A store without the paired accessor answers about its most recent read,
    // which is the best available answer and stays correct while it is the only
    // reader.
    return toResult(await store.get(key), store);
  } catch (error) {
    options.onError?.(error);
    return { value: null, unreadable: true };
  }
}
