import { randomUUID } from "node:crypto";
import type { MemoryLifecycleSweepResult, MemorySweepStatusEventPayload, MemorySweepTrigger } from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { AdeDb } from "../state/kvDb";

type SupportedScope = "project" | "agent" | "mission";

type ScopeLimits = Record<SupportedScope, number>;

type CreateMemoryLifecycleServiceOpts = {
  db: AdeDb;
  logger: Pick<Logger, "info" | "warn" | "error">;
  projectId: string;
  halfLifeDays?: number;
  staleAfterHours?: number;
  limits?: Partial<ScopeLimits>;
  now?: () => Date;
  onStatus?: (event: MemorySweepStatusEventPayload) => void;
};

type MemoryDecayRow = {
  id: string;
  access_score: number | null;
  last_accessed_at: string | null;
  tier: number | null;
  pinned: number | null;
  category: string | null;
  importance: string | null;
};

type MemoryIdRow = {
  id: string;
};

const DEFAULT_HALF_LIFE_DAYS = 30;
const DEFAULT_STALE_AFTER_HOURS = 24;
const DEFAULT_SCOPE_LIMITS: ScopeLimits = {
  project: 2000,
  agent: 500,
  mission: 200,
};

const EVERGREEN_CATEGORIES = new Set(["preference", "convention"]);
const UPDATE_CHUNK_SIZE = 250;
const DAY_MS = 24 * 60 * 60 * 1000;

function clampToNonNegative(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return value;
}

function normalizeHalfLifeDays(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_HALF_LIFE_DAYS;
}

function normalizeStaleAfterHours(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : DEFAULT_STALE_AFTER_HOURS;
}

function normalizeScopeLimits(limits?: Partial<ScopeLimits>): ScopeLimits {
  return {
    project: typeof limits?.project === "number" && Number.isFinite(limits.project) && limits.project > 0
      ? Math.floor(limits.project)
      : DEFAULT_SCOPE_LIMITS.project,
    agent: typeof limits?.agent === "number" && Number.isFinite(limits.agent) && limits.agent > 0
      ? Math.floor(limits.agent)
      : DEFAULT_SCOPE_LIMITS.agent,
    mission: typeof limits?.mission === "number" && Number.isFinite(limits.mission) && limits.mission > 0
      ? Math.floor(limits.mission)
      : DEFAULT_SCOPE_LIMITS.mission,
  };
}

function computeAgeDays(referenceMs: number, value: string | null | undefined): number {
  const parsed = Date.parse(String(value ?? ""));
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, referenceMs - parsed) / DAY_MS;
}

function isEvergreen(category: string | null | undefined, importance: string | null | undefined): boolean {
  return EVERGREEN_CATEGORIES.has(String(category ?? "").trim().toLowerCase())
    && String(importance ?? "").trim().toLowerCase() === "high";
}

function chunk<T>(values: readonly T[], chunkSize: number): T[][] {
  if (values.length === 0) return [];
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    out.push(values.slice(index, index + chunkSize));
  }
  return out;
}

function normalizeScope(raw: string | null | undefined): SupportedScope | null {
  if (raw === "project" || raw === "agent" || raw === "mission") return raw;
  return null;
}

function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export type MemoryLifecycleService = ReturnType<typeof createMemoryLifecycleService>;

export function createMemoryLifecycleService(opts: CreateMemoryLifecycleServiceOpts) {
  const {
    db,
    logger,
    projectId,
    now = () => new Date(),
    onStatus,
  } = opts;

  const halfLifeDays = normalizeHalfLifeDays(opts.halfLifeDays);
  const staleAfterHours = normalizeStaleAfterHours(opts.staleAfterHours);
  const scopeLimits = normalizeScopeLimits(opts.limits);

  let activeSweep: Promise<MemoryLifecycleSweepResult> | null = null;

  function emitStatus(event: MemorySweepStatusEventPayload) {
    if (!onStatus) return;
    try {
      onStatus(event);
    } catch (error) {
      logger.warn("memory.lifecycle.status_emit_failed", {
        projectId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function selectIds(sql: string, params: Array<string | number | null>): string[] {
    return db
      .all<MemoryIdRow>(sql, params)
      .map((row) => String(row.id ?? "").trim())
      .filter(Boolean);
  }

  function updateIds(sqlPrefix: string, paramsBeforeIds: Array<string | number | null>, ids: readonly string[]) {
    for (const batch of chunk(ids, UPDATE_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      db.run(`${sqlPrefix} (${placeholders})`, [...paramsBeforeIds, ...batch]);
    }
  }

  function archiveIds(ids: readonly string[], timestamp: string) {
    if (ids.length === 0) return;
    updateIds(
      `
        UPDATE unified_memories
        SET status = 'archived',
            tier = 3,
            pinned = 0,
            updated_at = ?
        WHERE id IN
      `,
      [timestamp],
      ids,
    );
  }

  async function runSweep({ reason = "manual" as MemorySweepTrigger }: { reason?: MemorySweepTrigger } = {}) {
    if (activeSweep) return activeSweep;

    activeSweep = (async () => {
      const startedAt = now().toISOString();
      const startedMs = now().getTime();
      const sweepId = randomUUID();
      const decayedIds = new Set<string>();
      const demotedIds = new Set<string>();
      const promotedIds = new Set<string>();
      const archivedIds = new Set<string>();
      const orphanedIds = new Set<string>();

      emitStatus({
        type: "memory-sweep-started",
        projectId,
        reason,
        sweepId,
        startedAt,
      });

      logger.info("memory.lifecycle.sweep_started", { projectId, sweepId, reason, halfLifeDays });

      try {
        const decayRows = db.all<MemoryDecayRow>(
          `
            SELECT id, access_score, last_accessed_at, tier, pinned, category, importance
            FROM unified_memories
            WHERE project_id = ?
              AND status != 'archived'
          `,
          [projectId],
        );

        for (const row of decayRows) {
          const id = String(row.id ?? "").trim();
          if (!id) continue;
          if (Number(row.pinned ?? 0) === 1 || Number(row.tier ?? 0) === 1) continue;
          if (isEvergreen(row.category, row.importance)) continue;

          const currentScore = clampToNonNegative(Number(row.access_score ?? 0));
          const daysSinceAccess = computeAgeDays(startedMs, row.last_accessed_at);
          if (currentScore <= 0 || daysSinceAccess <= 0) continue;

          const nextScore = currentScore * Math.pow(0.5, daysSinceAccess / halfLifeDays);
          if (!Number.isFinite(nextScore) || Math.abs(nextScore - currentScore) < 1e-9) continue;

          db.run(
            `
              UPDATE unified_memories
              SET access_score = ?,
                  updated_at = ?
              WHERE id = ?
            `,
            [nextScore, startedAt, id],
          );
          decayedIds.add(id);
        }

        await nextTick();

        const demotionCutoff = new Date(startedMs - 90 * DAY_MS).toISOString();
        const demotionIds = selectIds(
          `
            SELECT id
            FROM unified_memories
            WHERE project_id = ?
              AND status != 'archived'
              AND tier = 2
              AND pinned = 0
              AND last_accessed_at < ?
          `,
          [projectId, demotionCutoff],
        );
        if (demotionIds.length > 0) {
          updateIds(
            `
              UPDATE unified_memories
              SET tier = 3,
                  updated_at = ?
              WHERE id IN
            `,
            [startedAt],
            demotionIds,
          );
          for (const id of demotionIds) demotedIds.add(id);
        }

        await nextTick();

        const promotionIds = selectIds(
          `
            SELECT id
            FROM unified_memories
            WHERE project_id = ?
              AND status = 'candidate'
              AND (
                (confidence >= 0.7 AND observation_count >= 2)
                OR (confidence >= 0.6 AND source_type = 'system')
              )
          `,
          [projectId],
        );
        if (promotionIds.length > 0) {
          updateIds(
            `
              UPDATE unified_memories
              SET status = 'promoted',
                  tier = CASE WHEN pinned = 1 THEN 1 ELSE 2 END,
                  promoted_at = COALESCE(promoted_at, ?),
                  updated_at = ?
              WHERE id IN
            `,
            [startedAt, startedAt],
            promotionIds,
          );
          for (const id of promotionIds) promotedIds.add(id);
        }

        await nextTick();

        const candidateArchiveCutoff = new Date(startedMs - 30 * DAY_MS).toISOString();
        const candidateArchiveIds = selectIds(
          `
            SELECT id
            FROM unified_memories
            WHERE project_id = ?
              AND status = 'candidate'
              AND confidence < 0.3
              AND created_at < ?
          `,
          [projectId, candidateArchiveCutoff],
        );
        if (candidateArchiveIds.length > 0) {
          archiveIds(candidateArchiveIds, startedAt);
          for (const id of candidateArchiveIds) archivedIds.add(id);
        }

        await nextTick();

        const orphanIds = selectIds(
          `
            SELECT memory.id
            FROM unified_memories memory
            LEFT JOIN orchestrator_runs runs
              ON runs.id = memory.scope_owner_id
            WHERE memory.project_id = ?
              AND memory.scope = 'mission'
              AND memory.status != 'archived'
              AND COALESCE(memory.scope_owner_id, '') != ''
              AND runs.id IS NULL
          `,
          [projectId],
        );
        if (orphanIds.length > 0) {
          archiveIds(orphanIds, startedAt);
          for (const id of orphanIds) {
            archivedIds.add(id);
            orphanedIds.add(id);
          }
        }

        await nextTick();

        const staleTier3Cutoff = new Date(startedMs - 180 * DAY_MS).toISOString();
        const staleTier3Ids = selectIds(
          `
            SELECT id
            FROM unified_memories
            WHERE project_id = ?
              AND status != 'archived'
              AND tier = 3
              AND last_accessed_at < ?
          `,
          [projectId, staleTier3Cutoff],
        );
        if (staleTier3Ids.length > 0) {
          archiveIds(staleTier3Ids, startedAt);
          for (const id of staleTier3Ids) archivedIds.add(id);
        }

        await nextTick();

        const scopeCounts = db.all<{ scope: string | null; scope_owner_id: string | null; entry_count: number | null }>(
          `
            SELECT scope, COALESCE(scope_owner_id, '') AS scope_owner_id, COUNT(*) AS entry_count
            FROM unified_memories
            WHERE project_id = ?
              AND status != 'archived'
            GROUP BY scope, COALESCE(scope_owner_id, '')
          `,
          [projectId],
        );

        for (const row of scopeCounts) {
          const scope = normalizeScope(row.scope);
          if (!scope) continue;

          const limit = scopeLimits[scope];
          const entryCount = Math.max(0, Number(row.entry_count ?? 0));
          if (entryCount <= limit) continue;

          const scopeOwnerId = String(row.scope_owner_id ?? "");
          const overLimitBy = entryCount - limit;
          const idsToArchive = selectIds(
            `
              SELECT id
              FROM unified_memories
              WHERE project_id = ?
                AND scope = ?
                AND COALESCE(scope_owner_id, '') = ?
                AND status != 'archived'
                AND tier = 3
              ORDER BY access_score ASC, last_accessed_at ASC, created_at ASC, id ASC
              LIMIT ?
            `,
            [projectId, scope, scopeOwnerId, overLimitBy],
          );
          if (idsToArchive.length === 0) continue;

          archiveIds(idsToArchive, startedAt);
          for (const id of idsToArchive) archivedIds.add(id);
        }

        await nextTick();

        const completedAt = now().toISOString();
        const durationMs = Math.max(0, now().getTime() - startedMs);
        db.run(
          `
            INSERT INTO memory_sweep_log (
              sweep_id,
              project_id,
              trigger_reason,
              started_at,
              completed_at,
              entries_decayed,
              entries_demoted,
              entries_promoted,
              entries_archived,
              entries_orphaned,
              duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            sweepId,
            projectId,
            reason,
            startedAt,
            completedAt,
            decayedIds.size,
            demotedIds.size,
            promotedIds.size,
            archivedIds.size,
            orphanedIds.size,
            durationMs,
          ],
        );

        const result: MemoryLifecycleSweepResult = {
          sweepId,
          projectId,
          reason,
          startedAt,
          completedAt,
          halfLifeDays,
          entriesDecayed: decayedIds.size,
          entriesDemoted: demotedIds.size,
          entriesPromoted: promotedIds.size,
          entriesArchived: archivedIds.size,
          entriesOrphaned: orphanedIds.size,
          durationMs,
        };

        logger.info("memory.lifecycle.sweep_completed", result);
        emitStatus({
          type: "memory-sweep-completed",
          projectId,
          reason,
          sweepId,
          startedAt,
          completedAt,
          result,
        });

        return result;
      } catch (error) {
        const completedAt = now().toISOString();
        const durationMs = Math.max(0, now().getTime() - startedMs);
        const message = error instanceof Error ? error.message : String(error);
        logger.error("memory.lifecycle.sweep_failed", {
          projectId,
          sweepId,
          reason,
          durationMs,
          error: message,
        });
        emitStatus({
          type: "memory-sweep-failed",
          projectId,
          reason,
          sweepId,
          startedAt,
          completedAt,
          durationMs,
          error: message,
        });
        throw error;
      }
    })().finally(() => {
      activeSweep = null;
    });

    return activeSweep;
  }

  async function runStartupSweepIfDue(): Promise<MemoryLifecycleSweepResult | null> {
    const row = db.get<{ completed_at?: string | null; started_at?: string | null }>(
      `
        SELECT completed_at, started_at
        FROM memory_sweep_log
        WHERE project_id = ?
        ORDER BY COALESCE(completed_at, started_at) DESC
        LIMIT 1
      `,
      [projectId],
    );

    const lastSweepAt = String(row?.completed_at ?? row?.started_at ?? "").trim();
    if (!lastSweepAt) {
      return runSweep({ reason: "startup" });
    }

    const parsed = Date.parse(lastSweepAt);
    if (!Number.isFinite(parsed)) {
      return runSweep({ reason: "startup" });
    }

    const ageMs = now().getTime() - parsed;
    if (ageMs >= staleAfterHours * 60 * 60 * 1000) {
      return runSweep({ reason: "startup" });
    }

    return null;
  }

  return {
    runSweep,
    runStartupSweepIfDue,
  };
}
