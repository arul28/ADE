import { randomUUID } from "node:crypto";
import type {
  MemoryConsolidationResult,
  MemoryConsolidationStatusEventPayload,
  MemoryConsolidationTrigger,
} from "../../../shared/types";
import type { Logger } from "../logging/logger";
import type { createAiIntegrationService } from "../ai/aiIntegrationService";
import type { createProjectConfigService } from "../config/projectConfigService";
import type { AdeDb } from "../state/kvDb";
import { isRecord } from "../shared/utils";

type SupportedScope = "project" | "agent" | "mission";
type ScopeLimits = Record<SupportedScope, number>;

type ConsolidationTarget = {
  scope: SupportedScope;
  scopeOwnerId: string | null;
};

type CreateBatchConsolidationServiceOpts = {
  db: AdeDb;
  logger: Pick<Logger, "info" | "warn" | "error">;
  aiIntegrationService: Pick<ReturnType<typeof createAiIntegrationService>, "executeTask">;
  projectConfigService: Pick<ReturnType<typeof createProjectConfigService>, "get">;
  projectId: string;
  projectRoot: string;
  limits?: Partial<ScopeLimits>;
  similarityThreshold?: number;
  autoCheckDebounceMs?: number;
  now?: () => Date;
  onStatus?: (event: MemoryConsolidationStatusEventPayload) => void;
  /** Called after a merged memory is inserted so it can be queued for embedding. */
  onMemoryInserted?: (memoryId: string) => void;
};

type MemoryCandidateRow = {
  id: string;
  scope: SupportedScope;
  scope_owner_id: string | null;
  category: string | null;
  content: string | null;
  importance: string | null;
  confidence: number | null;
  observation_count: number | null;
};

type BucketedMemoryRow = {
  id: string;
  scope: SupportedScope;
  scopeOwnerId: string | null;
  category: string;
  content: string;
  importance: "low" | "medium" | "high";
  confidence: number;
  observationCount: number;
};

type MemoryCluster = {
  scope: SupportedScope;
  scopeOwnerId: string | null;
  category: string;
  entries: BucketedMemoryRow[];
};

const DEFAULT_SCOPE_LIMITS: ScopeLimits = {
  project: 2000,
  agent: 500,
  mission: 200,
};

const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_AUTO_CHECK_DEBOUNCE_MS = 250;
const UPDATE_CHUNK_SIZE = 250;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
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

function normalizeImportance(value: string | null | undefined): "low" | "medium" | "high" {
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function importanceRank(value: "low" | "medium" | "high"): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}

function resolveHighestImportance(entries: readonly BucketedMemoryRow[]): "low" | "medium" | "high" {
  return entries.reduce<"low" | "medium" | "high">((best, entry) => {
    return importanceRank(entry.importance) > importanceRank(best) ? entry.importance : best;
  }, "low");
}

function seedAccessScore(importance: "low" | "medium" | "high", confidence: number): number {
  const importanceScore = importance === "high" ? 1 : importance === "medium" ? 0.6 : 0.3;
  return clamp01(Math.max(importanceScore, confidence));
}

function normalizeForSimilarity(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForDedupe(value: string): string {
  return normalizeForSimilarity(value);
}

function buildTrigramSet(value: string): Set<string> {
  const normalized = normalizeForSimilarity(value);
  if (!normalized.length) return new Set();
  if (normalized.length < 3) return new Set([normalized]);

  const trigrams = new Set<string>();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return trigrams;
}

export function computeJaccardTrigramSimilarity(left: string, right: string): number {
  const leftSet = buildTrigramSet(left);
  const rightSet = buildTrigramSet(right);
  if (leftSet.size === 0 || rightSet.size === 0) return 0;

  let intersection = 0;
  for (const trigram of leftSet) {
    if (rightSet.has(trigram)) intersection += 1;
  }

  const union = leftSet.size + rightSet.size - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function buildClusters(entries: readonly BucketedMemoryRow[], similarityThreshold: number): MemoryCluster[] {
  if (entries.length < 2) return [];

  const parent = entries.map((_, index) => index);
  const find = (index: number): number => {
    let cursor = index;
    while (parent[cursor] !== cursor) {
      parent[cursor] = parent[parent[cursor]]!;
      cursor = parent[cursor]!;
    }
    return cursor;
  };
  const union = (leftIndex: number, rightIndex: number) => {
    const leftRoot = find(leftIndex);
    const rightRoot = find(rightIndex);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };

  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      const similarity = computeJaccardTrigramSimilarity(entries[leftIndex]!.content, entries[rightIndex]!.content);
      if (similarity > similarityThreshold) {
        union(leftIndex, rightIndex);
      }
    }
  }

  const grouped = new Map<number, BucketedMemoryRow[]>();
  for (let index = 0; index < entries.length; index += 1) {
    const root = find(index);
    const bucket = grouped.get(root) ?? [];
    bucket.push(entries[index]!);
    grouped.set(root, bucket);
  }

  const clusters: MemoryCluster[] = [];
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const first = group[0]!;
    clusters.push({
      scope: first.scope,
      scopeOwnerId: first.scopeOwnerId,
      category: first.category,
      entries: group,
    });
  }

  return clusters.sort((left, right) => right.entries.length - left.entries.length);
}

function chunk<T>(values: readonly T[], chunkSize: number): T[][] {
  if (values.length === 0) return [];
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    batches.push(values.slice(index, index + chunkSize));
  }
  return batches;
}

function readMergedContent(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (isRecord(value) && typeof value.content === "string" && value.content.trim().length > 0) {
    return value.content.trim();
  }
  return null;
}

export type BatchConsolidationService = ReturnType<typeof createBatchConsolidationService>;

export function createBatchConsolidationService(opts: CreateBatchConsolidationServiceOpts) {
  const {
    db,
    logger,
    aiIntegrationService,
    projectConfigService,
    projectId,
    projectRoot,
    now = () => new Date(),
    onStatus,
  } = opts;

  const scopeLimits = normalizeScopeLimits(opts.limits);
  const similarityThreshold = typeof opts.similarityThreshold === "number" && Number.isFinite(opts.similarityThreshold)
    ? opts.similarityThreshold
    : DEFAULT_SIMILARITY_THRESHOLD;
  const autoCheckDebounceMs = typeof opts.autoCheckDebounceMs === "number" && Number.isFinite(opts.autoCheckDebounceMs) && opts.autoCheckDebounceMs >= 0
    ? opts.autoCheckDebounceMs
    : DEFAULT_AUTO_CHECK_DEBOUNCE_MS;

  let activeRun: Promise<MemoryConsolidationResult> | null = null;
  let pendingAutoCheck: ReturnType<typeof setTimeout> | null = null;

  function emitStatus(event: MemoryConsolidationStatusEventPayload) {
    if (!onStatus) return;
    try {
      onStatus(event);
    } catch (error) {
      logger.warn("memory.consolidation.status_emit_failed", {
        projectId,
        eventType: event.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function resolveOverrideModel(): string | undefined {
    const snapshot = projectConfigService.get();
    const aiConfig = isRecord(snapshot?.effective?.ai) ? snapshot.effective.ai : null;
    const featureOverrides = aiConfig && isRecord(aiConfig.featureModelOverrides)
      ? aiConfig.featureModelOverrides
      : null;
    const raw = featureOverrides && typeof featureOverrides.memory_consolidation === "string"
      ? featureOverrides.memory_consolidation.trim()
      : "";
    return raw.length > 0 ? raw : undefined;
  }

  function listEligibleEntries(targets?: readonly ConsolidationTarget[]): BucketedMemoryRow[] {
    const targetKeys = targets
      ? new Set(targets.map((target) => `${target.scope}::${target.scopeOwnerId ?? ""}`))
      : null;

    const rows = db.all<MemoryCandidateRow>(
      `
        SELECT id, scope, COALESCE(scope_owner_id, '') AS scope_owner_id, category, content, importance, confidence, observation_count
        FROM unified_memories
        WHERE project_id = ?
          AND status != 'archived'
          AND COALESCE(pinned, 0) = 0
          AND COALESCE(tier, 0) != 1
      `,
      [projectId],
    );

    return rows
      .map((row) => ({
        id: String(row.id ?? "").trim(),
        scope: row.scope,
        scopeOwnerId: row.scope === "project" ? null : String(row.scope_owner_id ?? "").trim() || null,
        category: String(row.category ?? "").trim(),
        content: String(row.content ?? "").trim(),
        importance: normalizeImportance(row.importance),
        confidence: clamp01(Number(row.confidence ?? 0)),
        observationCount: Math.max(1, Number(row.observation_count ?? 1)),
      }))
      .filter((row) => row.id.length > 0 && row.category.length > 0 && row.content.length > 0)
      .filter((row) => (targetKeys ? targetKeys.has(`${row.scope}::${row.scopeOwnerId ?? ""}`) : true));
  }

  function detectClusters(targets?: readonly ConsolidationTarget[]): MemoryCluster[] {
    const entries = listEligibleEntries(targets);
    const grouped = new Map<string, BucketedMemoryRow[]>();
    for (const entry of entries) {
      const key = `${entry.scope}::${entry.scopeOwnerId ?? ""}::${entry.category}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(entry);
      grouped.set(key, bucket);
    }

    const clusters: MemoryCluster[] = [];
    for (const bucket of grouped.values()) {
      clusters.push(...buildClusters(bucket, similarityThreshold));
    }
    return clusters;
  }

  async function mergeCluster(cluster: MemoryCluster, consolidationId: string): Promise<{ content: string; tokensUsed: number }> {
    const mergedModel = resolveOverrideModel();
    const prompt = [
      "Consolidate the following related memory entries into a single durable memory.",
      "Keep only information that is actually supported by the entries.",
      "Produce one concise memory entry in plain text.",
      "",
      `Scope: ${cluster.scope}`,
      `Category: ${cluster.category}`,
      "Entries:",
      ...cluster.entries.map((entry, index) => `${index + 1}. ${entry.content}`),
    ].join("\n");

    const response = await aiIntegrationService.executeTask({
      feature: "memory_consolidation",
      taskType: "memory_consolidation",
      prompt,
      cwd: projectRoot,
      model: mergedModel,
      jsonSchema: {
        type: "object",
        additionalProperties: false,
        required: ["content"],
        properties: {
          content: {
            type: "string",
            minLength: 1,
          },
        },
      },
    });

    const content = readMergedContent(response.structuredOutput)
      ?? readMergedContent(response.text)
      ?? (() => {
        throw new Error(`Consolidation ${consolidationId} returned an empty merged memory.`);
      })();

    return {
      content,
      tokensUsed: Math.max(0, Number(response.inputTokens ?? 0)) + Math.max(0, Number(response.outputTokens ?? 0)),
    };
  }

  function insertMergedEntry(cluster: MemoryCluster, content: string, consolidationId: string, timestamp: string): string {
    const id = randomUUID();
    const highestImportance = resolveHighestImportance(cluster.entries);
    const averageConfidence = clamp01(
      cluster.entries.reduce((sum, entry) => sum + entry.confidence, 0) / Math.max(1, cluster.entries.length),
    );
    const observationCount = cluster.entries.reduce((sum, entry) => sum + Math.max(1, entry.observationCount), 0);

    db.run(
      `
        INSERT INTO unified_memories (
          id,
          project_id,
          scope,
          scope_owner_id,
          tier,
          category,
          content,
          importance,
          confidence,
          observation_count,
          status,
          source_type,
          source_id,
          pinned,
          access_score,
          composite_score,
          dedupe_key,
          created_at,
          updated_at,
          last_accessed_at,
          access_count,
          promoted_at
        ) VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?, ?, 'promoted', 'consolidation', ?, 0, ?, 0, ?, ?, ?, ?, 0, ?)
      `,
      [
        id,
        projectId,
        cluster.scope,
        cluster.scope === "project" ? null : cluster.scopeOwnerId,
        cluster.category,
        content,
        highestImportance,
        averageConfidence,
        observationCount,
        consolidationId,
        seedAccessScore(highestImportance, averageConfidence),
        normalizeForDedupe(content),
        timestamp,
        timestamp,
        timestamp,
        timestamp,
      ],
    );

    return id;
  }

  function archiveOriginals(ids: readonly string[], timestamp: string) {
    for (const batch of chunk(ids, UPDATE_CHUNK_SIZE)) {
      const placeholders = batch.map(() => "?").join(", ");
      db.run(
        `
          UPDATE unified_memories
          SET status = 'archived',
              tier = 3,
              pinned = 0,
              updated_at = ?
          WHERE id IN (${placeholders})
        `,
        [timestamp, ...batch],
      );
    }
  }

  function listOverLimitTargets(): ConsolidationTarget[] {
    const rows = db.all<{ scope: SupportedScope; scope_owner_id: string | null; entry_count: number | null }>(
      `
        SELECT scope, COALESCE(scope_owner_id, '') AS scope_owner_id, COUNT(*) AS entry_count
        FROM unified_memories
        WHERE project_id = ?
          AND status != 'archived'
        GROUP BY scope, COALESCE(scope_owner_id, '')
      `,
      [projectId],
    );

    return rows
      .map((row) => ({
        scope: row.scope,
        scopeOwnerId: row.scope === "project" ? null : String(row.scope_owner_id ?? "").trim() || null,
        entryCount: Math.max(0, Number(row.entry_count ?? 0)),
      }))
      .filter((row) => row.entryCount > scopeLimits[row.scope] * 0.8)
      .map(({ scope, scopeOwnerId }) => ({ scope, scopeOwnerId }));
  }

  async function runConsolidation(args: {
    reason?: MemoryConsolidationTrigger;
    targets?: readonly ConsolidationTarget[];
  } = {}): Promise<MemoryConsolidationResult> {
    if (activeRun) return activeRun;

    const reason = args.reason ?? "manual";
    activeRun = (async () => {
      const startedAt = now().toISOString();
      const startedMs = now().getTime();
      const consolidationId = randomUUID();
      let clustersFound = 0;
      let entriesMerged = 0;
      let entriesCreated = 0;
      let tokensUsed = 0;

      emitStatus({
        type: "memory-consolidation-started",
        projectId,
        reason,
        consolidationId,
        startedAt,
      });
      logger.info("memory.consolidation.started", {
        projectId,
        consolidationId,
        reason,
      });

      try {
        const clusters = detectClusters(args.targets);
        clustersFound = clusters.length;

        for (const cluster of clusters) {
          if (cluster.entries.length < 3) continue;

          try {
            const merged = await mergeCluster(cluster, consolidationId);
            tokensUsed += merged.tokensUsed;
            const completedAt = now().toISOString();
            const mergedId = insertMergedEntry(cluster, merged.content, consolidationId, completedAt);
            archiveOriginals(cluster.entries.map((entry) => entry.id), completedAt);
            try { opts.onMemoryInserted?.(mergedId); } catch { /* best-effort */ }
            entriesMerged += cluster.entries.length;
            entriesCreated += 1;
          } catch (error) {
            logger.warn("memory.consolidation.cluster_failed", {
              projectId,
              consolidationId,
              reason,
              scope: cluster.scope,
              scopeOwnerId: cluster.scopeOwnerId,
              category: cluster.category,
              size: cluster.entries.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }

        const completedAt = now().toISOString();
        const durationMs = Math.max(0, now().getTime() - startedMs);
        db.run(
          `
            INSERT INTO memory_consolidation_log (
              consolidation_id,
              project_id,
              trigger_reason,
              started_at,
              completed_at,
              clusters_found,
              entries_merged,
              entries_created,
              tokens_used,
              duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            consolidationId,
            projectId,
            reason,
            startedAt,
            completedAt,
            clustersFound,
            entriesMerged,
            entriesCreated,
            tokensUsed,
            durationMs,
          ],
        );

        const result: MemoryConsolidationResult = {
          consolidationId,
          projectId,
          reason,
          startedAt,
          completedAt,
          clustersFound,
          entriesMerged,
          entriesCreated,
          tokensUsed,
          durationMs,
        };

        logger.info("memory.consolidation.completed", result);
        emitStatus({
          type: "memory-consolidation-completed",
          projectId,
          reason,
          consolidationId,
          startedAt,
          completedAt,
          result,
        });
        return result;
      } catch (error) {
        const completedAt = now().toISOString();
        const durationMs = Math.max(0, now().getTime() - startedMs);
        const message = error instanceof Error ? error.message : String(error);
        db.run(
          `
            INSERT INTO memory_consolidation_log (
              consolidation_id,
              project_id,
              trigger_reason,
              started_at,
              completed_at,
              clusters_found,
              entries_merged,
              entries_created,
              tokens_used,
              duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            consolidationId,
            projectId,
            reason,
            startedAt,
            completedAt,
            clustersFound,
            entriesMerged,
            entriesCreated,
            tokensUsed,
            durationMs,
          ],
        );
        logger.error("memory.consolidation.failed", {
          projectId,
          consolidationId,
          reason,
          durationMs,
          error: message,
        });
        emitStatus({
          type: "memory-consolidation-failed",
          projectId,
          reason,
          consolidationId,
          startedAt,
          completedAt,
          durationMs,
          error: message,
        });
        throw error;
      }
    })().finally(() => {
      activeRun = null;
    });

    return activeRun;
  }

  async function runAutoConsolidationIfNeeded(): Promise<MemoryConsolidationResult | null> {
    const targets = listOverLimitTargets();
    if (targets.length === 0) return null;
    return runConsolidation({ reason: "auto", targets });
  }

  function scheduleAutoConsolidationCheck() {
    if (pendingAutoCheck) clearTimeout(pendingAutoCheck);
    pendingAutoCheck = setTimeout(() => {
      pendingAutoCheck = null;
      void runAutoConsolidationIfNeeded().catch((error) => {
        logger.warn("memory.consolidation.auto_check_failed", {
          projectId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, autoCheckDebounceMs);
  }

  return {
    runConsolidation,
    runAutoConsolidationIfNeeded,
    scheduleAutoConsolidationCheck,
  };
}
