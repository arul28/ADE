import { randomUUID } from "node:crypto";
import type { Logger } from "../logging/logger";
import type { createSessionService } from "../sessions/sessionService";
import type { AdeDb } from "../state/kvDb";
import { getErrorMessage } from "../shared/utils";
import type { createEmbeddingService } from "./embeddingService";

export const DEFAULT_IDLE_BATCH_SIZE = 50;
export const DEFAULT_ACTIVE_BATCH_SIZE = 10;
const MIN_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const DEFAULT_YIELD_MS = 100;

type MemoryRow = {
  id: string;
  content: string | null;
  status: string | null;
};

type CreateEmbeddingWorkerServiceOpts = {
  db: AdeDb;
  logger: Pick<Logger, "info" | "warn" | "error">;
  projectId: string;
  embeddingService: Pick<ReturnType<typeof createEmbeddingService>, "embed" | "getModelId" | "isAvailable">;
  sessionService?: Pick<ReturnType<typeof createSessionService>, "list">;
  idleBatchSize?: number;
  activeBatchSize?: number;
  yieldMs?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
};

export type EmbeddingWorkerStatus = {
  started: boolean;
  queueDepth: number;
  processing: boolean;
  batchesProcessed: number;
  embeddingsWritten: number;
  failedEntries: number;
  lastBatchSize: number;
  maxBatchSizeObserved: number;
  lastProcessedAt: string | null;
};

function normalizeBatchSize(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value == null) return fallback;
  return Math.max(MIN_BATCH_SIZE, Math.min(MAX_BATCH_SIZE, Math.floor(value)));
}

function computeNorm(vector: Float32Array): number {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  return Math.sqrt(total);
}

function sleepFor(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type EmbeddingWorkerService = ReturnType<typeof createEmbeddingWorkerService>;

export function createEmbeddingWorkerService(opts: CreateEmbeddingWorkerServiceOpts) {
  const {
    db,
    logger,
    projectId,
    embeddingService,
    sessionService,
    now = () => new Date(),
    sleep = sleepFor,
  } = opts;

  const idleBatchSize = normalizeBatchSize(opts.idleBatchSize, DEFAULT_IDLE_BATCH_SIZE);
  const activeBatchSize = normalizeBatchSize(opts.activeBatchSize, DEFAULT_ACTIVE_BATCH_SIZE);
  const yieldMs = Math.max(0, Math.floor(opts.yieldMs ?? DEFAULT_YIELD_MS));

  const queue: string[] = [];
  const queuedIds = new Set<string>();
  const idleResolvers = new Set<() => void>();

  let started = false;
  let scheduled = false;
  let processingPromise: Promise<void> | null = null;
  let batchesProcessed = 0;
  let embeddingsWritten = 0;
  let failedEntries = 0;
  let lastBatchSize = 0;
  let maxBatchSizeObserved = 0;
  let lastProcessedAt: string | null = null;

  function getStatus(): EmbeddingWorkerStatus {
    return {
      started,
      queueDepth: queue.length,
      processing: processingPromise != null,
      batchesProcessed,
      embeddingsWritten,
      failedEntries,
      lastBatchSize,
      maxBatchSizeObserved,
      lastProcessedAt,
    };
  }

  function resolveIdleIfNeeded() {
    if (scheduled || processingPromise || queue.length > 0) return;
    for (const resolve of idleResolvers) {
      resolve();
    }
    idleResolvers.clear();
  }

  function isSessionActive(): boolean {
    try {
      return (sessionService?.list({ status: "running", limit: 1 }).length ?? 0) > 0;
    } catch (error) {
      logger.warn("memory.embedding_worker.active_session_check_failed", {
        projectId,
        error: getErrorMessage(error),
      });
      return false;
    }
  }

  function nextBatchSize(): number {
    return isSessionActive() ? activeBatchSize : idleBatchSize;
  }

  function scheduleProcessing() {
    if (scheduled || processingPromise || queue.length === 0) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      void processQueue().catch((error) => {
        logger.error("memory.embedding_worker.queue_failed", {
          projectId,
          error: getErrorMessage(error),
        });
      });
    }, 0);
  }

  function queueMemory(memoryId: string) {
    if (!embeddingService.isAvailable()) return;
    const normalized = String(memoryId ?? "").trim();
    if (!normalized || queuedIds.has(normalized)) return;
    queuedIds.add(normalized);
    queue.push(normalized);
    scheduleProcessing();
  }

  function listBackfillIds(): string[] {
    return db.all<{ id: string }>(
      `
        SELECT m.id AS id
        FROM unified_memories m
        LEFT JOIN unified_memory_embeddings e
          ON e.memory_id = m.id
         AND e.embedding_model = ?
        WHERE m.project_id = ?
          AND m.status != 'archived'
          AND e.id IS NULL
        ORDER BY m.created_at ASC
      `,
      [embeddingService.getModelId(), projectId],
    ).map((row) => String(row.id ?? "").trim()).filter(Boolean);
  }

  function readRows(batchIds: readonly string[]): MemoryRow[] {
    if (batchIds.length === 0) return [];
    const placeholders = batchIds.map(() => "?").join(", ");
    const rows = db.all<MemoryRow>(
      `
        SELECT id, content, status
        FROM unified_memories
        WHERE project_id = ?
          AND id IN (${placeholders})
      `,
      [projectId, ...batchIds],
    );
    const rowById = new Map(rows.map((row) => [String(row.id ?? ""), row]));
    return batchIds.map((id) => rowById.get(id)).filter((row): row is MemoryRow => Boolean(row));
  }

  function writeEmbedding(memoryId: string, vector: Float32Array, timestamp: string) {
    const modelId = embeddingService.getModelId();
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    const norm = computeNorm(vector);
    const existing = db.get<{ id: string }>(
      `
        SELECT id
        FROM unified_memory_embeddings
        WHERE memory_id = ?
          AND embedding_model = ?
        LIMIT 1
      `,
      [memoryId, modelId],
    );

    if (existing?.id) {
      db.run(
        `
          UPDATE unified_memory_embeddings
          SET embedding_blob = ?,
              dimensions = ?,
              norm = ?,
              updated_at = ?
          WHERE id = ?
        `,
        [blob, vector.length, norm, timestamp, existing.id],
      );
      return;
    }

    db.run(
      `
        INSERT INTO unified_memory_embeddings(
          id, memory_id, project_id, embedding_model, embedding_blob, dimensions, norm, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [randomUUID(), memoryId, projectId, modelId, blob, vector.length, norm, timestamp, timestamp],
    );
  }

  async function processQueue() {
    if (processingPromise) return processingPromise;

    processingPromise = (async () => {
      while (queue.length > 0) {
        const batchSize = Math.min(nextBatchSize(), queue.length);
        const batchIds = queue.splice(0, batchSize);
        for (const id of batchIds) {
          queuedIds.delete(id);
        }

        lastBatchSize = batchIds.length;
        maxBatchSizeObserved = Math.max(maxBatchSizeObserved, batchIds.length);
        batchesProcessed += 1;

        const rows = readRows(batchIds);
        const timestamp = now().toISOString();

        for (const row of rows) {
          const memoryId = String(row.id ?? "").trim();
          if (!memoryId) continue;
          if (String(row.status ?? "").trim() === "archived") continue;

          try {
            const vector = await embeddingService.embed(String(row.content ?? ""));
            writeEmbedding(memoryId, vector, timestamp);
            embeddingsWritten += 1;
            lastProcessedAt = timestamp;
          } catch (error) {
            failedEntries += 1;
            logger.error("memory.embedding_worker.entry_failed", {
              projectId,
              memoryId,
              error: getErrorMessage(error),
            });
          }
        }

        if (queue.length > 0 && yieldMs > 0) {
          await sleep(yieldMs);
        }
      }
    })().finally(() => {
      processingPromise = null;
      resolveIdleIfNeeded();
      if (queue.length > 0) {
        scheduleProcessing();
      }
    });

    return processingPromise;
  }

  async function start() {
    if (started) return getStatus();
    started = true;
    if (!embeddingService.isAvailable()) return getStatus();
    for (const id of listBackfillIds()) {
      queueMemory(id);
    }
    return getStatus();
  }

  async function waitForIdle() {
    if (!scheduled && !processingPromise && queue.length === 0) return;
    await new Promise<void>((resolve) => {
      idleResolvers.add(resolve);
    });
  }

  return {
    getStatus,
    processQueue,
    queueMemory,
    start,
    waitForIdle,
  };
}
