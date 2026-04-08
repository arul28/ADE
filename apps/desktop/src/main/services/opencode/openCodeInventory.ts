import { createOpencodeClient } from "@opencode-ai/sdk";
import type { Logger } from "../logging/logger";
import type { EffectiveProjectConfig, ProjectConfigFile } from "../../../shared/types";
import {
  createDynamicOpenCodeModelDescriptor,
  isLocalProviderFamily,
  replaceDynamicOpenCodeModelDescriptors,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import {
  buildOpenCodeMergedConfig,
  createOpencodeServerWithRetry,
  resolveOpenCodeExecutablePath,
  type DiscoveredLocalModelEntry,
} from "./openCodeRuntime";

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

// ── Shared server with idle TTL (avoids spawning a new process per probe) ──

type SharedServer = {
  url: string;
  close(): void;
  configFingerprint: string;
  idleTimer: ReturnType<typeof setTimeout> | null;
};

let sharedServer: SharedServer | null = null;
let probeInFlight: Promise<{ modelIds: string[]; providers: OpenCodeProviderInfo[]; error: string | null; descriptors: ModelDescriptor[] }> | null = null;

function forceKillServer(server: { close(): void }): void {
  try {
    server.close();
  } catch {
    // ignore
  }
}

function resetIdleTimer(): void {
  if (!sharedServer) return;
  if (sharedServer.idleTimer) clearTimeout(sharedServer.idleTimer);
  sharedServer.idleTimer = setTimeout(() => {
    if (sharedServer) {
      forceKillServer(sharedServer);
      sharedServer = null;
    }
  }, SERVER_IDLE_TTL_MS);
}

async function getOrCreateServer(
  config: ReturnType<typeof buildOpenCodeMergedConfig>,
  fp: string,
): Promise<{ url: string }> {
  // Reuse existing server if config hasn't changed
  if (sharedServer && sharedServer.configFingerprint === fp) {
    resetIdleTimer();
    return { url: sharedServer.url };
  }
  // Config changed — kill old server
  if (sharedServer) {
    forceKillServer(sharedServer);
    sharedServer = null;
  }
  const result = await createOpencodeServerWithRetry(config);
  sharedServer = {
    url: result.server.url,
    close: result.server.close,
    configFingerprint: fp,
    idleTimer: null,
  };
  resetIdleTimer();
  return { url: sharedServer.url };
}

export function clearOpenCodeInventoryCache(): void {
  inventoryCache = null;
}

/** Shut down the shared inventory server immediately (e.g. on app quit). */
export function shutdownInventoryServer(): void {
  if (sharedServer) {
    if (sharedServer.idleTimer) clearTimeout(sharedServer.idleTimer);
    forceKillServer(sharedServer);
    sharedServer = null;
  }
}

function fingerprintOpenCodeConfig(
  projectConfig: ProjectConfigFile | EffectiveProjectConfig,
  discoveredLocalModels?: DiscoveredLocalModelEntry[],
): string {
  const ai = projectConfig.ai ?? {};
  return JSON.stringify({
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

  // Deduplicate concurrent probe calls
  if (probeInFlight) return probeInFlight;

  probeInFlight = (async () => {
    try {
      const config = buildOpenCodeMergedConfig({
        projectConfig: args.projectConfig,
        discoveredLocalModels: args.discoveredLocalModels,
      });
      const { url } = await getOrCreateServer(config, fp);
      const client = createOpencodeClient({
        baseUrl: url,
        directory: args.projectRoot,
      });
      const listed = await client.provider.list({
        query: { directory: args.projectRoot },
      });
      const data = listed.data;
      if (!data) {
        throw new Error("OpenCode provider.list returned no data.");
      }
      const connected = new Set(data.connected);
      const descriptors: ModelDescriptor[] = [];
      const providerInfos: OpenCodeProviderInfo[] = data.all.map((p) => ({
        id: p.id,
        name: typeof p.name === "string" ? p.name : p.id,
        connected: connected.has(p.id),
        modelCount: Object.keys(p.models ?? {}).length,
      }));

      // Build a set of loaded local model IDs so we can filter out unloaded models
      // that OpenCode discovers independently from the local provider endpoints.
      const loadedLocalModelIds = new Map<string, Set<string>>();
      if (args.discoveredLocalModels) {
        for (const entry of args.discoveredLocalModels) {
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
        const allowedModels = isLocal ? loadedLocalModelIds.get(provider.id) : undefined;
        const models = provider.models ?? {};
        for (const model of Object.values(models)) {
          const mid = typeof model.id === "string" ? model.id.trim() : "";
          if (!mid.length) continue;
          // For local providers, only include models that are actively loaded.
          if (isLocal && allowedModels && !allowedModels.has(mid)) continue;
          const raw = model as Record<string, unknown>;
          const variantKeys = extractVariantKeys(raw);
          const displayName = typeof model.name === "string" && model.name.trim().length ? model.name.trim() : undefined;
          const ctx = typeof model.limit === "object" && model.limit && "context" in model.limit
            ? Number((model.limit as { context?: number }).context)
            : undefined;
          const out = typeof model.limit === "object" && model.limit && "output" in model.limit
            ? Number((model.limit as { output?: number }).output)
            : undefined;
          descriptors.push(
            createDynamicOpenCodeModelDescriptor("", {
              openCodeProviderId: provider.id,
              openCodeModelId: mid,
              ...(displayName ? { displayName } : {}),
              ...(Number.isFinite(ctx) && (ctx as number) > 0 ? { contextWindow: ctx as number } : {}),
              ...(Number.isFinite(out) && (out as number) > 0 ? { maxOutputTokens: out as number } : {}),
              ...(variantKeys.length ? { reasoningTiers: variantKeys } : {}),
              capabilities: {
                tools: model.tool_call !== false,
                vision: Boolean(model.modalities?.input?.includes("image")),
                reasoning: model.reasoning !== false,
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
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      args.logger.warn("opencode.inventory_probe_failed", { error: message });
      // If the server died, clear it so next probe creates a fresh one
      if (sharedServer) {
        forceKillServer(sharedServer);
        sharedServer = null;
      }
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
      probeInFlight = null;
    }
  })();

  return probeInFlight;
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
