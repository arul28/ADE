import type { AccountStoreResult } from "./accountStore";

/**
 * The wire shapes of the account vault store, shared by main, preload and the
 * renderer.
 *
 * The bridge deliberately exposes only the fields needed by its callers;
 * relay-only metadata such as the writer device and refresh owner stays in the
 * runtime's account vault implementation.
 */

/** One account-vault item, including its locally readable value when present. */
export type AccountVaultItem = {
  scope: string;
  kind: string;
  key: string;
  value: string | null;
  updatedAt: string;
};

/** Every account-vault call answers with a value or an ordinary unavailable result. */
export type AccountVaultResult<T> = AccountStoreResult<T>;
