/**
 * The person's sign-ins for cloud machines, as the account vault keeps them.
 * A new cloud machine never gets them in its env (the Worker and the host
 * would see them): its brain reads them from the vault
 * (providerLogins/providerLoginApplyPass.ts, claudePass/claudePassSync.ts).
 * No terminal and no Electron here, so the desktop and the brain both read it. Claude's sign-in
 * that makes its token is cloudClaudeSignIn.ts.
 *
 * One vault item per sign-in, so two windows saving different keys never
 * overwrite each other. A value is never logged or returned to a window.
 */

import {
  CLAUDE_TOKEN_PATTERN,
  CLOUD_SIGN_INS,
  cloudSignInVaultKey,
  encodeCloudSignIn,
  parseCloudSignIn,
  type CloudSignInId,
  type CloudSignInStatus,
  type StoredCloudSignIn,
} from "../../../shared/cloudSignIns";
import type { CloudVault } from "./cloudAccess";

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

/** The account vault, one item per sign-in key; null when signed out of ADE. */
export type CloudSignInVaults = (vaultKey: string) => CloudVault | null;

// The stored form (vault keys, values, the token pattern) is shared with the account server (shared/cloudSignIns.ts).

function parseStored(id: CloudSignInId, raw: string | null): StoredCloudSignIn | null {
  const parsed = parseCloudSignIn(raw, (token) => id !== "claude" || CLAUDE_TOKEN_PATTERN.test(token));
  return parsed ? { v: 1, token: parsed.token, savedAt: parsed.savedAt ?? 0 } : null;
}

/** Keeps one sign-in. False when the account refused it. */
export async function saveCloudSignIn(
  vaults: CloudSignInVaults,
  id: CloudSignInId,
  token: string,
  logger?: Logger,
): Promise<boolean> {
  const vault = vaults(cloudSignInVaultKey(id));
  if (!vault) return false;
  const ok = await vault.set(encodeCloudSignIn(token, Date.now())).catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_save_threw", { id, reason: "vault_write_threw" });
    return false;
  });
  if (!ok) logger?.warn?.("cloud.cloud_sign_in_save_failed", { id });
  return ok;
}

/** Forgets one sign-in. False when the account refused. */
export async function removeCloudSignIn(
  vaults: CloudSignInVaults,
  id: CloudSignInId,
  logger?: Logger,
): Promise<boolean> {
  const vault = vaults(cloudSignInVaultKey(id));
  if (!vault) return false;
  return await vault.remove().catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_remove_threw", { id, reason: "vault_remove_threw" });
    return false;
  });
}

type ReadResult = { id: CloudSignInId; stored: StoredCloudSignIn | null; readable: boolean };

async function readAll(vaults: CloudSignInVaults | null, logger: Logger): Promise<ReadResult[] | null> {
  // Signed out of ADE: there is no account to read.
  if (!vaults?.(cloudSignInVaultKey("claude"))) return null;
  return await Promise.all(CLOUD_SIGN_INS.map(async ({ id }): Promise<ReadResult> => {
    const vault = vaults(cloudSignInVaultKey(id));
    if (!vault) return { id, stored: null, readable: false };
    try {
      const read = await vault.get();
      return read.ok ? { id, stored: parseStored(id, read.value), readable: true } : { id, stored: null, readable: false };
    } catch {
      // The vault's own error can name the value's item; a fixed reason only.
      logger?.warn?.("cloud.cloud_sign_in_read_failed", { id, reason: "vault_read_threw" });
      return { id, stored: null, readable: false };
    }
  }));
}

/** Which sign-ins are kept, never their values. */
export async function readCloudSignIns(
  vaults: CloudSignInVaults | null,
  logger?: Logger,
): Promise<Pick<CloudSignInStatus, "saved" | "unknown">> {
  const results = await readAll(vaults, logger);
  return {
    saved: CLOUD_SIGN_INS.map(({ id }) => {
      const stored = results?.find((result) => result.id === id)?.stored ?? null;
      return { id, saved: stored != null, savedAt: stored?.savedAt ?? null };
    }),
    unknown: results != null && results.some((result) => !result.readable),
  };
}
