import type { CodexLaneThreadBinding } from "../../../shared/types";
import type { AdeDb } from "../state/kvDb";

const STORE_KEY = "codex:lane-thread-bindings:v1";

type StoredMap = Record<string, CodexLaneThreadBinding>;

function normalizeRecentIds(ids: unknown, maxRecent: number): string[] {
  if (!Array.isArray(ids)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== "string") continue;
    const threadId = raw.trim();
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    out.push(threadId);
    if (out.length >= maxRecent) break;
  }
  return out;
}

function sanitizeBinding(input: unknown, laneId: string, maxRecent: number): CodexLaneThreadBinding {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {
      laneId,
      defaultThreadId: null,
      recentThreadIds: [],
      updatedAt: null
    };
  }

  const row = input as Record<string, unknown>;
  const defaultThreadId = typeof row.defaultThreadId === "string" && row.defaultThreadId.trim().length ? row.defaultThreadId.trim() : null;
  return {
    laneId,
    defaultThreadId,
    recentThreadIds: normalizeRecentIds(row.recentThreadIds, maxRecent),
    updatedAt: typeof row.updatedAt === "string" ? row.updatedAt : null
  };
}

function sanitizeMap(raw: unknown, maxRecent: number): StoredMap {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StoredMap = {};
  const record = raw as Record<string, unknown>;
  for (const [laneIdRaw, bindingRaw] of Object.entries(record)) {
    const laneId = laneIdRaw.trim();
    if (!laneId) continue;
    out[laneId] = sanitizeBinding(bindingRaw, laneId, maxRecent);
  }
  return out;
}

export function createCodexLaneThreadStore({
  db,
  maxRecentPerLane = 25
}: {
  db: AdeDb;
  maxRecentPerLane?: number;
}) {
  const read = (): StoredMap => sanitizeMap(db.getJson<StoredMap>(STORE_KEY), maxRecentPerLane);

  const write = (map: StoredMap) => {
    db.setJson(STORE_KEY, map);
  };

  const getLaneBinding = (laneId: string): CodexLaneThreadBinding => {
    const normalizedLaneId = laneId.trim();
    if (!normalizedLaneId) {
      return {
        laneId: "",
        defaultThreadId: null,
        recentThreadIds: [],
        updatedAt: null
      };
    }
    const map = read();
    return map[normalizedLaneId] ?? {
      laneId: normalizedLaneId,
      defaultThreadId: null,
      recentThreadIds: [],
      updatedAt: null
    };
  };

  const patchLane = (laneId: string, patch: Partial<CodexLaneThreadBinding>) => {
    const normalizedLaneId = laneId.trim();
    if (!normalizedLaneId) return;
    const map = read();
    const current = map[normalizedLaneId] ?? {
      laneId: normalizedLaneId,
      defaultThreadId: null,
      recentThreadIds: [],
      updatedAt: null
    };
    const next: CodexLaneThreadBinding = {
      laneId: normalizedLaneId,
      defaultThreadId:
        patch.defaultThreadId !== undefined
          ? (patch.defaultThreadId?.trim() || null)
          : current.defaultThreadId,
      recentThreadIds:
        patch.recentThreadIds !== undefined
          ? normalizeRecentIds(patch.recentThreadIds, maxRecentPerLane)
          : current.recentThreadIds,
      updatedAt: patch.updatedAt !== undefined ? patch.updatedAt ?? null : current.updatedAt
    };
    map[normalizedLaneId] = next;
    write(map);
  };

  const rememberThread = (laneId: string, threadId: string, options?: { setDefault?: boolean }) => {
    const normalizedLaneId = laneId.trim();
    const normalizedThreadId = threadId.trim();
    if (!normalizedLaneId || !normalizedThreadId) return;
    const now = new Date().toISOString();
    const current = getLaneBinding(normalizedLaneId);
    const deduped = [normalizedThreadId, ...current.recentThreadIds.filter((id) => id !== normalizedThreadId)].slice(
      0,
      maxRecentPerLane
    );
    patchLane(normalizedLaneId, {
      recentThreadIds: deduped,
      defaultThreadId: options?.setDefault ? normalizedThreadId : current.defaultThreadId,
      updatedAt: now
    });
  };

  const forgetThread = (laneId: string, threadId: string) => {
    const normalizedLaneId = laneId.trim();
    const normalizedThreadId = threadId.trim();
    if (!normalizedLaneId || !normalizedThreadId) return;
    const current = getLaneBinding(normalizedLaneId);
    if (!current.recentThreadIds.includes(normalizedThreadId) && current.defaultThreadId !== normalizedThreadId) return;
    patchLane(normalizedLaneId, {
      defaultThreadId: current.defaultThreadId === normalizedThreadId ? null : current.defaultThreadId,
      recentThreadIds: current.recentThreadIds.filter((id) => id !== normalizedThreadId),
      updatedAt: new Date().toISOString()
    });
  };

  return {
    getAll(): StoredMap {
      return read();
    },

    getLaneBinding,

    setDefaultThread(laneId: string, threadId: string | null) {
      const normalizedLaneId = laneId.trim();
      if (!normalizedLaneId) return;
      const now = new Date().toISOString();
      const current = getLaneBinding(normalizedLaneId);
      const normalizedThreadId = threadId?.trim() || null;
      const recentThreadIds = normalizedThreadId
        ? [normalizedThreadId, ...current.recentThreadIds.filter((id) => id !== normalizedThreadId)].slice(
            0,
            maxRecentPerLane
          )
        : current.recentThreadIds;
      patchLane(normalizedLaneId, {
        defaultThreadId: normalizedThreadId,
        recentThreadIds,
        updatedAt: now
      });
    },

    rememberThread,

    forgetThread,

    findLaneForThread(threadId: string): string | null {
      const normalizedThreadId = threadId.trim();
      if (!normalizedThreadId) return null;
      const all = read();
      for (const [laneId, binding] of Object.entries(all)) {
        if (binding.defaultThreadId === normalizedThreadId) return laneId;
        if (binding.recentThreadIds.includes(normalizedThreadId)) return laneId;
      }
      return null;
    }
  };
}
