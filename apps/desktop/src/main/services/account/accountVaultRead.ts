/**
 * The read step the integration credential syncs share (GitHub token, Jira,
 * Linear): find one item in the account vault and decode its value. Each sync
 * then reconciles that with its own machine copy by its own rules.
 */
import type { AccountVaultItem, AccountVaultResult } from "../../../shared/types/accountVault";

export type AccountVaultRef = { scope: string; kind: string; key: string };

type ReadableVault = {
  list(scope: string): Promise<AccountVaultResult<AccountVaultItem[]>>;
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
};

export type AccountVaultRead<T> = {
  /** The vault's entry, a tombstone included; null when it has none. */
  item: AccountVaultItem | null;
  /** The stored value; null for no item or a tombstone. */
  raw: string | null;
  /** The value decoded; null when it is absent or ADE cannot read it (a newer format). */
  value: T | null;
};

/** The vault, or null when the account has none here; a getter that throws is reported. */
export function safeVault<T>(
  getVault: (() => T | null | undefined) | undefined,
  onError: (error: unknown) => void,
): T | null {
  try {
    return getVault?.() ?? null;
  } catch (error) {
    onError(error);
    return null;
  }
}

/** One vault item and its decoded value, or null when the vault cannot say (reported to `onFailure`). */
export async function readAccountVaultItem<T>(
  vault: ReadableVault,
  ref: AccountVaultRef,
  decode: (raw: string | null) => T | null,
  onFailure: (operation: "list" | "get" | "read", detail: unknown) => void,
): Promise<AccountVaultRead<T> | null> {
  try {
    const listed = await vault.list(ref.scope);
    if (!listed.ok) {
      onFailure("list", listed);
      return null;
    }
    const item = listed.value.find((entry) =>
      entry.scope === ref.scope && entry.kind === ref.kind && entry.key === ref.key) ?? null;
    if (!item || item.deleted === true) return { item, raw: null, value: null };
    const got = await vault.get(ref.scope, ref.kind, ref.key);
    if (!got.ok) {
      onFailure("get", got);
      return null;
    }
    return { item, raw: got.value, value: decode(got.value) };
  } catch (error) {
    onFailure("read", error);
    return null;
  }
}
