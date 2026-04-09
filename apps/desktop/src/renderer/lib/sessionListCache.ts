import type { ListSessionsArgs, TerminalSessionSummary } from "../../shared/types";
import { useAppStore } from "../state/appStore";

type CacheEntry = {
  value: TerminalSessionSummary[] | null;
  timestamp: number;
  fetchedLimit: number | null;
  inFlight: Promise<TerminalSessionSummary[]> | null;
  inFlightLimit: number | null;
};

const DEFAULT_SESSION_LIST_TTL_MS = 1_500;
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
    projectRoot: useAppStore.getState().project?.rootPath?.trim() || null,
    laneId: normalized.laneId ?? null,
    status: normalized.status ?? null,
  });
}

function requestedLimit(args?: ListSessionsArgs): number | null {
  const normalized = normalizeArgs(args);
  return typeof normalized.limit === "number" && Number.isFinite(normalized.limit) && normalized.limit > 0
    ? normalized.limit
    : null;
}

function canSatisfyLimit(availableLimit: number | null, nextLimit: number | null): boolean {
  if (nextLimit == null) return availableLimit == null;
  return availableLimit != null && availableLimit >= nextLimit;
}

function sliceRows(rows: TerminalSessionSummary[], limit: number | null): TerminalSessionSummary[] {
  if (limit == null || rows.length <= limit) return rows;
  return rows.slice(0, limit);
}

export async function listSessionsCached(
  args?: ListSessionsArgs,
  options?: { force?: boolean; ttlMs?: number },
): Promise<TerminalSessionSummary[]> {
  const key = cacheKey(args);
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_LIST_TTL_MS;
  const limit = requestedLimit(args);
  const now = Date.now();
  const existing = cache.get(key);

  if (!options?.force && existing?.value && now - existing.timestamp < ttlMs && canSatisfyLimit(existing.fetchedLimit, limit)) {
    return sliceRows(existing.value, limit);
  }
  if (!options?.force && existing?.inFlight && canSatisfyLimit(existing.inFlightLimit, limit)) {
    return existing.inFlight.then((rows) => sliceRows(rows, limit));
  }

  let request: Promise<TerminalSessionSummary[]> | null = null;
  request = window.ade.sessions.list(normalizeArgs(args)).then((rows) => {
    const current = cache.get(key);
    if (current?.inFlight === request) {
      cache.set(key, {
        value: rows,
        timestamp: Date.now(),
        fetchedLimit: limit,
        inFlight: null,
        inFlightLimit: null,
      });
    }
    return rows;
  }).catch((error) => {
    const current = cache.get(key);
    if (current?.inFlight === request) {
      cache.set(key, {
        value: current.value,
        timestamp: current.timestamp,
        fetchedLimit: current.fetchedLimit,
        inFlight: null,
        inFlightLimit: null,
      });
    }
    throw error;
  });

  cache.set(key, {
    value: existing?.value ?? null,
    timestamp: existing?.timestamp ?? 0,
    fetchedLimit: existing?.fetchedLimit ?? null,
    inFlight: request,
    inFlightLimit: limit,
  });

  return request.then((rows) => sliceRows(rows, limit));
}

export function invalidateSessionListCache(): void {
  cache.clear();
}
