/**
 * How ADE reaches the cloud provider, and the one place that picks it.
 *
 * Today the provider is the account's Agent 37 workspace, reached with the key
 * already in the account vault. Cloud 2 replaces `getCloudProvider` with a
 * provider that goes through ADE's server, and nothing above it changes.
 */

import { ACCOUNT_SCOPE_ALL } from "../../../shared/accountSettingsScope";
import { cloudStatusAwake, type CloudStatus } from "../../../shared/adeCloud";
import type { AccountVaultResult } from "../../../shared/types/accountVault";
import { getErrorMessage } from "../shared/utils";
import { CLOUD_ACCESS_REFUSED, CloudProviderError, type CloudProvider } from "./cloudProvider";
import { AGENT37_KEY_VAULT_ITEM, createAgent37Provider } from "./provider/agent37/agent37Client";

export const CLOUD_VAULT_KIND = "integration";
export const CLOUD_PROVIDER_VAULT_ITEM = AGENT37_KEY_VAULT_ITEM;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** One account vault item. `ok: false` means unreachable, not empty. */
export type CloudVault = {
  get(): Promise<{ ok: true; value: string | null } | { ok: false }>;
  set(value: string): Promise<boolean>;
  remove(): Promise<boolean>;
};

export type CloudAccessDeps = {
  /** Null when this runtime has no vault (no brain, nothing booted). */
  vault: () => CloudVault | null;
  signedIn: () => boolean;
  fetch?: FetchLike;
  logger?: { warn(event: string, meta?: Record<string, unknown>): void };
};

type CloudVaultBridge = {
  get(scope: string, kind: string, key: string): Promise<AccountVaultResult<string | null>>;
  set(scope: string, kind: string, key: string, value: string): Promise<AccountVaultResult<null>>;
  remove(scope: string, kind: string, key: string): Promise<AccountVaultResult<null>>;
};

/** Desktop main: one account-wide item in the brain's vault over `accountVaultBridge`. */
export function cloudVaultFromBridge(bridge: CloudVaultBridge, key: string): CloudVault {
  return {
    async get() {
      const result = await bridge.get(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key);
      return result.ok ? { ok: true, value: result.value } : { ok: false };
    },
    async set(value) {
      return (await bridge.set(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key, value)).ok;
    },
    async remove() {
      return (await bridge.remove(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key)).ok;
    },
  };
}

/** The brain: one account-wide item in its own vault store. */
export function cloudVaultFromStore(store: {
  get(scope: string, kind: "integration", key: string): string | null;
  set(scope: string, kind: "integration", key: string, value: string): boolean;
  remove(scope: string, kind: "integration", key: string): boolean;
}, key: string): CloudVault {
  return {
    async get() {
      return { ok: true, value: store.get(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key) };
    },
    async set(value) {
      return store.set(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key, value);
    },
    async remove() {
      return store.remove(ACCOUNT_SCOPE_ALL, CLOUD_VAULT_KIND, key);
    },
  };
}

function decodeKey(raw: string | null, deps: CloudAccessDeps): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed?.v === 1 && typeof parsed.key === "string" && parsed.key.trim() ? parsed.key.trim() : null;
  } catch (error) {
    // A fixed reason only: V8's JSON.parse message quotes the text it read, which here is the key.
    deps.logger?.warn("cloud.key_item_unreadable", { reason: error instanceof SyntaxError ? "invalid_json" : "unreadable" });
    return null;
  }
}

type CloudAccess =
  | { state: "ready"; provider: CloudProvider }
  | { state: "no_access" | "signed_out" | "unreadable" };

const NO_PROVIDER_SENTENCE: Record<Exclude<CloudAccess["state"], "ready">, string> = {
  no_access: "ADE Cloud isn't available on this account yet.",
  signed_out: "Sign in to ADE to use ADE Cloud.",
  unreadable: "ADE couldn't check this account's ADE Cloud access. Try again in a moment.",
};

async function readCloudAccess(deps: CloudAccessDeps): Promise<CloudAccess> {
  // A development brain runs with sync off and never opens the account vault.
  const developmentKey = process.env.ADE_CLOUD_DEV_KEY?.trim();
  if (developmentKey) return { state: "ready", provider: createAgent37Provider({ apiKey: developmentKey, fetch: deps.fetch }) };
  if (!deps.signedIn()) return { state: "signed_out" };
  let vault: CloudVault | null;
  try {
    vault = deps.vault();
  } catch (error) {
    deps.logger?.warn("cloud.vault_unavailable", { error: getErrorMessage(error) });
    return { state: "unreadable" };
  }
  if (!vault) return { state: "unreadable" };
  const got = await vault.get().catch((error: unknown) => {
    deps.logger?.warn("cloud.vault_read_failed", { error: getErrorMessage(error) });
    return { ok: false as const };
  });
  if (!got.ok) return { state: "unreadable" };
  const apiKey = decodeKey(got.value, deps);
  return apiKey ? { state: "ready", provider: createAgent37Provider({ apiKey, fetch: deps.fetch }) } : { state: "no_access" };
}

/** ADE Cloud for this account, or null when it can't be used from here right now. */
export async function getCloudProvider(deps: CloudAccessDeps): Promise<CloudProvider | null> {
  const access = await readCloudAccess(deps);
  return access.state === "ready" ? access.provider : null;
}

/** ADE Cloud for this account; throws a plain sentence when there is none. */
export async function requireCloudProvider(deps: CloudAccessDeps): Promise<CloudProvider> {
  const access = await readCloudAccess(deps);
  if (access.state !== "ready") throw new Error(NO_PROVIDER_SENTENCE[access.state]);
  return access.provider;
}

const NO_ACCESS: CloudStatus = { connected: false, instanceCount: null, runningCount: null, error: null };

export async function readCloudStatus(deps: CloudAccessDeps): Promise<CloudStatus> {
  const access = await readCloudAccess(deps);
  if (access.state === "no_access") return NO_ACCESS;
  // Not a fact about the account, so the surfaces show it as a failed check.
  if (access.state !== "ready") return { ...NO_ACCESS, connected: true, error: NO_PROVIDER_SENTENCE[access.state] };
  try {
    const instances = await access.provider.listInstances();
    return {
      connected: true,
      instanceCount: instances.filter((instance) => instance.status !== "deleted" && instance.status !== "failed").length,
      runningCount: instances.filter((instance) => cloudStatusAwake(instance.status)).length,
      error: null,
    };
  } catch (error) {
    const refused = error instanceof CloudProviderError && error.code === CLOUD_ACCESS_REFUSED;
    // Refused is no access; one that could not be reached still is.
    return { ...NO_ACCESS, connected: !refused, error: error instanceof Error ? error.message : "Couldn't reach ADE Cloud." };
  }
}
