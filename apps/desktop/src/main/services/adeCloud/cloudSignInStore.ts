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
  CLOUD_KEY_API_STORE_KIND,
  CLOUD_SIGN_INS,
  cloudKeyApiStoreRows,
  cloudSignInVaultKey,
  encodeCloudSignIn,
  mirrorCloudKeyToApiStore,
  parseCloudSignIn,
  unmirrorCloudKeyFromApiStore,
  type CloudKeyApiStore,
  type CloudSignInId,
  type CloudSignInStatus,
  type StoredCloudSignIn,
} from "../../../shared/cloudSignIns";
import type { CloudVault, CloudVaultKind } from "./cloudAccess";

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

/**
 * The account vault, one item per sign-in key; null when signed out of ADE.
 * `kind` defaults to `integration`; `provider_api_key` reaches the one API
 * key store, which a saved ADE Cloud key mirrors into.
 */
export type CloudSignInVaults = (vaultKey: string, kind?: CloudVaultKind) => CloudVault | null;

/* ---- The one API key store (`provider_api_key`; the mirror rule is shared/cloudSignIns.ts) ---- */

/** One row of the one key store; undefined when the vault can't answer (logged by id, never the key). */
async function readApiStore(vaults: CloudSignInVaults, key: string, id: CloudSignInId, logger?: Logger): Promise<string | null | undefined> {
  const vault = vaults(key, CLOUD_KEY_API_STORE_KIND);
  if (!vault) return undefined;
  try {
    const read = await vault.get();
    if (read.ok) return read.value?.trim() || null;
    logger?.warn?.("cloud.cloud_key_store_read_failed", { id, reason: "vault_read_failed" });
    return undefined;
  } catch {
    // The vault's own error can name the item; a fixed reason only.
    logger?.warn?.("cloud.cloud_key_store_read_failed", { id, reason: "vault_read_threw" });
    return undefined;
  }
}

function apiStoreOf(vaults: CloudSignInVaults, id: CloudSignInId, logger?: Logger): CloudKeyApiStore {
  return {
    read: (key) => readApiStore(vaults, key, id, logger),
    write: async (key, token) => (await vaults(key, CLOUD_KEY_API_STORE_KIND)?.set(token).catch(() => false)) === true,
    remove: async (key) => (await vaults(key, CLOUD_KEY_API_STORE_KIND)?.remove().catch(() => false)) === true,
  };
}

/** The key a sign-in's item holds now; null when none or unreadable (the removal then keeps a computer's own key). */
async function heldToken(vault: CloudVault, id: CloudSignInId): Promise<string | null> {
  return await vault.get().then((read) => (read.ok ? parseStored(id, read.value)?.token ?? null : null), () => null);
}

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
  // Best effort: the `cloud-key-<id>` item stays the copy older cloud computers read, so a failed mirror loses nothing.
  else if (id !== "claude" && !(await mirrorCloudKeyToApiStore(apiStoreOf(vaults, id, logger), id, token))) {
    logger?.warn?.("cloud.cloud_key_mirror_failed", { id });
  }
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
  // The key it held, so the one store's copy of the same key goes with it.
  const held = id === "claude" ? null : await heldToken(vault, id);
  const removed = await vault.remove().catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_remove_threw", { id, reason: "vault_remove_threw" });
    return false;
  });
  if (removed && id !== "claude" && !(await unmirrorCloudKeyFromApiStore(apiStoreOf(vaults, id, logger), id, held))) {
    logger?.warn?.("cloud.cloud_key_unmirror_failed", { id });
  }
  return removed;
}

type ReadResult = { id: CloudSignInId; stored: StoredCloudSignIn | null; readable: boolean; inApiStore?: boolean };

async function readAll(vaults: CloudSignInVaults | null, logger: Logger): Promise<ReadResult[] | null> {
  // Signed out of ADE: there is no account to read.
  if (!vaults?.(cloudSignInVaultKey("claude"))) return null;
  return await Promise.all(CLOUD_SIGN_INS.map(async ({ id }): Promise<ReadResult> => {
    const vault = vaults(cloudSignInVaultKey(id));
    if (!vault) return { id, stored: null, readable: false };
    try {
      const read = await vault.get();
      if (!read.ok) return { id, stored: null, readable: false };
      const stored = parseStored(id, read.value);
      // A key saved on a computer's Providers page is ADE Cloud's key too (the one store).
      const keys = stored || id === "claude" ? null : cloudKeyApiStoreRows(id);
      const inApiStore = keys
        ? Boolean((await readApiStore(vaults, keys.cloud, id, logger)) || (await readApiStore(vaults, keys.own, id, logger)))
        : false;
      return { id, stored, readable: true, inApiStore };
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
      const result = results?.find((entry) => entry.id === id);
      const stored = result?.stored ?? null;
      return { id, saved: stored != null || result?.inApiStore === true, savedAt: stored?.savedAt ?? null };
    }),
    unknown: results != null && results.some((result) => !result.readable),
  };
}
