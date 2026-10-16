import type { AccountStoreResult, AccountStoreWriteOptions } from "./accountStore";

/**
 * The wire shapes of the account vault store, shared by main, preload and the
 * renderer.
 *
 * List items omit credential values. They do include `refreshOwner` so a
 * rotating grant (Linear OAuth) can refuse to refresh on a machine that is
 * not the stamped exchanger. Writer device id stays in the runtime cache.
 */

/** One account-vault item, including its locally readable value when present. */
export type AccountVaultItem = {
  scope: string;
  kind: string;
  key: string;
  value: string | null;
  updatedAt: string;
  /** Device id allowed to rotate this credential; null when it never rotates. */
  refreshOwner?: string | null;
  /**
   * True on a tombstone: the key was deleted on some machine.
   *
   * A consumer that holds its own copy has to drop it — this is the only signal
   * that says the credential is gone rather than merely unreadable.
   */
  deleted?: boolean;
};

/** Every account-vault call answers with a value or an ordinary failure result. */
export type AccountVaultResult<T> = AccountStoreResult<T>;

/** Owner fence and optional refresh-owner stamp for vault mutations. */
export type AccountVaultWriteOptions = AccountStoreWriteOptions & {
  refreshOwner?: string | null;
};
