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
import type { CloudVault, CloudVaultKind } from "./cloudAccess";
import { CLOUD_KEY_API_PROVIDER } from "../providerLogins/providerLoginSyncShared";

type Logger = { warn?(event: string, meta?: Record<string, unknown>): void } | null | undefined;

/**
 * The account vault, one item per sign-in key; null when signed out of ADE.
 * `kind` defaults to `integration`; `provider_api_key` reaches the one API
 * key store, which a saved ADE Cloud key mirrors into.
 */
export type CloudSignInVaults = (vaultKey: string, kind?: CloudVaultKind) => CloudVault | null;

/* ---- The one API key store (`provider_api_key`, apiKeyStore.ts) ---- */

/** The provider's own key, then the copy ADE Cloud saved beside a different one. */
function apiStoreKeysFor(id: CloudSignInId): { own: string; cloud: string } | null {
  const provider = CLOUD_KEY_API_PROVIDER[id];
  return provider ? { own: provider, cloud: `${provider}#ade-cloud` } : null;
}

async function readApiStore(vaults: CloudSignInVaults, key: string): Promise<string | null | undefined> {
  const vault = vaults(key, "provider_api_key");
  if (!vault) return undefined;
  try {
    const read = await vault.get();
    return read.ok ? (read.value?.trim() || null) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Mirrors a saved ADE Cloud key into the one API key store, so every
 * computer and ADE Cloud see one key. The provider's own row takes it when it
 * is empty or already holds it; a different key there stays, and this one
 * goes beside it as `<provider>#ade-cloud` (which cloud computers read
 * first). Best effort: the `cloud-key-<id>` item stays the copy older cloud
 * computers read, so a failed mirror loses nothing.
 */
async function mirrorToApiStore(vaults: CloudSignInVaults, id: CloudSignInId, token: string, logger?: Logger): Promise<void> {
  const keys = apiStoreKeysFor(id);
  if (!keys) return;
  const own = await readApiStore(vaults, keys.own);
  if (own === undefined) return;
  const target = own === null || own === token ? keys.own : keys.cloud;
  if (target === keys.own && own === token) {
    // Already the provider's key: an older copy beside it would shadow it on cloud computers.
    if ((await readApiStore(vaults, keys.cloud)) != null) await vaults(keys.cloud, "provider_api_key")?.remove().catch(() => false);
    return;
  }
  const ok = await vaults(target, "provider_api_key")?.set(token).catch(() => false);
  if (!ok) logger?.warn?.("cloud.cloud_key_mirror_failed", { id });
}

/** Removes ADE Cloud's copy from the one store: its `#ade-cloud` row, and the provider's row when it holds the same key. */
async function unmirrorFromApiStore(vaults: CloudSignInVaults, id: CloudSignInId, token: string | null, logger?: Logger): Promise<void> {
  const keys = apiStoreKeysFor(id);
  if (!keys) return;
  const cloud = await readApiStore(vaults, keys.cloud);
  if (cloud) await vaults(keys.cloud, "provider_api_key")?.remove().catch(() => false);
  if (!token) return;
  const own = await readApiStore(vaults, keys.own);
  if (own === token && !(await vaults(keys.own, "provider_api_key")?.remove().catch(() => false))) {
    logger?.warn?.("cloud.cloud_key_unmirror_failed", { id });
  }
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
  else if (id !== "claude") await mirrorToApiStore(vaults, id, token, logger);
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
  const held = id === "claude" ? null : await vault.get().then((read) => (read.ok ? parseStored(id, read.value)?.token ?? null : null), () => null);
  const removed = await vault.remove().catch(() => {
    logger?.warn?.("cloud.cloud_sign_in_remove_threw", { id, reason: "vault_remove_threw" });
    return false;
  });
  if (removed && id !== "claude") await unmirrorFromApiStore(vaults, id, held, logger);
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
      const keys = stored || id === "claude" ? null : apiStoreKeysFor(id);
      const inApiStore = keys
        ? Boolean((await readApiStore(vaults, keys.cloud)) || (await readApiStore(vaults, keys.own)))
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
