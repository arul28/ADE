import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import {
  createDynamicOpenCodeModelDescriptor,
  isLocalProviderFamily,
  replaceDynamicOpenCodeModelDescriptors,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { stableStringify } from "../shared/utils";
import {
  buildSharedOpenCodeServerKey,
  buildOpenCodeMergedConfig,
  resolveOpenCodeExecutablePath,
  type DiscoveredLocalModelEntry,
} from "./openCodeRuntime";
import { acquireSharedOpenCodeServer, shutdownOpenCodeServers } from "./openCodeServerManager";

const TTL_MS = 60_000;
/** How long an idle inventory server stays alive before being killed. */
const SERVER_IDLE_TTL_MS = 10_000;

/** Metadata for an OpenCode provider as returned by provider.list(). */
export type OpenCodeProviderInfo = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
  availableModelCount?: number;
};

type CacheEntry = {
  cachedAt: number;
  projectRoot: string;
  configFingerprint: string;
  passiveConfigFingerprint: string;
  catalogModelIds: string[];
  modelIds: string[];
  providers: OpenCodeProviderInfo[];
  error: string | null;
};

let inventoryCache: CacheEntry | null = null;
const probeInFlightMap = new Map<string, Promise<OpenCodeInventoryResult>>();

export type OpenCodeInventoryResult = {
  /** Selectable model ids for connected providers only. */
  modelIds: string[];
  /** Browseable catalog model ids. Unconnected cloud providers appear here but not in modelIds. */
  catalogModelIds: string[];
  providers: OpenCodeProviderInfo[];
  error: string | null;
  descriptors: ModelDescriptor[];
};

export function clearOpenCodeInventoryCache(): void {
  inventoryCache = null;
}

/** Shut down the shared inventory server immediately and clear the cached probe state (e.g. on app quit). */
export function shutdownInventoryServer(): void {
  shutdownOpenCodeServers({ leaseKind: "shared", ownerKind: "inventory" });
  clearOpenCodeInventoryCache();
}

function fingerprintOpenCodeConfig(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  discoveredLocalModels?: DiscoveredLocalModelEntry[],
): string {
  const ai = projectConfig.ai ?? {};
  return stableStringify({
    apiKeys: ai.apiKeys ?? {},
    localProviders: ai.localProviders ?? {},
    discoveredModels: discoveredLocalModels?.map((m) => `${m.provider}/${m.modelId}`).sort() ?? [],
  });
}

const OPENCODE_REASONING_VARIANT_ALIASES: Record<string, string> = {
  none: "none",
  dynamic: "dynamic",
  off: "off",
  minimal: "minimal",
  mini: "minimal",
  low: "low",
  medium: "medium",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  "extra-high": "xhigh",
  extra_high: "xhigh",
  max: "max",
  ultracode: "ultracode",
  ultra_code: "ultracode",
  "ultra-code": "ultracode",
};

const OPENCODE_SERVICE_VARIANT_ALIASES: Record<string, string> = {
  fast: "fast",
};

function addUnique(out: string[], value: string): void {
  if (!out.some((entry) => entry.trim().toLowerCase() === value)) out.push(value);
}

function normalizeVariantKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "-");
}

function classifyOpenCodeVariants(model: Record<string, unknown>): {
  reasoningTiers: string[];
  serviceTiers: string[];
} {
  const v = model.variants;
  const reasoningTiers: string[] = [];
  const serviceTiers: string[] = [];
  if (v && typeof v === "object" && !Array.isArray(v)) {
    for (const [rawKey, rawValue] of Object.entries(v as Record<string, unknown>)) {
      const key = normalizeVariantKey(rawKey);
      if (!key) continue;
      if (rawValue && typeof rawValue === "object" && (rawValue as { disabled?: unknown }).disabled === true) {
        continue;
      }
      const serviceTier = OPENCODE_SERVICE_VARIANT_ALIASES[key];
      if (serviceTier) {
        addUnique(serviceTiers, serviceTier);
        continue;
      }
      addUnique(reasoningTiers, OPENCODE_REASONING_VARIANT_ALIASES[key] ?? key);
    }
  }
  return { reasoningTiers, serviceTiers };
}

function readOpenCodeModelCapabilities(model: Record<string, unknown>): {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
  streaming: boolean;
} {
  const capabilities = model.capabilities && typeof model.capabilities === "object"
    ? model.capabilities as {
        reasoning?: unknown;
        toolcall?: unknown;
        tools?: unknown;
        input?: { image?: unknown };
      }
    : null;
  const modalities = model.modalities as { input?: string[] } | undefined;
  return {
    tools: model.tool_call !== false && capabilities?.toolcall !== false && capabilities?.tools !== false,
    vision: Boolean(model.attachment === true || modalities?.input?.includes("image") || capabilities?.input?.image === true),
    reasoning: model.reasoning !== false && capabilities?.reasoning !== false,
    streaming: true,
  };
}

function normalizeOpenCodeProviderModel(
  providerId: string,
  modelId: string,
  availableProviderModelIds: Set<string>,
  displayName?: string,
): { modelId: string; displayName?: string; contextWindow?: number; maxOutputTokens?: number; preferredDuplicateSource: boolean } {
  if (providerId.trim().toLowerCase() !== "anthropic") {
    return { modelId, ...(displayName ? { displayName } : {}), preferredDuplicateSource: true };
  }
  const normalized = modelId.trim().toLowerCase();
  const preferredDuplicateSource = normalized === "claude-sonnet-5" || normalized === "claude-opus-4-8";
  const hasCanonicalSonnet = availableProviderModelIds.has("claude-sonnet-5");
  const hasCanonicalOpus = availableProviderModelIds.has("claude-opus-4-8");
  if (normalized === "claude-sonnet-5") {
    return {
      modelId: "claude-sonnet-5",
      displayName: displayName ?? "Claude Sonnet 5",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      preferredDuplicateSource,
    };
  }
  if (normalized === "claude-opus-4-8") {
    return {
      modelId: "claude-opus-4-8",
      displayName: displayName ?? "Claude Opus 4.8 1M",
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      preferredDuplicateSource,
    };
  }
  if (normalized === "claude-sonnet-4-6" || normalized === "sonnet-4-6") {
    return {
      modelId: "claude-sonnet-5",
      displayName: "Claude Sonnet 5",
      ...(hasCanonicalSonnet ? { contextWindow: 1_000_000, maxOutputTokens: 128_000 } : {}),
      preferredDuplicateSource,
    };
  }
  if (
    normalized === "claude-opus-4-7"
    || normalized === "opus-4-7"
    || normalized === "claude-opus-4-6"
    || normalized === "opus-4-6"
    || normalized === "opus-4.6"
    || normalized === "opus"
  ) {
    return {
      modelId: "claude-opus-4-8",
      displayName: "Claude Opus 4.8 1M",
      ...(hasCanonicalOpus ? { contextWindow: 1_000_000, maxOutputTokens: 128_000 } : {}),
      preferredDuplicateSource,
    };
  }
  return { modelId, ...(displayName ? { displayName } : {}), preferredDuplicateSource };
}

function openCodeSdkErrorMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? record.data as Record<string, unknown> : null;
  if (typeof data?.message === "string" && data.message.trim().length) return data.message.trim();
  if (typeof record.message === "string" && record.message.trim().length) return record.message.trim();
  return null;
}

/**
 * Lists connected providers/models via a shared OpenCode server, updates dynamic registry entries, and caches results.
 * Reuses a single server across probes (see SERVER_IDLE_TTL_MS for the idle TTL). Concurrent calls are deduplicated.
 */
export async function probeOpenCodeProviderInventory(args: {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  logger: Logger;
  force?: boolean;
  /** Dynamically discovered models from local provider endpoints (LM Studio, Ollama). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
}): Promise<OpenCodeInventoryResult> {
  if (!resolveOpenCodeExecutablePath()) {
    replaceDynamicOpenCodeModelDescriptors([]);
    inventoryCache = null;
    return { modelIds: [], catalogModelIds: [], providers: [], error: null, descriptors: [] };
  }

  const fp = fingerprintOpenCodeConfig(args.projectConfig, args.discoveredLocalModels);
  const passiveFp = fingerprintOpenCodeConfig(args.projectConfig);
  const now = Date.now();
  if (
    !args.force
    && inventoryCache
    && inventoryCache.projectRoot === args.projectRoot
    && inventoryCache.configFingerprint === fp
    && now - inventoryCache.cachedAt < TTL_MS
  ) {
      return {
        modelIds: inventoryCache.modelIds,
        catalogModelIds: inventoryCache.catalogModelIds,
        providers: inventoryCache.providers,
        error: inventoryCache.error,
        descriptors: [],
    };
  }

  // Deduplicate concurrent probe calls keyed by config + project
  const probeKey = `${args.projectRoot}::${fp}`;
  const existing = probeInFlightMap.get(probeKey);
  if (existing) return existing;

  const probePromise = (async () => {
    try {
      const config = buildOpenCodeMergedConfig({
        projectConfig: args.projectConfig,
        discoveredLocalModels: args.discoveredLocalModels,
      });
      const lease = await acquireSharedOpenCodeServer({
        config,
        key: buildSharedOpenCodeServerKey(config),
        ownerKind: "inventory",
        ownerId: args.projectRoot,
        idleTtlMs: SERVER_IDLE_TTL_MS,
        logger: args.logger,
      });
      const client = createOpencodeClient({
        baseUrl: lease.url,
        directory: args.projectRoot,
      });
      try {
        const listed = await client.provider.list({
          query: { directory: args.projectRoot },
          throwOnError: true,
        });
        const data = listed.data as
          | {
              connected: string[];
              all: Array<{
                id: string;
                name?: string;
                models?: Record<string, Record<string, unknown>>;
              }>;
            }
          | undefined;
        if (!data) {
          throw new Error("OpenCode provider.list returned no data.");
        }
        const connected = new Set(data.connected);
        const descriptors: ModelDescriptor[] = [];
        const descriptorIds = new Map<string, number>();
        const descriptorPreferredDuplicateSources = new Map<string, boolean>();
        const availableProviderModelCounts = new Map<string, number>();

        // Build a set of loaded local model IDs so we can filter out unloaded models
        // that OpenCode discovers independently from the local provider endpoints.
        const loadedLocalModelIds = new Map<string, Set<string>>();
        const discoveredLocalProviderIds = new Set<string>();
        if (args.discoveredLocalModels) {
          for (const entry of args.discoveredLocalModels) {
            discoveredLocalProviderIds.add(entry.provider);
            if (entry.loaded === false) continue;
            let set = loadedLocalModelIds.get(entry.provider);
            if (!set) {
              set = new Set();
              loadedLocalModelIds.set(entry.provider, set);
            }
            set.add(entry.modelId);
          }
        }

        for (const provider of data.all) {
          const isLocal = isLocalProviderFamily(provider.id);
          const discoveryExists = isLocal && discoveredLocalProviderIds.has(provider.id);
          const allowedModels = discoveryExists ? loadedLocalModelIds.get(provider.id) : undefined;
          // Local runtime catalogs are volatile. Do not surface OpenCode's static
          // local-provider catalog; only show models ADE just discovered as loaded.
          if (isLocal && !discoveryExists) continue;
          const models = provider.models ?? {};
          const availableProviderModelIds = new Set(
            Object.values(models)
              .map((model) => {
                const record = model as Record<string, unknown>;
                return typeof record.id === "string" ? record.id.trim().toLowerCase() : "";
              })
              .filter(Boolean),
          );
          for (const model of Object.values(models)) {
            const modelRecord = model as Record<string, unknown>;
            const mid = typeof modelRecord.id === "string" ? modelRecord.id.trim() : "";
            if (!mid.length) continue;
            // For local providers, only include models that are actively loaded.
            if (discoveryExists && (!allowedModels || !allowedModels.has(mid))) continue;
            const variants = classifyOpenCodeVariants(modelRecord);
            const rawDisplayName = typeof modelRecord.name === "string" && modelRecord.name.trim().length ? modelRecord.name.trim() : undefined;
            const normalizedModel = normalizeOpenCodeProviderModel(provider.id, mid, availableProviderModelIds, rawDisplayName);
            const limit = typeof modelRecord.limit === "object" && modelRecord.limit
              ? modelRecord.limit as { context?: number; output?: number }
              : null;
            const ctx = typeof limit?.context === "number"
              ? Number(limit.context)
              : undefined;
            const out = typeof limit?.output === "number"
              ? Number(limit.output)
              : undefined;
            const descriptor = createDynamicOpenCodeModelDescriptor("", {
              openCodeProviderId: provider.id,
              openCodeModelId: normalizedModel.modelId,
              ...(normalizedModel.displayName ? { displayName: normalizedModel.displayName } : {}),
              ...(normalizedModel.contextWindow
                ? { contextWindow: normalizedModel.contextWindow }
                : Number.isFinite(ctx) && (ctx as number) > 0 ? { contextWindow: ctx as number } : {}),
              ...(normalizedModel.maxOutputTokens
                ? { maxOutputTokens: normalizedModel.maxOutputTokens }
                : Number.isFinite(out) && (out as number) > 0 ? { maxOutputTokens: out as number } : {}),
              ...(variants.reasoningTiers.length ? { reasoningTiers: variants.reasoningTiers } : {}),
              ...(variants.serviceTiers.length ? { serviceTiers: variants.serviceTiers } : {}),
              capabilities: readOpenCodeModelCapabilities(modelRecord),
            });
            const existingIndex = descriptorIds.get(descriptor.id);
            if (existingIndex !== undefined) {
              if (
                normalizedModel.preferredDuplicateSource
                && descriptorPreferredDuplicateSources.get(descriptor.id) !== true
              ) {
                descriptors[existingIndex] = descriptor;
                descriptorPreferredDuplicateSources.set(descriptor.id, true);
              }
              continue;
            }
            descriptorIds.set(descriptor.id, descriptors.length);
            descriptorPreferredDuplicateSources.set(descriptor.id, normalizedModel.preferredDuplicateSource);
            descriptors.push(descriptor);
            if (connected.has(provider.id)) {
              availableProviderModelCounts.set(
                provider.id,
                (availableProviderModelCounts.get(provider.id) ?? 0) + 1,
              );
            }
          }
        }

        replaceDynamicOpenCodeModelDescriptors(descriptors);
        const catalogModelIds = [...descriptors.map((d) => d.id)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const modelIds = descriptors
          .filter((d) => d.openCodeProviderId ? connected.has(d.openCodeProviderId) : true)
          .map((d) => d.id)
          .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        const catalogCounts = new Map<string, number>();
        for (const descriptor of descriptors) {
          const providerId = descriptor.openCodeProviderId ?? "opencode";
          catalogCounts.set(providerId, (catalogCounts.get(providerId) ?? 0) + 1);
        }
        const providerInfos: OpenCodeProviderInfo[] = data.all.map((p: {
          id: string;
          name?: string;
          models?: Record<string, Record<string, unknown>>;
        }) => ({
          id: p.id,
          name: typeof p.name === "string" ? p.name : p.id,
          connected: connected.has(p.id),
          modelCount: isLocalProviderFamily(p.id)
            ? catalogCounts.get(p.id) ?? 0
            : Object.keys(p.models ?? {}).length,
          availableModelCount: availableProviderModelCounts.get(p.id) ?? 0,
        }));
        inventoryCache = {
          cachedAt: Date.now(),
          projectRoot: args.projectRoot,
          configFingerprint: fp,
          passiveConfigFingerprint: passiveFp,
          catalogModelIds,
          modelIds,
          providers: providerInfos,
          error: null,
        };
        return { modelIds, catalogModelIds, providers: providerInfos, error: null, descriptors };
      } finally {
        lease.release("handle_close");
      }
    } catch (err) {
      const message = openCodeSdkErrorMessage(err) ?? (err instanceof Error ? err.message : String(err));
      args.logger.warn("opencode.inventory_probe_failed", { error: message });
      replaceDynamicOpenCodeModelDescriptors([]);
      inventoryCache = {
        cachedAt: Date.now(),
        projectRoot: args.projectRoot,
        configFingerprint: fp,
        passiveConfigFingerprint: passiveFp,
        catalogModelIds: [],
        modelIds: [],
        providers: [],
        error: message,
      };
      return { modelIds: [], catalogModelIds: [], providers: [], error: message, descriptors: [] };
    } finally {
      probeInFlightMap.delete(probeKey);
    }
  })();

  probeInFlightMap.set(probeKey, probePromise);
  return probePromise;
}

/** Read cached inventory without starting a server (may be stale or for a different project/config). */
export function peekOpenCodeInventoryCache(args: {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
}): { modelIds: string[]; catalogModelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null } | null {
  const fp = fingerprintOpenCodeConfig(args.projectConfig);
  if (!inventoryCache) return null;
  if (inventoryCache.projectRoot !== args.projectRoot) return null;
  if (inventoryCache.passiveConfigFingerprint !== fp && inventoryCache.configFingerprint !== fp) return null;
  return {
    modelIds: inventoryCache.modelIds,
    catalogModelIds: inventoryCache.catalogModelIds,
    providers: inventoryCache.providers,
    error: inventoryCache.error,
  };
}
