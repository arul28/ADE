/** A successful account-store result or a typed write outcome. */
export type AccountStoreResult<T> =
  | { ok: true; value: T }
  | { ok: false; unavailable: true; message: string }
  | { ok: false; rejected: true; message: string };

export type AccountStoreResultHelpers = {
  unavailable<T>(): AccountStoreResult<T>;
  rejected<T>(): AccountStoreResult<T>;
};

/** Create transport-neutral failure results for account-store adapters. */
export function createAccountStoreResultHelpers(options: {
  unavailableMessage: string;
  rejectedMessage: string;
}): AccountStoreResultHelpers {
  return {
    unavailable: <T>(): AccountStoreResult<T> => ({
      ok: false,
      unavailable: true,
      message: options.unavailableMessage,
    }),
    rejected: <T>(): AccountStoreResult<T> => ({
      ok: false,
      rejected: true,
      message: options.rejectedMessage,
    }),
  };
}
