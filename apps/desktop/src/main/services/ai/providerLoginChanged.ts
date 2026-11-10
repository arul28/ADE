/**
 * The one "login changed" path for a provider on this machine.
 *
 * A sign-in (Settings, first setup, the in-chat card, a CLI runner, a
 * re-check) can make a provider's cached answers wrong: the CLI cache, the
 * ACP probe verdict, the runtime health a chat reported, the account read,
 * and the status payload built from all of them. Every sign-in path calls
 * `noteProviderLoginChanged`, so the page, the provider card and the model
 * list read the same fresh answer.
 *
 * The status payload lives inside each `aiIntegrationService`, so this module
 * only bumps a generation; the service drops its caches when it sees a new one.
 * Nothing here starts a process, but a model list marked old here is read
 * again on the next status read, and for some providers that starts one.
 */
import { ACP_PROVIDER_IDS, type AcpProviderId } from "../../../shared/acpProviderMetadata";
import { invalidateCliAuthStatusCache } from "./authDetector";
import { resetAcpAuthProbeCache } from "./acpAuthProbe";
import { resetProviderRuntimeHealth, type ProviderRuntimeHealthProvider } from "./providerRuntimeHealth";
import { invalidateCachedClaudeCredentials } from "./providerCredentialSources";
import { clearProviderAccountCache } from "../usage/providerAccountIdentity";

let generation = 0;
const providerGenerations = new Map<string, number>();

const RUNTIME_HEALTH_PROVIDERS: ReadonlySet<string> = new Set<ProviderRuntimeHealthProvider>([
  "claude", "codex", "cursor", "pi", "muse", "qwen", "kimi", "grok", "copilot", "devin", "antigravity",
]);

/** A provider whose chats and checks report runtime health. */
export function isRuntimeHealthProvider(provider: string): provider is ProviderRuntimeHealthProvider {
  return RUNTIME_HEALTH_PROVIDERS.has(provider);
}

function isAcpProvider(provider: string): provider is AcpProviderId {
  return (ACP_PROVIDER_IDS as readonly string[]).includes(provider);
}

/**
 * Bumped on every login change; a status cache built under an older one is
 * stale. With a provider, only a change that can alter that provider's
 * model list counts (Copilot's list and Pi's inventory key on it).
 */
export function providerLoginGeneration(provider?: string): number {
  return provider ? providerGenerations.get(provider) ?? 0 : generation;
}

/**
 * The login may now be another account, whose models differ: mark the
 * provider's model lists old, so the next status read lists them again.
 */
export function noteProviderModelsChanged(provider: string): void {
  const id = provider.trim().toLowerCase();
  if (isAcpProvider(id)) {
    // Loaded on use, as the probe does: model discovery imports the probe module.
    void import("../chat/acpHost/acpModelDiscovery")
      .then((discovery) => discovery.markAcpModelCatalogStale(id))
      .catch(() => undefined);
  }
  generation += 1;
  providerGenerations.set(id, (providerGenerations.get(id) ?? 0) + 1);
}

/**
 * Drop every cached answer about `provider`'s sign-in on this machine. Other
 * providers keep theirs: a Grok sign-in says nothing about Claude.
 *
 * `refreshModels: false` keeps the model lists. A Re-check passes it: it
 * does not know yet whether anything changed, and a list read starts the
 * agent a second time. It marks them old itself once the answer changed.
 */
export function noteProviderLoginChanged(provider: string, options?: { refreshModels?: boolean }): void {
  const id = provider.trim().toLowerCase();
  invalidateCliAuthStatusCache();
  if (isRuntimeHealthProvider(id)) resetProviderRuntimeHealth(id);
  if (id === "claude") invalidateCachedClaudeCredentials();
  if (id === "claude" || id === "codex") clearProviderAccountCache();
  if (isAcpProvider(id)) resetAcpAuthProbeCache(id);
  if (id === "antigravity") {
    void import("./antigravityAuth")
      .then((auth) => auth.invalidateAntigravityAuthCache())
      .catch(() => undefined);
  }
  if (options?.refreshModels === false) {
    generation += 1;
    return;
  }
  noteProviderModelsChanged(id);
}
