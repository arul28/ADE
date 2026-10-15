// ---------------------------------------------------------------------------
// OpenCode accounts: several logins per provider, one in use (OpenCode 2.0)
//
// OpenCode keeps every login it is given in its `credential` table and uses
// exactly one per provider, the active one, for every chat on that machine. A
// new login becomes the active one; switching applies to the next request of
// every running chat. While a provider has any OpenCode login, its ADE API key
// is not used (verified against 2.0.29): the key is the fallback for a provider
// with no login.
//
// Cloud logins (OpenCode's `external` methods: gcloud application-default
// credentials, an AWS profile) hold no secret, only which machine login to use.
// They are saved to the ADE account (`opencodeCloudLogins`) so every machine
// signed in to it sets the same login up in its own OpenCode store, and each
// machine reports whether it actually has the gcloud or AWS login behind it.
// ---------------------------------------------------------------------------

import type { OpenCodeClient } from "@opencode/client";
import type {
  OpenCodeAccount,
  OpenCodeAccountActionResult,
  OpenCodeAccountKind,
  OpenCodeAccountsResult,
  OpenCodeCloudConnectResult,
} from "../../../shared/types/config";
import { forgetRouteSecretsForSource } from "../chat/harnessPresetConfigHomes";
import { mapOpenCodeIntegrationAuthMethods, openCodeMethodFormAnswer } from "./openCodeAuthMethods";
import { acquireAuthLease, type OpenCodeAuthDeps } from "./openCodeAuthService";
import { openCodeCloudReadiness } from "./openCodeCloudReadiness";
import {
  MAX_CLOUD_LOGIN_LABEL_LENGTH,
  cloudLoginKey,
  credentialCloudKey,
  readAppliedKeys,
  readSyncedCloudLogins,
  writeAppliedKeys,
  writeSyncedCloudLogins,
  type SyncedCloudLogin,
} from "./openCodeCloudLoginSync";
import {
  bumpOpenCodeCredentialsGeneration,
  readOpenCodeCredentials,
  type OpenCodeCredentialSummary,
} from "./openCodeCredentials";
import {
  clearOpenCodeInventoryCache,
  lastOpenCodeDiscoveredLocalModels,
  probeOpenCodeProviderInventory,
} from "./openCodeInventory";

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record._tag === "string") return record._tag;
  }
  return error instanceof Error ? error.message : String(error);
}

/** After a credential change: every cache of "which login is in use" starts over. */
function credentialsChanged(providerId: string): void {
  bumpOpenCodeCredentialsGeneration();
  clearOpenCodeInventoryCache();
  // Routes into other harnesses copied the in-use login's token; the next
  // launch must read the login that is in use now.
  for (const sourceKey of providerId === "opencode" ? ["opencode", "opencode-go"] : [providerId]) {
    forgetRouteSecretsForSource(sourceKey);
  }
}

function probeInventoryInBackground(deps: OpenCodeAuthDeps, providerId: string): void {
  void probeOpenCodeProviderInventory({
    projectRoot: deps.projectRoot,
    projectConfig: deps.projectConfig,
    logger: deps.logger,
    force: true,
    discoveredLocalModels: lastOpenCodeDiscoveredLocalModels(),
  }).catch((err) => {
    deps.logger.warn("opencode.accounts_post_change_probe_failed", { providerId, error: errorMessage(err) });
  });
}

/**
 * Make this machine's cloud logins match the account's: add the ones it lacks,
 * remove the ones another machine removed. A login added here does not take
 * over: whatever login was in use for that provider stays in use. Returns
 * whether anything changed.
 */
async function reconcileCloudLogins(deps: OpenCodeAuthDeps): Promise<boolean> {
  const synced = readSyncedCloudLogins(deps);
  if (!synced) return false;
  const syncedKeys = new Set(synced.map(cloudLoginKey));
  const credentials = readOpenCodeCredentials();
  const localByKey = new Map<string, OpenCodeCredentialSummary>();
  for (const credential of credentials) {
    const key = credentialCloudKey(credential);
    if (key) localByKey.set(key, credential);
  }
  const applied = readAppliedKeys();
  const toAdd = synced.filter((login) => !localByKey.has(cloudLoginKey(login)));
  const toRemove = [...localByKey.entries()]
    .filter(([key]) => applied.has(key) && !syncedKeys.has(key))
    .map(([, credential]) => credential);
  if (!toAdd.length && !toRemove.length) {
    if (applied.size !== syncedKeys.size || [...syncedKeys].some((key) => !applied.has(key))) {
      writeAppliedKeys(syncedKeys, deps);
    }
    return false;
  }

  const lease = await acquireAuthLease(deps);
  const location = { directory: deps.projectRoot };
  const changedProviders = new Set<string>();
  // A removal that failed stays recorded as applied, so the next sync retries it.
  const appliedAfter = new Set(syncedKeys);
  try {
    for (const credential of toRemove) {
      try {
        await lease.client.credential.remove({ credentialID: credential.id });
        changedProviders.add(credential.integrationId);
      } catch (err) {
        const key = credentialCloudKey(credential);
        if (key) appliedAfter.add(key);
        deps.logger.warn("opencode.cloud_login_sync_remove_failed", { providerId: credential.integrationId, error: errorMessage(err) });
      }
    }
    // `integration.list` waits for this location's catalog; a connect sent to
    // a server that just started reports a real provider as missing.
    if (toAdd.length) await lease.client.integration.list({ location });
    for (const login of toAdd) {
      const previouslyActive = credentials.find((entry) => entry.integrationId === login.providerId && entry.active);
      try {
        await lease.client.integration.connect.external({
          integrationID: login.providerId,
          methodID: login.methodId,
          location,
          ...(Object.keys(login.details).length ? { answer: login.details } : {}),
          ...(login.label ? { label: login.label } : {}),
        });
        // A new login becomes the one in use; a login that arrived from
        // another machine must not switch this machine's chats.
        if (previouslyActive) await lease.client.credential.activate({ credentialID: previouslyActive.id });
        changedProviders.add(login.providerId);
      } catch (err) {
        deps.logger.warn("opencode.cloud_login_sync_add_failed", { providerId: login.providerId, error: errorMessage(err) });
      }
    }
  } finally {
    lease.release();
  }
  writeAppliedKeys(appliedAfter, deps);
  for (const providerId of changedProviders) credentialsChanged(providerId);
  if (changedProviders.size) {
    deps.logger.info("opencode.cloud_logins_synced", { added: toAdd.length, removed: toRemove.length });
  }
  return changedProviders.size > 0;
}

function accountKind(type: OpenCodeCredentialSummary["type"]): OpenCodeAccountKind {
  if (type === "oauth") return "subscription";
  if (type === "key") return "api_key";
  if (type === "external") return "cloud";
  return "unknown";
}

function toAccount(credential: OpenCodeCredentialSummary, syncedKeys: Set<string> | null): OpenCodeAccount {
  const account: OpenCodeAccount = {
    id: credential.id,
    providerId: credential.integrationId,
    label: credential.label,
    kind: accountKind(credential.type),
    active: credential.active,
    updatedAt: credential.updatedAt,
  };
  if (credential.type === "external" && credential.methodId) {
    const key = credentialCloudKey(credential);
    account.cloud = {
      methodId: credential.methodId,
      details: credential.externalDetails,
      readiness: openCodeCloudReadiness(credential.methodId, credential.externalDetails),
      synced: Boolean(key && syncedKeys?.has(key)),
    };
  }
  return account;
}

/**
 * Every OpenCode login on this machine (one provider's, or all), with cloud
 * logins first brought in line with the account. Reads the store directly; a
 * server starts only when a cloud login has to be added or removed.
 */
export async function listOpenCodeAccounts(
  deps: OpenCodeAuthDeps,
  args: { providerId?: string | null } = {},
): Promise<OpenCodeAccountsResult> {
  try {
    await reconcileCloudLogins(deps);
  } catch (err) {
    // The list still answers: what is on this machine is still true.
    deps.logger.warn("opencode.cloud_logins_sync_failed", { error: errorMessage(err) });
  }
  const synced = readSyncedCloudLogins(deps);
  const syncedKeys = synced ? new Set(synced.map(cloudLoginKey)) : null;
  const providerId = args.providerId?.trim() || null;
  // Rows arrive marked-active first, then newest. A provider with no row
  // marked (logins from before 2.0 carry none) still uses its newest one, as
  // OpenCode does (verified against 2.0.29), so that row reads as in use.
  const inUse = new Set<string>();
  const accounts = readOpenCodeCredentials()
    .filter((credential) => !providerId || credential.integrationId === providerId)
    .map((credential) => {
      const account = toAccount(credential, syncedKeys);
      account.active = !inUse.has(credential.integrationId);
      inUse.add(credential.integrationId);
      return account;
    });
  return { accounts };
}

function findCredential(id: string): OpenCodeCredentialSummary | null {
  return readOpenCodeCredentials().find((credential) => credential.id === id) ?? null;
}

async function withCredentialClient<T>(
  deps: OpenCodeAuthDeps,
  run: (client: OpenCodeClient) => Promise<T>,
): Promise<T> {
  const lease = await acquireAuthLease(deps);
  try {
    return await run(lease.client);
  } finally {
    lease.release();
  }
}

/** Make one login the one every chat on this machine uses for its provider. */
export async function activateOpenCodeAccount(
  deps: OpenCodeAuthDeps,
  args: { id: string },
): Promise<OpenCodeAccountActionResult> {
  const credential = findCredential(args.id);
  if (!credential) return { ok: false, error: "That account is no longer on this computer." };
  if (credential.active) return { ok: true };
  try {
    await withCredentialClient(deps, (client) => client.credential.activate({ credentialID: credential.id }));
  } catch (err) {
    return { ok: false, error: `OpenCode could not switch to ${credential.label}: ${errorMessage(err)}` };
  }
  credentialsChanged(credential.integrationId);
  probeInventoryInBackground(deps, credential.integrationId);
  return { ok: true };
}

export async function renameOpenCodeAccount(
  deps: OpenCodeAuthDeps,
  args: { id: string; label: string },
): Promise<OpenCodeAccountActionResult> {
  const label = args.label.trim().slice(0, MAX_CLOUD_LOGIN_LABEL_LENGTH);
  if (!label) return { ok: false, error: "Give the account a name." };
  const credential = findCredential(args.id);
  if (!credential) return { ok: false, error: "That account is no longer on this computer." };
  if (credential.label === label) return { ok: true };
  try {
    await withCredentialClient(deps, (client) => client.credential.update({ credentialID: credential.id, label }));
  } catch (err) {
    return { ok: false, error: `OpenCode could not rename ${credential.label}: ${errorMessage(err)}` };
  }
  // A synced cloud login carries its name to the other machines.
  const key = credentialCloudKey(credential);
  const synced = key ? readSyncedCloudLogins(deps) : null;
  if (key && synced?.some((login) => cloudLoginKey(login) === key)) {
    writeSyncedCloudLogins(deps, synced.map((login) => (cloudLoginKey(login) === key ? { ...login, label } : login)));
  }
  bumpOpenCodeCredentialsGeneration();
  return { ok: true };
}

/**
 * Sign one login out. A cloud login saved to the account leaves the account
 * too, so the other machines remove it as well.
 */
export async function removeOpenCodeAccount(
  deps: OpenCodeAuthDeps,
  args: { id: string },
): Promise<OpenCodeAccountActionResult> {
  const credential = findCredential(args.id);
  if (!credential) return { ok: true };
  // A synced login leaves the account first: signed out here but still in the
  // account, the next sync would set it up again.
  const key = credentialCloudKey(credential);
  const synced = key ? readSyncedCloudLogins(deps) : null;
  const remaining = key && synced?.some((login) => cloudLoginKey(login) === key)
    ? synced.filter((login) => cloudLoginKey(login) !== key)
    : null;
  if (remaining && !writeSyncedCloudLogins(deps, remaining)) {
    return { ok: false, error: `ADE could not remove ${credential.label} from your ADE account, so it stays signed in. Try again.` };
  }
  try {
    await withCredentialClient(deps, (client) => client.credential.remove({ credentialID: credential.id }));
  } catch (err) {
    // Already gone from the account: this machine's next sync removes it.
    return { ok: false, error: `OpenCode could not sign ${credential.label} out: ${errorMessage(err)}` };
  }
  if (remaining) writeAppliedKeys(remaining.map(cloudLoginKey), deps);
  credentialsChanged(credential.integrationId);
  probeInventoryInBackground(deps, credential.integrationId);
  return { ok: true };
}

/**
 * Add a cloud login: OpenCode records which machine login to use (it checks
 * nothing), it becomes the provider's login in use, and it is saved to the
 * ADE account so the user's other machines set it up too.
 */
export async function connectOpenCodeCloudLogin(
  deps: OpenCodeAuthDeps,
  args: { providerId: string; methodIndex: number; inputs?: Record<string, string>; label?: string },
): Promise<OpenCodeCloudConnectResult> {
  const providerId = args.providerId.trim();
  if (!providerId) return { ok: false, error: "Provider ID is required." };
  const label = args.label?.trim().slice(0, MAX_CLOUD_LOGIN_LABEL_LENGTH) || undefined;
  let login: SyncedCloudLogin;
  try {
    login = await withCredentialClient(deps, async (client) => {
      const location = { directory: deps.projectRoot };
      // `integration.list` waits for this location's catalog (see startOAuth).
      const listed = await client.integration.list({ location });
      const integration = listed.data.find((entry) => entry.id === providerId);
      if (!integration) throw new Error(`OpenCode does not offer a cloud login for ${providerId}.`);
      const selected = mapOpenCodeIntegrationAuthMethods(integration)[args.methodIndex];
      if (!selected || selected.source.type !== "external") {
        throw new Error("That sign-in method is no longer offered by OpenCode. Reopen the provider and try again.");
      }
      const answer = openCodeMethodFormAnswer(selected.source, args.inputs);
      await client.integration.connect.external({
        integrationID: providerId,
        methodID: selected.source.id,
        location,
        ...(answer ? { answer } : {}),
        ...(label ? { label } : {}),
      });
      const details: Record<string, string> = {};
      for (const [key, value] of Object.entries(answer ?? {})) {
        if (typeof value === "string" && value.trim()) details[key] = value.trim();
      }
      return { providerId, methodId: selected.source.id, details, ...(label ? { label } : {}) };
    });
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }

  const key = cloudLoginKey(login);
  const synced = readSyncedCloudLogins(deps);
  if (synced) {
    const next = [...synced.filter((entry) => cloudLoginKey(entry) !== key), login];
    if (writeSyncedCloudLogins(deps, next)) writeAppliedKeys(next.map(cloudLoginKey), deps);
  }
  credentialsChanged(providerId);
  probeInventoryInBackground(deps, providerId);
  const created = readOpenCodeCredentials().find((credential) => credentialCloudKey(credential) === key);
  return { ok: true, ...(created ? { accountId: created.id } : {}) };
}
