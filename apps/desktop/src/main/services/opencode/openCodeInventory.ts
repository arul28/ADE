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
const SERVER_IDLE_TTL_MS = 30_000;

/** Metadata for an OpenCode provider as returned by provider.list(). */
export type OpenCodeProviderInfo = {
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
};

type CacheEntry = {
  cachedAt: number;
  projectRoot: string;
  configFingerprint: string;
  modelIds: string[];
  providers: OpenCodeProviderInfo[];
  error: string | null;
};

let inventoryCache: CacheEntry | null = null;
const probeInFlightMap = new Map<string, Promise<{ modelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null; descriptors: ModelDescriptor[] }>>();

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

function extractVariantKeys(model: Record<string, unknown>): string[] {
  const v = model.variants;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return Object.keys(v as Record<string, unknown>).filter(Boolean);
  }
  return [];
}

/**
 * Lists connected providers/models via a shared OpenCode server, updates dynamic registry entries, and caches results.
 * Reuses a single server across probes (30s idle TTL). Concurrent calls are deduplicated.
 */
export async function probeOpenCodeProviderInventory(args: {
  projectRoot: string;
  projectConfig: ProjectConfigFile | EffectiveProjectConfig;
  logger: Logger;
  force?: boolean;
  /** Dynamically discovered models from local provider endpoints (LM Studio, Ollama). */
  discoveredLocalModels?: DiscoveredLocalModelEntry[];
}): Promise<{ modelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null; descriptors: ModelDescriptor[] }> {
  if (!resolveOpenCodeExecutablePath()) {
    replaceDynamicOpenCodeModelDescriptors([]);
    inventoryCache = null;
    return { modelIds: [], providers: [], error: null, descriptors: [] };
  }

  const fp = fingerprintOpenCodeConfig(args.projectConfig, args.discoveredLocalModels);
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
        const providerInfos: OpenCodeProviderInfo[] = data.all.map((p: {
          id: string;
          name?: string;
          models?: Record<string, Record<string, unknown>>;
        }) => ({
          id: p.id,
          name: typeof p.name === "string" ? p.name : p.id,
          connected: connected.has(p.id),
          modelCount: Object.keys(p.models ?? {}).length,
        }));

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
          if (!connected.has(provider.id)) continue;
          const isLocal = isLocalProviderFamily(provider.id);
          const discoveryExists = isLocal && discoveredLocalProviderIds.has(provider.id);
          const allowedModels = discoveryExists ? loadedLocalModelIds.get(provider.id) : undefined;
          const models = provider.models ?? {};
          for (const model of Object.values(models)) {
            const modelRecord = model as Record<string, unknown>;
            const mid = typeof modelRecord.id === "string" ? modelRecord.id.trim() : "";
            if (!mid.length) continue;
            // For local providers, only include models that are actively loaded.
            if (discoveryExists && (!allowedModels || !allowedModels.has(mid))) continue;
            const variantKeys = extractVariantKeys(modelRecord);
            const displayName = typeof modelRecord.name === "string" && modelRecord.name.trim().length ? modelRecord.name.trim() : undefined;
            const limit = typeof modelRecord.limit === "object" && modelRecord.limit
              ? modelRecord.limit as { context?: number; output?: number }
              : null;
            const ctx = typeof limit?.context === "number"
              ? Number(limit.context)
              : undefined;
            const out = typeof limit?.output === "number"
              ? Number(limit.output)
              : undefined;
            const modalities = modelRecord.modalities as { input?: string[] } | undefined;
            descriptors.push(
              createDynamicOpenCodeModelDescriptor("", {
                openCodeProviderId: provider.id,
                openCodeModelId: mid,
                ...(displayName ? { displayName } : {}),
                ...(Number.isFinite(ctx) && (ctx as number) > 0 ? { contextWindow: ctx as number } : {}),
                ...(Number.isFinite(out) && (out as number) > 0 ? { maxOutputTokens: out as number } : {}),
                ...(variantKeys.length ? { reasoningTiers: variantKeys } : {}),
                capabilities: {
                  tools: modelRecord.tool_call !== false,
                  vision: Boolean(modalities?.input?.includes("image")),
                  reasoning: modelRecord.reasoning !== false,
                  streaming: true,
                },
              }),
            );
          }
        }

        replaceDynamicOpenCodeModelDescriptors(descriptors);
        const modelIds = [...descriptors.map((d) => d.id)].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
        inventoryCache = {
          cachedAt: Date.now(),
          projectRoot: args.projectRoot,
          configFingerprint: fp,
          modelIds,
          providers: providerInfos,
          error: null,
        };
        return { modelIds, providers: providerInfos, error: null, descriptors };
      } finally {
        lease.release("handle_close");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.logger.warn("opencode.inventory_probe_failed", { error: message });
      replaceDynamicOpenCodeModelDescriptors([]);
      inventoryCache = {
        cachedAt: Date.now(),
        projectRoot: args.projectRoot,
        configFingerprint: fp,
        modelIds: [],
        providers: [],
        error: message,
      };
      return { modelIds: [], providers: [], error: message, descriptors: [] };
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
}): { modelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null } | null {
  const fp = fingerprintOpenCodeConfig(args.projectConfig);
  if (!inventoryCache) return null;
  if (inventoryCache.projectRoot !== args.projectRoot || inventoryCache.configFingerprint !== fp) return null;
  return { modelIds: inventoryCache.modelIds, providers: inventoryCache.providers, error: inventoryCache.error };
}
