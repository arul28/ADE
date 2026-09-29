/**
 * The accounts and stored keys this computer can offer a Custom provider.
 *
 * Read from places ADE already has: provider accounts from the machine-local
 * instance registry, stored keys from the API-key store. OpenCode sign-ins and
 * the model lists per source come from `ai.listHarnessRoutes` instead (see
 * `useHarnessReach`).
 *
 * Read-only and tolerant: an older preload without `providerInstances`, or an
 * API-key store that has not grown its multi-credential shape yet, still
 * produces a usable list rather than an exception.
 */

import type { AiSettingsStatus } from "../../../../shared/types";
import {
  DEFAULT_API_CREDENTIAL_ID,
  type ApiCredentialSummary,
} from "../../../../shared/types/apiCredentials";
import type { ProviderInstance } from "../../../../shared/types/providerInstances";
import type { OpenProjectBinding } from "../../../../shared/types";
import { providerLabel } from "../../../../shared/modelCatalog";
import {
  HARNESS_PRESET_ACCOUNT_PROVIDERS,
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
export async function loadHarnessAccounts(
  /** The machine whose accounts to list; null = the tab's binding. */
  pin: OpenProjectBinding | null = null,
): Promise<HarnessAccountSource[]> {
  const bridge = (window as unknown as {
    ade?: {
      providerInstances?: {
        list?: (args?: undefined, pin?: OpenProjectBinding | null) => Promise<ProviderInstance[]>;
      };
    };
  }).ade?.providerInstances;
  if (typeof bridge?.list === "function") {
    try {
      const instances = await bridge.list(undefined, pin);
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
