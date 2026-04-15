import type { AgentChatModelInfo, AgentChatProvider, AiSettingsStatus } from "../../shared/types";

type StatusCacheEntry = {
  value: AiSettingsStatus | null;
  timestamp: number;
  inFlight: Promise<AiSettingsStatus> | null;
  includesOpenCodeInventory: boolean;
  inFlightIncludesOpenCodeInventory: boolean;
};

type ModelsCacheEntry = {
  value: AgentChatModelInfo[] | null;
  timestamp: number;
  inFlight: Promise<AgentChatModelInfo[]> | null;
};

const DEFAULT_AI_STATUS_TTL_MS = 10_000;
const DEFAULT_MODELS_TTL_MS = 30_000;

const aiStatusCache = new Map<string, StatusCacheEntry>();
const providerModelsCache = new Map<string, ModelsCacheEntry>();

function normalizeProjectRoot(projectRoot: string | null | undefined): string {
  return projectRoot?.trim() || "<no-project>";
}

function statusCacheKey(projectRoot: string | null | undefined): string {
  return normalizeProjectRoot(projectRoot);
}

function modelsCacheKey(projectRoot: string | null | undefined, provider: AgentChatProvider): string {
  return `${normalizeProjectRoot(projectRoot)}::${provider}`;
}

export async function getAiStatusCached(args: {
  projectRoot: string | null | undefined;
  force?: boolean;
  ttlMs?: number;
  refreshOpenCodeInventory?: boolean;
}): Promise<AiSettingsStatus> {
  const key = statusCacheKey(args.projectRoot);
  const ttlMs = args.ttlMs ?? DEFAULT_AI_STATUS_TTL_MS;
  const now = Date.now();
  const existing = aiStatusCache.get(key);
  const requiresOpenCodeInventory = args.refreshOpenCodeInventory === true;

  if (
    !args.force
    && existing?.value
    && now - existing.timestamp < ttlMs
    && (!requiresOpenCodeInventory || existing.includesOpenCodeInventory)
  ) {
    return existing.value;
  }
  if (
    !args.force
    && existing?.inFlight
    && (!requiresOpenCodeInventory || existing.inFlightIncludesOpenCodeInventory)
  ) {
    return existing.inFlight;
  }

  let request: Promise<AiSettingsStatus> | null = null;
  request = window.ade.ai.getStatus({
    force: args.force === true,
    refreshOpenCodeInventory: requiresOpenCodeInventory,
  }).then((status) => {
    const current = aiStatusCache.get(key);
    if (current?.inFlight === request) {
      aiStatusCache.set(key, {
        value: status,
        timestamp: Date.now(),
        inFlight: null,
        includesOpenCodeInventory: requiresOpenCodeInventory,
        inFlightIncludesOpenCodeInventory: false,
      });
    }
    return status;
  }).catch((error) => {
    const current = aiStatusCache.get(key);
    if (current?.inFlight === request) {
      aiStatusCache.set(key, {
        value: current.value,
        timestamp: current.timestamp,
        inFlight: null,
        includesOpenCodeInventory: current.includesOpenCodeInventory,
        inFlightIncludesOpenCodeInventory: false,
      });
    }
    throw error;
  });

  aiStatusCache.set(key, {
    value: existing?.value ?? null,
    timestamp: existing?.timestamp ?? 0,
    inFlight: request,
    includesOpenCodeInventory: existing?.includesOpenCodeInventory ?? false,
    inFlightIncludesOpenCodeInventory: requiresOpenCodeInventory,
  });

  return request;
}

export async function getAgentChatModelsCached(args: {
  projectRoot: string | null | undefined;
  provider: AgentChatProvider;
  force?: boolean;
  ttlMs?: number;
}): Promise<AgentChatModelInfo[]> {
  const key = modelsCacheKey(args.projectRoot, args.provider);
  const ttlMs = args.ttlMs ?? DEFAULT_MODELS_TTL_MS;
  const now = Date.now();
  const existing = providerModelsCache.get(key);

  if (!args.force && existing?.value && now - existing.timestamp < ttlMs) {
    return existing.value;
  }
  if (!args.force && existing?.inFlight) {
    return existing.inFlight;
  }

  let request: Promise<AgentChatModelInfo[]> | null = null;
  request = window.ade.agentChat.models({ provider: args.provider }).then((models) => {
    const current = providerModelsCache.get(key);
    if (current?.inFlight === request) {
      providerModelsCache.set(key, {
        value: models,
        timestamp: Date.now(),
        inFlight: null,
      });
    }
    return models;
  }).catch((error) => {
    const current = providerModelsCache.get(key);
    if (current?.inFlight === request) {
      providerModelsCache.set(key, {
        value: current.value,
        timestamp: current.timestamp,
        inFlight: null,
      });
    }
    throw error;
  });

  providerModelsCache.set(key, {
    value: existing?.value ?? null,
    timestamp: existing?.timestamp ?? 0,
    inFlight: request,
  });

  return request;
}

export function invalidateAiDiscoveryCache(projectRoot?: string | null): void {
  if (projectRoot == null) {
    aiStatusCache.clear();
    providerModelsCache.clear();
    return;
  }

  const normalized = normalizeProjectRoot(projectRoot);
  aiStatusCache.delete(normalized);
  for (const key of providerModelsCache.keys()) {
    if (key.startsWith(`${normalized}::`)) {
      providerModelsCache.delete(key);
    }
  }
}
