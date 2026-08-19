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
    return toResult(await store.get(key), store);
  } catch (error) {
    options.onError?.(error);
    return { value: null, unreadable: true };
  }
}
