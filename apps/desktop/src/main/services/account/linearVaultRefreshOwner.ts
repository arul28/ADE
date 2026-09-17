import type { AccountVaultBridge } from "./accountVaultBridge";
import type { AccountVaultWriteOptions } from "../../../shared/types/accountVault";

export const LINEAR_REFRESH_VAULT_SCOPE = "all";
export const LINEAR_REFRESH_VAULT_KIND = "linear_refresh_token";
export const LINEAR_REFRESH_VAULT_KEY = "default";

export function linearRefreshVaultWriteOptions(
  getDeviceId?: () => string | null,
): AccountVaultWriteOptions | undefined {
  const refreshOwner = getDeviceId?.()?.trim() || "";
  return refreshOwner ? { refreshOwner } : undefined;
}

/**
 * Linear's refresh grant rotates. The vault may copy it onto every signed-in
 * machine, but only the stamped refresh owner may exchange it. A missing owner
 * (legacy row, or a vault we cannot ask) keeps the previous "this machine may
 * refresh" behaviour so a first writer can claim the grant.
 */
export async function thisDeviceOwnsLinearRefreshGrant(args: {
  getAccountVault?: () => AccountVaultBridge | null | undefined;
  getDeviceId?: () => string | null;
}): Promise<boolean> {
  const deviceId = args.getDeviceId?.()?.trim() || "";
  if (!deviceId) return true;

  let vault: AccountVaultBridge | null | undefined;
  try {
    vault = args.getAccountVault?.() ?? null;
  } catch {
    return true;
  }
  if (!vault) return true;

  let listed: Awaited<ReturnType<AccountVaultBridge["list"]>>;
  try {
    listed = await vault.list(LINEAR_REFRESH_VAULT_SCOPE);
  } catch {
    return true;
  }
  if (!listed.ok) return true;

  const item = listed.value.find(
    (entry) =>
      entry.scope === LINEAR_REFRESH_VAULT_SCOPE
      && entry.kind === LINEAR_REFRESH_VAULT_KIND
      && entry.key === LINEAR_REFRESH_VAULT_KEY,
  );
  const owner = item?.refreshOwner?.trim() || "";
  if (!owner) return true;
  return owner === deviceId;
}
