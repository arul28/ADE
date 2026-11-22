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
  /**
   * What a write passes as `expectedRevision` to replace this item only while
   * it is still what the caller read. Opaque. Absent from an older brain.
   */
  revision?: string;
};

/**
 * The revision of an item the vault does not have: a write that names it is
 * refused when an item (a tombstone included) exists.
 */
export const ACCOUNT_VAULT_NO_REVISION = "absent";

/** Every account-vault call answers with a value or an ordinary failure result. */
export type AccountVaultResult<T> = AccountStoreResult<T>;

/**
 * A write that named a revision the item no longer has: someone changed it
 * after the caller read it. Nothing was written. Read again and decide again;
 * do not retry the same write. It is a refusal (`rejected`), so code that
 * knows only the plain result still reads it as "not written".
 */
export type AccountVaultStaleResult = { ok: false; rejected: true; stale: true; message: string };

/** What `set` and `remove` answer. */
export type AccountVaultWriteResult = AccountVaultResult<null> | AccountVaultStaleResult;

export const ACCOUNT_VAULT_STALE_MESSAGE = "The account changed this item since it was read.";

/** Owner fence, optional refresh-owner stamp, and optional revision check for vault mutations. */
export type AccountVaultWriteOptions = AccountStoreWriteOptions & {
  refreshOwner?: string | null;
  /**
   * The `revision` the caller read (`ACCOUNT_VAULT_NO_REVISION` when it read
   * no item). The write goes only while the item still has it, on this machine
   * and then on the account; otherwise it answers `stale` (here) or is dropped
   * when the account refuses it (later, and this machine takes the account's
   * item). Leave it out for a write a person asked for: that one replaces
   * whatever is there.
   */
  expectedRevision?: string;
};
