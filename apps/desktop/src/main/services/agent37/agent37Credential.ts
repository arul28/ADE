/**
 * Where the Agent37 workspace key lives, and the integration's status/save
 * pair over it.
 *
 * Agent37 keys are per workspace, not per project, so the key is account-wide:
 * account vault item scope `all`, kind `integration`, key `agent37` (the same
 * shape as a pasted GitHub token). Every computer on the account reads it
 * straight from its vault, which is machine-local first and synchronized by
 * the brain, so there is no per-machine copy to reconcile. Signed out, or with
 * no vault on this runtime, the key stays in this machine's shared credential
 * file and the status says so.
 *
 * The same module serves desktop Settings (over the brain's vault bridge) and
 * the connect card an agent raises (over the brain's own vault store).
 */

import type { SyncCredentialStore } from "../../../../../ade-cli/src/services/credentials/credentialStore";
import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { agent37StatusAwake, type Agent37Status } from "../../../shared/agent37";
import { CONNECT_FIELD_IDS } from "../../../shared/integrationConnect";
import type { AccountVaultResult } from "../../../shared/types/accountVault";
import { describeIntegrationCredentialStorage, type IntegrationCredentialStorage } from "../account/integrationCredentialStorage";
import type { IntegrationConnectAdapter } from "../integrations/integrationConnectRequest";
import { Agent37Error, createAgent37Client, type Agent37Client } from "./agent37Client";

export const AGENT37_VAULT_KIND = "integration";
export const AGENT37_VAULT_KEY = "agent37";
/** The machine-local fallback, in the credential file the app, brain and CLI share. */
const AGENT37_MACHINE_CREDENTIAL_KEY = "agent37.apiKey.v1";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The account vault, reduced to this one item. `ok: false` means unreachable, not empty. */
export type Agent37Vault = {
  get(): Promise<{ ok: true; value: string | null } | { ok: false }>;
  set(value: string): Promise<boolean>;
  remove(): Promise<boolean>;
};

export type Agent37CredentialDeps = {
  /** Null when this runtime has no vault (no brain, nothing booted). */
  vault: () => Agent37Vault | null;
  machineStore: () => SyncCredentialStore | null;
  signedIn: () => boolean;
  fetch?: FetchLike;
  /** Where a vault or credential-file failure that falls back to "no key" is written down. */
  logger?: { warn(event: string, meta?: Record<string, unknown>): void };
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Agent37VaultBridge = {
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
  set(scope: string, kind: string, key: string, value: string): Promise<AccountVaultResult<null>>;
  remove(scope: string, kind: string, key: string): Promise<AccountVaultResult<null>>;
};

/** Desktop main: one account-wide Agent37 item in the brain's vault over `accountVaultBridge`. */
export function agent37VaultFromBridge(bridge: Agent37VaultBridge, key: string = AGENT37_VAULT_KEY): Agent37Vault {
  return {
    async get() {
      const result = await bridge.get(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key);
      return result.ok ? { ok: true, value: result.value } : { ok: false };
    },
    async set(value) {
      return (await bridge.set(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key, value)).ok;
    },
    async remove() {
      return (await bridge.remove(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key)).ok;
    },
  };
}

/** The brain: one account-wide Agent37 item in its own vault store. */
export function agent37VaultFromStore(store: {
  get(scope: string, kind: "integration", key: string): string | null;
  set(scope: string, kind: "integration", key: string, value: string): boolean;
  remove(scope: string, kind: "integration", key: string): boolean;
}, key: string = AGENT37_VAULT_KEY): Agent37Vault {
  return {
    async get() {
      return { ok: true, value: store.get(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key) };
    },
    async set(value) {
      return store.set(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key, value);
    },
    async remove() {
      return store.remove(ACCOUNT_SCOPE_ALL, AGENT37_VAULT_KIND, key);
    },
  };
}

function encode(key: string): string {
  return JSON.stringify({ v: 1, key });
}

function decode(raw: string | null | undefined, logger?: Agent37CredentialDeps["logger"]): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed?.v === 1 && typeof parsed.key === "string" && parsed.key.trim() ? parsed.key.trim() : null;
  } catch (error) {
    // A damaged item reads as "no key saved"; say so, never with the value. A
    // fixed reason only: V8's JSON.parse message quotes the text it read,
    // which here is the key.
    logger?.warn("agent37.key_item_unreadable", { reason: error instanceof SyntaxError ? "invalid_json" : "unreadable" });
    return null;
  }
}

function resolveVault(deps: Agent37CredentialDeps): Agent37Vault | null {
  if (!deps.signedIn()) return null;
  try {
    return deps.vault();
  } catch (error) {
    deps.logger?.warn("agent37.vault_unavailable", { error: errorText(error) });
    return null;
  }
}

function readMachine(deps: Agent37CredentialDeps): string | null {
  try {
    return decode(deps.machineStore()?.getSync(AGENT37_MACHINE_CREDENTIAL_KEY), deps.logger);
  } catch (error) {
    deps.logger?.warn("agent37.machine_key_read_failed", { error: errorText(error) });
    return null;
  }
}

/** Where a key saved now would land. */
function agent37StorageFor(deps: Agent37CredentialDeps): IntegrationCredentialStorage {
  return describeIntegrationCredentialStorage({
    scope: ACCOUNT_SCOPE_ALL,
    perProject: false,
    signedIn: deps.signedIn(),
    hasVault: resolveVault(deps) != null,
  });
}

/** The saved key and where it came from, or null. The key never leaves the main process or brain. */
export async function readAgent37Key(
  deps: Agent37CredentialDeps,
): Promise<{ key: string; storage: IntegrationCredentialStorage } | null> {
  const vault = resolveVault(deps);
  if (vault) {
    const got = await vault.get().catch((error: unknown) => {
      deps.logger?.warn("agent37.vault_read_failed", { error: errorText(error) });
      return { ok: false as const };
    });
    const key = got.ok ? decode(got.value, deps.logger) : null;
    if (key) return { key, storage: { storage: "account", reason: null, message: null } };
  }
  const local = readMachine(deps);
  if (!local) return null;
  // A key kept here while signed out (or while the vault was unreachable).
  const storage = agent37StorageFor(deps);
  return {
    key: local,
    storage: storage.storage === "account"
      ? { storage: "device", reason: "vault_unavailable", message: "Saved on this computer only. Save it again to use it on your other computers." }
      : storage,
  };
}

/** A client for the saved key; throws a plain sentence when there is none. */
export async function requireAgent37Client(deps: Agent37CredentialDeps): Promise<Agent37Client> {
  const saved = await readAgent37Key(deps);
  if (!saved) throw new Error("Connect Agent 37 first: ade://settings/integrations.agent37.");
  return createAgent37Client({ apiKey: saved.key, fetch: deps.fetch });
}

/**
 * Checks the key with Agent37, then stores it: in the account vault when it
 * can reach every machine, otherwise on this computer.
 */
export async function saveAgent37Key(deps: Agent37CredentialDeps, rawKey: string): Promise<Agent37Status> {
  const key = rawKey.trim();
  if (!key) throw new Error("Paste your Agent 37 API key.");
  if (!/^sk_(live|test)_/.test(key)) throw new Error("That doesn't look like an Agent 37 API key. They start with sk_live_.");
  // A refused key throws here, before anything is stored.
  await createAgent37Client({ apiKey: key, fetch: deps.fetch }).billing();
  const vault = resolveVault(deps);
  const store = deps.machineStore();
  const savedInAccount = vault
    ? await vault.set(encode(key)).catch((error: unknown) => {
      deps.logger?.warn("agent37.vault_write_failed", { error: errorText(error) });
      return false;
    })
    : false;
  if (vault && !savedInAccount) deps.logger?.warn("agent37.key_saved_on_device_only", { reason: "vault_refused" });
  if (savedInAccount) {
    store?.deleteSync(AGENT37_MACHINE_CREDENTIAL_KEY);
  } else {
    if (!store) throw new Error("ADE could not save the key on this computer.");
    store.setSync(AGENT37_MACHINE_CREDENTIAL_KEY, encode(key));
  }
  return await readAgent37Status(deps);
}

/** The account vault refused to forget the key: nothing was disconnected. */
class Agent37DisconnectFailed extends Error {
  constructor(detail: string | null) {
    super(`ADE couldn't remove the Agent 37 key from your account${detail ? ` (${detail})` : ""}, so it is still connected. Try again in a moment.`);
    this.name = "Agent37DisconnectFailed";
  }
}

/**
 * Forgets the key everywhere this computer can reach. Boxes on Agent37 keep
 * running.
 *
 * - The account holds the key and won't let go of it: nothing is removed
 *   (this computer's copy included) and this throws, so the person still
 *   sees it connected and a retry starts from the same place.
 * - The account has no copy: only this computer's copy is removed.
 * - The account can't be read at all: the key in use is this computer's
 *   (that is what the status shows), so that copy is removed; a copy the
 *   account may hold could not be checked, which is logged.
 */
export async function removeAgent37Key(
  deps: Agent37CredentialDeps,
  logger?: { warn(event: string, meta?: Record<string, unknown>): void },
): Promise<Agent37Status> {
  const vault = resolveVault(deps);
  if (vault) {
    const got = await vault.get().catch((error: unknown) => {
      logger?.warn("agent37.disconnect_vault_read_failed", { error: error instanceof Error ? error.message : String(error) });
      return { ok: false as const };
    });
    const inAccount = got.ok ? decode(got.value, deps.logger) != null : null;
    let accountUnverified = false;
    if (inAccount !== false) {
      let removed: boolean;
      let detail: string | null = null;
      try {
        removed = await vault.remove();
      } catch (error) {
        removed = false;
        detail = error instanceof Error ? error.message : String(error);
      }
      if (!removed && inAccount === true) throw new Agent37DisconnectFailed(detail);
      if (!removed) {
        accountUnverified = true;
        logger?.warn("agent37.disconnect_account_unverified", { error: detail ?? "the account vault is unreachable" });
      }
    }
    deps.machineStore()?.deleteSync(AGENT37_MACHINE_CREDENTIAL_KEY);
    const status = await readAgent37Status(deps);
    // Never report a clean disconnect the account may not have seen: this
    // computer's copy is gone, but one on the account would come back.
    if (accountUnverified && !status.error) {
      return {
        ...status,
        error: "ADE removed the key from this computer but couldn't reach your account to remove it there. Press Disconnect again when you're online.",
      };
    }
    return status;
  }
  deps.machineStore()?.deleteSync(AGENT37_MACHINE_CREDENTIAL_KEY);
  return await readAgent37Status(deps);
}

export async function readAgent37Status(deps: Agent37CredentialDeps): Promise<Agent37Status> {
  const saved = await readAgent37Key(deps);
  const empty: Agent37Status = {
    connected: false,
    credentialStorage: null,
    balanceUsd: null,
    tier: null,
    instanceLimit: null,
    instanceCount: null,
    runningCount: null,
    pastDue: false,
    error: null,
  };
  if (!saved) return empty;
  const client = createAgent37Client({ apiKey: saved.key, fetch: deps.fetch });
  try {
    const [billing, instances] = await Promise.all([client.billing(), client.listInstances()]);
    return {
      connected: true,
      credentialStorage: saved.storage,
      balanceUsd: billing.balanceUsd,
      tier: billing.tier,
      instanceLimit: billing.instanceLimit,
      instanceCount: instances.filter((instance) => instance.status !== "deleted" && instance.status !== "failed").length,
      runningCount: instances.filter((instance) => agent37StatusAwake(instance.status)).length,
      pastDue: billing.pastDue,
      error: null,
    };
  } catch (error) {
    const refused = error instanceof Agent37Error && (error.code === "invalid_api_key" || error.code === "ip_not_allowed");
    return {
      ...empty,
      // A key Agent37 refuses is not a connection; one it could not reach still is.
      connected: !refused,
      credentialStorage: saved.storage,
      error: error instanceof Error ? error.message : "Couldn't reach Agent 37.",
    };
  }
}

function balanceLabel(status: Agent37Status): string | null {
  return status.balanceUsd == null ? null : `Agent 37 wallet $${status.balanceUsd.toFixed(2)}`;
}

/** The connect card's status/save pair. */
export function buildAgent37ConnectAdapter(deps: Agent37CredentialDeps): IntegrationConnectAdapter {
  return {
    async status() {
      const status = await readAgent37Status(deps);
      const storage = agent37StorageFor(deps);
      return {
        connected: status.connected && !status.error,
        account: balanceLabel(status),
        detail: status.error ?? (status.connected ? null : "No API key saved."),
        storedOnThisMachine: storage.storage === "device" ? storage.message ?? "Saved on this computer only." : null,
      };
    },
    async save(_method, values) {
      const status = await saveAgent37Key(deps, values[CONNECT_FIELD_IDS.agent37Key] ?? "");
      return { account: balanceLabel(status) };
    },
  };
}
