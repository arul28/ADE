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
type SessionListCacheScope = {
  projectRoot?: string | null;
  laneId?: string | null;
};

function normalizeArgs(args?: ListSessionsArgs): ListSessionsArgs {
  if (!args) return {};
  const normalized: ListSessionsArgs = {};
  if (typeof args.laneId === "string" && args.laneId.trim().length > 0) normalized.laneId = args.laneId.trim();
  if (typeof args.status === "string" && args.status.trim().length > 0) normalized.status = args.status;
  if (typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) normalized.limit = Math.floor(args.limit);
  if (Array.isArray(args.toolTypes)) {
    const toolTypes = Array.from(
      new Set(args.toolTypes.filter((toolType) => typeof toolType === "string" && toolType.trim().length > 0)),
    ).sort();
    if (toolTypes.length > 0) normalized.toolTypes = toolTypes;
  }
  return normalized;
}

function cacheKey(args?: ListSessionsArgs): string {
  const normalized = normalizeArgs(args);
  return JSON.stringify({
    projectRoot: useAppStore.getState().project?.rootPath?.trim() || null,
    laneId: normalized.laneId ?? null,
    status: normalized.status ?? null,
    toolTypes: normalized.toolTypes ?? null,
  });
}

function requestedLimit(args?: ListSessionsArgs): number | null {
  const normalized = normalizeArgs(args);
  return typeof normalized.limit === "number" && Number.isFinite(normalized.limit) && normalized.limit > 0
    ? normalized.limit
    : null;
}

function canSatisfyLimit(availableLimit: number | null, nextLimit: number | null): boolean {
  if (availableLimit == null) return true;
  if (nextLimit == null) return false;
  return availableLimit >= nextLimit;
}

function sliceRows(rows: TerminalSessionSummary[], limit: number | null): TerminalSessionSummary[] {
  if (limit == null || rows.length <= limit) return rows;
  return rows.slice(0, limit);
}

export async function listSessionsCached(
  args?: ListSessionsArgs,
  options?: { force?: boolean; ttlMs?: number; projectRoot?: string | null },
): Promise<TerminalSessionSummary[]> {
  const key = options?.projectRoot == null
    ? cacheKey(args)
    : (() => {
      const normalized = normalizeArgs(args);
      return JSON.stringify({
        projectRoot: options.projectRoot?.trim() || null,
        laneId: normalized.laneId ?? null,
        status: normalized.status ?? null,
        toolTypes: normalized.toolTypes ?? null,
      });
    })();
  const ttlMs = options?.ttlMs ?? DEFAULT_SESSION_LIST_TTL_MS;
  const limit = requestedLimit(args);
  const now = Date.now();
  const existing = cache.get(key);

  const force = options?.force === true;

  if (!force && existing?.value && now - existing.timestamp < ttlMs && canSatisfyLimit(existing.fetchedLimit, limit)) {
    return sliceRows(existing.value, limit);
  }
  if (existing?.inFlight && canSatisfyLimit(existing.inFlightLimit, limit)) {
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

export function invalidateSessionListCache(scope?: SessionListCacheScope): void {
  const projectRootFilter = scope
    ? scope.projectRoot === undefined ? undefined : scope.projectRoot?.trim() || null
    : undefined;
  const laneIdFilter = scope
    ? scope.laneId === undefined ? undefined : scope.laneId?.trim() || null
    : undefined;

  for (const [key, entry] of [...cache.entries()]) {
    let parsed: { projectRoot?: string | null; laneId?: string | null };
    try {
      parsed = JSON.parse(key) as { projectRoot?: string | null; laneId?: string | null };
    } catch {
      cache.delete(key);
      continue;
    }

    if (projectRootFilter !== undefined && parsed.projectRoot !== projectRootFilter) continue;
    if (laneIdFilter !== undefined && parsed.laneId !== laneIdFilter) continue;

    if (!entry.inFlight) {
      cache.delete(key);
      continue;
    }
    cache.set(key, {
      value: null,
      timestamp: 0,
      fetchedLimit: null,
      inFlight: entry.inFlight,
      inFlightLimit: entry.inFlightLimit,
    });
  }
}
