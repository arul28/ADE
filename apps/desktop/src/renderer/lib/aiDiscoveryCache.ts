import type {
  AgentChatModelInfo,
  AgentChatProvider,
  AiSettingsStatus,
  OpenProjectBinding,
} from "../../shared/types";

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
export const AI_STATUS_CACHE_INVALIDATED_EVENT = "ade:ai-status-cache-invalidated";
export const AI_STATUS_CACHE_UPDATED_EVENT = "ade:ai-status-cache-updated";

export type AiStatusCacheInvalidatedEventDetail = {
  projectRoot: string | null;
  allProjects: boolean;
};

export type AiStatusCacheUpdatedEventDetail = {
  projectRoot: string | null;
};

const aiStatusCache = new Map<string, StatusCacheEntry>();
const providerModelsCache = new Map<string, ModelsCacheEntry>();

function detailEvent<T>(type: string, detail: T): Event {
  if (typeof CustomEvent !== "undefined") {
    return new CustomEvent<T>(type, { detail });
  }
  const event = new Event(type);
  Object.defineProperty(event, "detail", { configurable: true, value: detail });
  return event;
}

function normalizeProjectRoot(projectRoot: string | null | undefined): string {
  return projectRoot?.trim() || "<no-project>";
}

function bindingCacheSuffix(pin: OpenProjectBinding | null | undefined): string {
  return pin?.key ? `::pin:${pin.key}` : "";
}

function statusCacheKey(
  projectRoot: string | null | undefined,
  pin?: OpenProjectBinding | null,
): string {
  return `${normalizeProjectRoot(projectRoot)}${bindingCacheSuffix(pin)}`;
}

function emitAiStatusCacheInvalidated(detail: AiStatusCacheInvalidatedEventDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(detailEvent(AI_STATUS_CACHE_INVALIDATED_EVENT, detail));
}

function emitAiStatusCacheUpdated(projectRoot: string | null | undefined): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(detailEvent<AiStatusCacheUpdatedEventDetail>(
    AI_STATUS_CACHE_UPDATED_EVENT,
    { projectRoot: projectRoot?.trim() || null },
  ));
}

function modelsCacheKey(
  projectRoot: string | null | undefined,
  provider: AgentChatProvider,
  activateRuntime: boolean,
  cursorSource?: "sdk" | "cli" | "all",
  pin?: OpenProjectBinding | null,
): string {
  return `${normalizeProjectRoot(projectRoot)}${bindingCacheSuffix(pin)}::${provider}::${activateRuntime ? "active" : "passive"}::${cursorSource ?? "all"}`;
}

/**
 * Synchronous peek at the most recent AI status for the `(projectRoot, pin)`
 * scope, regardless of TTL freshness. Returns `null` if nothing has ever been
 * cached for that project binding in the current session.
 *
 * Designed for renderer components that want to seed initial state without
 * flashing a "not configured" placeholder while the async re-check is in
 * flight. Callers are expected to re-verify via `getAiStatusCached` and
 * overwrite their state when the new value differs.
 */
export function peekAiStatusCached(
  projectRoot: string | null | undefined,
  pin?: OpenProjectBinding | null,
): AiSettingsStatus | null {
  const key = statusCacheKey(projectRoot, pin);
  return aiStatusCache.get(key)?.value ?? null;
}

export async function getAiStatusCached(args: {
  projectRoot: string | null | undefined;
  force?: boolean;
  ttlMs?: number;
  refreshOpenCodeInventory?: boolean;
  pin?: OpenProjectBinding | null;
}): Promise<AiSettingsStatus> {
  const key = statusCacheKey(args.projectRoot, args.pin);
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
  }, ...(args.pin ? [args.pin] as const : [])).then((status) => {
    const current = aiStatusCache.get(key);
    if (current?.inFlight === request) {
      aiStatusCache.set(key, {
        value: status,
        timestamp: Date.now(),
        inFlight: null,
        includesOpenCodeInventory: requiresOpenCodeInventory,
        inFlightIncludesOpenCodeInventory: false,
      });
      emitAiStatusCacheUpdated(args.projectRoot);
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
  activateRuntime?: boolean;
  cursorSource?: "sdk" | "cli" | "all";
  force?: boolean;
  ttlMs?: number;
  pin?: OpenProjectBinding | null;
}): Promise<AgentChatModelInfo[]> {
  const activateRuntime = args.activateRuntime === true;
  const key = modelsCacheKey(args.projectRoot, args.provider, activateRuntime, args.cursorSource, args.pin);
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
  request = window.ade.agentChat.models({
    provider: args.provider,
    ...(activateRuntime ? { activateRuntime: true } : {}),
    ...(args.cursorSource ? { cursorSource: args.cursorSource } : {}),
  }, ...(args.pin ? [args.pin] as const : [])).then((models) => {
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
    emitAiStatusCacheInvalidated({ projectRoot: null, allProjects: true });
    return;
  }

  const normalized = normalizeProjectRoot(projectRoot);
  for (const key of aiStatusCache.keys()) {
    if (key === normalized || key.startsWith(`${normalized}::pin:`)) {
      aiStatusCache.delete(key);
    }
  }
  for (const key of providerModelsCache.keys()) {
    if (key.startsWith(`${normalized}::`)) {
      providerModelsCache.delete(key);
    }
  }
  emitAiStatusCacheInvalidated({
    projectRoot: projectRoot.trim() || null,
    allProjects: false,
  });
}
