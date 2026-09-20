/**
 * What brains this computer can actually offer a harness.
 *
 * Three lists, read from three places ADE already has, and deliberately not
 * from a new IPC channel: provider accounts come from the machine-local
 * instance registry, stored keys from the API-key store, and the "borrow a
 * subscription through ADE's proxy" rows are synthesised because the proxy
 * holds them, not this machine.
 *
 * Everything here is read-only and tolerant: an older preload without
 * `providerInstances`, an API-key store that has not grown its multi-credential
 * shape yet, and a host with no proxy at all must all produce a usable list
 * rather than an exception. The wizard shows what is there and says plainly
 * what is not — it never invents an account or claims a sign-in it cannot do.
 */

import type { AiSettingsStatus } from "../../../../shared/types";
import {
  DEFAULT_API_CREDENTIAL_ID,
  type ApiCredentialSummary,
} from "../../../../shared/types/apiCredentials";
import type { ProviderInstance } from "../../../../shared/types/providerInstances";
import { providerLabel } from "../../../../shared/modelCatalog";
import {
  HARNESS_PRESET_ACCOUNT_PROVIDERS,
  harnessBodyLabel,
  type HarnessPresetAccountProvider,
  type HarnessPresetSource,
} from "../../../../shared/harnessPresets";

/** One account row in the wizard's source list. */
export type HarnessAccountSource = {
  kind: "account";
  provider: HarnessPresetAccountProvider;
  instanceId: string;
  label: string;
  email?: string;
  plan?: string;
  signedIn: boolean;
  accentColor?: string;
};

/** One stored-key row. `credentialId` is the reference a preset saves. */
export type HarnessKeySource = {
  kind: "key";
  provider: string;
  credentialId: string;
  label: string;
  /** Last few characters of the key, when the store reports them. */
  maskedTail?: string;
  /** Set when the key points at a custom OpenAI-compatible endpoint. */
  baseUrl?: string;
  /** Models the custom endpoint declares. Empty means "type the id yourself". */
  models?: string[];
};

/** One "borrow this subscription in another harness" row. */
export type HarnessSubscriptionSource = {
  kind: "subscription";
  provider: HarnessPresetAccountProvider;
  label: string;
};

export type HarnessBrainSource = HarnessAccountSource | HarnessKeySource | HarnessSubscriptionSource;

export type HarnessSourceInventory = {
  accounts: HarnessAccountSource[];
  keys: HarnessKeySource[];
  subscriptions: HarnessSubscriptionSource[];
  /** Whether this host can hold a proxy sign-in at all. */
  proxySignInAvailable: boolean;
};

export const EMPTY_HARNESS_SOURCE_INVENTORY: HarnessSourceInventory = {
  accounts: [],
  keys: [],
  subscriptions: [],
  proxySignInAvailable: false,
};

/**
 * The sentence shown on a disabled proxy sign-in button.
 *
 * Stated once, here, because a second copy in the wizard is how "not available
 * yet" turns into a button that silently does nothing on one surface.
 */
export const HARNESS_PROXY_SIGN_IN_UNAVAILABLE =
  "Sign-in through ADE's proxy is not available yet on this host.";

type ProxyBridge = { signIn?: (args: { provider: string }) => Promise<unknown> };

/** True only when the host actually exposes a proxy sign-in call. */
export function proxySignInAvailable(): boolean {
  const proxy = (window as unknown as { ade?: { proxy?: ProxyBridge } }).ade?.proxy;
  return typeof proxy?.signIn === "function";
}

function accountFromInstance(instance: ProviderInstance): HarnessAccountSource {
  return {
    kind: "account",
    provider: instance.provider,
    instanceId: instance.id,
    label: instance.label,
    ...(instance.account?.email ? { email: instance.account.email } : {}),
    ...(instance.account?.plan ? { plan: instance.account.plan } : {}),
    signedIn: instance.signedIn === true,
    ...(instance.accentColor ? { accentColor: instance.accentColor } : {}),
  };
}

/**
 * The accounts this machine holds.
 *
 * A preload without `providerInstances` is an older desktop, not an error: it
 * still has exactly one identity per provider, so the default account is
 * synthesised with the provider slug as its id — the same id the registry uses
 * for the default instance, so a preset saved here keeps working once the real
 * registry arrives.
 */
export async function loadHarnessAccounts(): Promise<HarnessAccountSource[]> {
  const bridge = (window as unknown as {
    ade?: { providerInstances?: { list?: () => Promise<ProviderInstance[]> } };
  }).ade?.providerInstances;
  if (typeof bridge?.list === "function") {
    try {
      const instances = await bridge.list();
      if (Array.isArray(instances) && instances.length > 0) {
        return instances
          .filter((instance) => instance && typeof instance.id === "string")
          .map(accountFromInstance);
      }
    } catch {
      // Fall through to the synthesized defaults below. A registry that cannot
      // be read is indistinguishable from one that does not exist yet, and both
      // still have the machine's pre-existing sign-in.
    }
  }
  return HARNESS_PRESET_ACCOUNT_PROVIDERS.map((provider) => ({
    kind: "account" as const,
    provider,
    instanceId: provider,
    label: "Default",
    signedIn: true,
  }));
}

/**
 * Stored API keys, across the current summary bridge and the legacy provider list.
 *
 * The current bridge is the authority for multi-credential rows: a custom
 * OpenCode provider can have a non-default credential id, and that id must
 * survive into the preset. Older hosts only expose `listApiKeys`, so their
 * provider names remain a fallback rather than disappearing from the wizard.
 */
export function readStoredKeySources(
  status: AiSettingsStatus | null,
  storedProviders: readonly string[],
  credentialSummaries: readonly ApiCredentialSummary[] = [],
): HarnessKeySource[] {
  const customById = new Map(
    (status?.customProviders ?? []).map((entry) => [entry.id, entry] as const),
  );

  // A key with no label of its own reads as its vendor ("OpenAI", "DeepSeek"),
  // never as the raw store id — the id is what a preset references, not what a
  // person picks from a list.
  function decorate(provider: string, explicitLabel: string | null, base: HarnessKeySource): HarnessKeySource {
    const custom = customById.get(provider);
    if (!custom) return base;
    const customLabel = custom.name?.trim();
    return {
      ...base,
      label: explicitLabel ?? (customLabel || base.label),
      ...(base.baseUrl || custom.baseURL ? { baseUrl: base.baseUrl ?? custom.baseURL } : {}),
      ...(base.models?.length ? { models: base.models } : custom.models?.length ? { models: custom.models } : {}),
    };
  }

  const out = credentialSummaries.flatMap((summary) => {
    const provider = typeof summary.provider === "string" ? summary.provider.trim() : "";
    const credentialId = typeof summary.credentialId === "string" ? summary.credentialId.trim() : "";
    if (!provider || !credentialId) return [];
    const explicitLabel = typeof summary.label === "string" && summary.label.trim() ? summary.label.trim() : null;
    const models = Array.isArray(summary.models)
      ? summary.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
      : undefined;
    return [decorate(provider, explicitLabel, {
      kind: "key" as const,
      provider,
      credentialId,
      label: explicitLabel ?? providerLabel(provider),
      ...(summary.maskedTail?.trim() ? { maskedTail: summary.maskedTail.trim() } : {}),
      ...(summary.baseUrl?.trim() ? { baseUrl: summary.baseUrl.trim() } : {}),
      ...(models?.length ? { models } : {}),
    })];
  });
  const seen = new Set(out.map((entry) => `${entry.provider}\u0000${entry.credentialId}`));
  const hasDefaultSummary = new Set(
    out.filter((entry) => entry.credentialId === DEFAULT_API_CREDENTIAL_ID).map((entry) => entry.provider),
  );

  return [
    ...out,
    ...storedProviders
    .filter((provider) => typeof provider === "string" && provider.trim().length > 0)
    .filter((provider) => {
      const identity = `${provider}\u0000${DEFAULT_API_CREDENTIAL_ID}`;
      return !seen.has(identity) && !hasDefaultSummary.has(provider);
    })
    .map((provider) =>
      decorate(provider, null, {
        kind: "key",
        provider,
        credentialId: DEFAULT_API_CREDENTIAL_ID,
        label: providerLabel(provider),
      }),
    ),
  ];
}

/** The short provider name an account row leads with: "Claude · Work". */
function harnessAccountProviderLabel(provider: HarnessPresetAccountProvider): string {
  return provider === "claude" ? "Claude" : "Codex";
}

/**
 * The bold line of a source row.
 *
 * Accounts read `Provider · Label` so two "Default" rows from two providers
 * are never twins; keys read as their vendor, with the user's own label after
 * it when one was given; subscriptions already carry a full sentence.
 */
export function harnessSourceRowTitle(row: HarnessBrainSource): string {
  if (row.kind === "account") return `${harnessAccountProviderLabel(row.provider)} · ${row.label}`;
  if (row.kind === "key") {
    const vendor = providerLabel(row.provider);
    return row.label && row.label !== vendor && row.label !== row.provider ? `${vendor} · ${row.label}` : vendor;
  }
  return row.label;
}

/** The muted line under a source row: what it is, and what identifies it. */
export function harnessSourceRowDetail(row: HarnessBrainSource): string {
  if (row.kind === "account") {
    const facts = [row.email, row.plan].filter((entry): entry is string => Boolean(entry));
    if (facts.length) return facts.join(" · ");
    return row.signedIn ? "Signed in on this computer" : "Not signed in yet";
  }
  if (row.kind === "key") {
    const parts = ["API key"];
    if (row.maskedTail) parts.push(`••••${row.maskedTail}`);
    if (row.baseUrl) parts.push(row.baseUrl);
    return parts.join(" · ");
  }
  return "Used inside another harness through ADE's proxy";
}

/** The two subscriptions a foreign harness can borrow through the proxy. */
export function subscriptionSources(): HarnessSubscriptionSource[] {
  return HARNESS_PRESET_ACCOUNT_PROVIDERS.map((provider) => ({
    kind: "subscription" as const,
    provider,
    label: `${harnessBodyLabel(provider)} subscription`,
  }));
}

/** Turn a picked row back into the value a preset stores. */
export function sourceFromInventoryRow(row: HarnessBrainSource): HarnessPresetSource {
  if (row.kind === "account") {
    return { kind: "account", provider: row.provider, instanceId: row.instanceId };
  }
  if (row.kind === "key") {
    return { kind: "key", provider: row.provider, credentialId: row.credentialId, label: row.label };
  }
  return { kind: "subscription", provider: row.provider };
}

/** Whether a stored source still points at something this machine has. */
export function sourceMatchesRow(source: HarnessPresetSource, row: HarnessBrainSource): boolean {
  if (source.kind !== row.kind) return false;
  if (source.kind === "account" && row.kind === "account") return source.instanceId === row.instanceId;
  if (source.kind === "key" && row.kind === "key") {
    return source.provider === row.provider && source.credentialId === row.credentialId;
  }
  if (source.kind === "subscription" && row.kind === "subscription") return source.provider === row.provider;
  return false;
}
