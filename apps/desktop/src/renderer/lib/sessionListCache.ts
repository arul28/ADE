import type { ListSessionsArgs, TerminalSessionSummary } from "../../shared/types";

type CacheEntry = {
  value: TerminalSessionSummary[] | null;
  timestamp: number;
  inFlight: Promise<TerminalSessionSummary[]> | null;
};

const DEFAULT_SESSION_LIST_TTL_MS = 900;
const cache = new Map<string, CacheEntry>();

function normalizeArgs(args?: ListSessionsArgs): ListSessionsArgs {
  if (!args) return {};
  const normalized: ListSessionsArgs = {};
  if (typeof args.laneId === "string" && args.laneId.trim().length > 0) normalized.laneId = args.laneId.trim();
  if (typeof args.status === "string" && args.status.trim().length > 0) normalized.status = args.status;
  if (typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) normalized.limit = Math.floor(args.limit);
  return normalized;
}

function cacheKey(args?: ListSessionsArgs): string {
  const normalized = normalizeArgs(args);
  return JSON.stringify({
    laneId: normalized.laneId ?? null,
    status: normalized.status ?? null,
    limit: normalized.limit ?? null,
  });
}

export async function listSessionsCached(
  args?: ListSessionsArgs,
  options?: { force?: boolean; ttlMs?: number },
): Promise<TerminalSessionSummary[]> {
  const key = cacheKey(args);
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_LIST_TTL_MS;
  const now = Date.now();
  const existing = cache.get(key);

  if (!options?.force && existing?.value && now - existing.timestamp < ttlMs) {
    return existing.value;
  }
  if (!options?.force && existing?.inFlight) {
    return existing.inFlight;
  }

  const request = window.ade.sessions.list(normalizeArgs(args)).then((rows) => {
    cache.set(key, {
      value: rows,
      timestamp: Date.now(),
      inFlight: null,
    });
    return rows;
  }).catch((error) => {
    const current = cache.get(key);
    if (current?.inFlight) {
      cache.set(key, {
        value: current.value,
        timestamp: current.timestamp,
        inFlight: null,
      });
    }
    throw error;
  });

  cache.set(key, {
    value: existing?.value ?? null,
    timestamp: existing?.timestamp ?? 0,
    inFlight: request,
  });

  return request;
}

export function invalidateSessionListCache(): void {
  cache.clear();
}
