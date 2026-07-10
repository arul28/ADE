import type {
  AgentChatListArgs,
  AgentChatSessionSummary,
} from "../../shared/types";
import { selectActiveProjectRoot, useAppStore } from "../state/appStore";

type CacheEntry = {
  value?: AgentChatSessionSummary[];
  promise?: Promise<AgentChatSessionSummary[]>;
  expiresAt: number;
};

const DEFAULT_TTL_MS = 1_500;
const chatSessionListCache = new Map<string, CacheEntry>();

function normalizeArgs(args?: AgentChatListArgs): AgentChatListArgs {
  const normalized: AgentChatListArgs = {};
  if (args?.laneId?.trim()) normalized.laneId = args.laneId.trim();
  if (typeof args?.includeAutomation === "boolean") normalized.includeAutomation = args.includeAutomation;
  if (typeof args?.includeArchived === "boolean") normalized.includeArchived = args.includeArchived;
  return normalized;
}

function activeProjectRoot(): string | null {
  return selectActiveProjectRoot(useAppStore.getState());
}

function cacheKey(args?: AgentChatListArgs): string {
  const normalized = normalizeArgs(args);
  return JSON.stringify({
    projectRoot: activeProjectRoot(),
    laneId: normalized.laneId ?? null,
    includeAutomation: normalized.includeAutomation ?? null,
    includeArchived: normalized.includeArchived ?? null,
  });
}

export async function listAgentChatSessionsCached(
  args?: AgentChatListArgs,
  options?: { force?: boolean; ttlMs?: number },
): Promise<AgentChatSessionSummary[]> {
  const key = cacheKey(args);
  const now = Date.now();
  const ttlMs = options?.ttlMs ?? DEFAULT_TTL_MS;
  const cached = chatSessionListCache.get(key);

  if (!options?.force && cached?.promise) return cached.promise;
  if (!options?.force && cached?.value !== undefined && cached.expiresAt > now) {
    return cached.value;
  }

  const normalized = normalizeArgs(args);
  const promise = window.ade.agentChat.list(normalized).then((value) => {
    const current = chatSessionListCache.get(key);
    if (current?.promise === promise) {
      chatSessionListCache.set(key, {
        value,
        expiresAt: Date.now() + ttlMs,
      });
    }
    return value;
  }).catch((error) => {
    const current = chatSessionListCache.get(key);
    if (current?.promise === promise) chatSessionListCache.delete(key);
    throw error;
  });

  chatSessionListCache.set(key, {
    promise,
    expiresAt: now + ttlMs,
  });
  return promise;
}

export function invalidateAgentChatSessionListCache(scope?: {
  projectRoot?: string | null;
  laneId?: string | null;
}): void {
  if (!scope) {
    chatSessionListCache.clear();
    return;
  }

  const projectRootFilter = scope.projectRoot === undefined ? undefined : scope.projectRoot?.trim() || null;
  const laneIdFilter = scope.laneId === undefined ? undefined : scope.laneId?.trim() || null;
  for (const key of [...chatSessionListCache.keys()]) {
    let parsed: { projectRoot?: string | null; laneId?: string | null };
    try {
      parsed = JSON.parse(key) as { projectRoot?: string | null; laneId?: string | null };
    } catch {
      chatSessionListCache.delete(key);
      continue;
    }
    if (projectRootFilter !== undefined && parsed.projectRoot !== projectRootFilter) continue;
    if (laneIdFilter !== undefined && parsed.laneId !== laneIdFilter) continue;
    chatSessionListCache.delete(key);
  }
}
