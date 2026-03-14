import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createSessionService } from "../sessions/sessionService";
import { createUnifiedMemoryService } from "./unifiedMemoryService";
import {
  createEmbeddingWorkerService,
  DEFAULT_ACTIVE_BATCH_SIZE,
  DEFAULT_IDLE_BATCH_SIZE,
} from "./embeddingWorkerService";
import { DEFAULT_EMBEDDING_MODEL_ID, EXPECTED_EMBEDDING_DIMENSIONS } from "./embeddingService";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildVector(seed: string): Float32Array {
  const chars = Array.from(seed).map((value) => value.charCodeAt(0));
  const base = chars.reduce((sum, value, index) => sum + value * (index + 3), 23);
  const vector = new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS);

  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = (Math.sin(base + index / 11) + Math.cos(base / 5 + index / 19)) / 2;
  }

  return vector;
}

async function createFixture(opts: {
  withActiveSession?: boolean;
  embedImpl?: (text: string) => Promise<Float32Array>;
  sleep?: (ms: number) => Promise<void>;
  idleBatchSize?: number;
  activeBatchSize?: number;
  attachQueueHook?: boolean;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-embedding-worker-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const now = "2026-03-09T12:00:00.000Z";

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-1", root, "ADE", "main", now, now],
  );

  if (opts.withActiveSession) {
    db.run(
      `
        insert into lanes(
          id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
          attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
          status, created_at, archived_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, null, null, null, null, null, ?, ?, null)
      `,
      ["lane-1", "project-1", "Lane 1", null, "worktree", "main", "lane-1", root, root, "active", now],
    );
    db.run(
      `
        insert into terminal_sessions(
          id, lane_id, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
          exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
          last_output_at, summary, resume_command
        ) values (?, ?, null, 1, null, 'shell', 0, ?, ?, null, null, ?, null, null, 'running', null, null, null, null)
      `,
      ["session-1", "lane-1", "Embedding session", now, path.join(root, "session.log")],
    );
  }

  const logger = createLogger();
  const sessionService = createSessionService({ db });
  const embeddingService = {
    embed: vi.fn(opts.embedImpl ?? (async (text: string) => buildVector(text))),
    isAvailable: vi.fn(() => true),
    getModelId: vi.fn(() => DEFAULT_EMBEDDING_MODEL_ID),
  };

  let worker: ReturnType<typeof createEmbeddingWorkerService>;
  const memoryService = createUnifiedMemoryService(db, {
    onMemoryUpserted: (event) => {
      if (opts.attachQueueHook === false) return;
      if (event.created || event.contentChanged) {
        worker?.queueMemory(event.memory.id);
      }
    },
  });

  worker = createEmbeddingWorkerService({
    db,
    logger,
    projectId: "project-1",
    embeddingService,
    sessionService,
    idleBatchSize: opts.idleBatchSize ?? DEFAULT_IDLE_BATCH_SIZE,
    activeBatchSize: opts.activeBatchSize ?? DEFAULT_ACTIVE_BATCH_SIZE,
    sleep: opts.sleep,
  });

  return {
    db,
    logger,
    worker,
    memoryService,
    embeddingService,
    sessionService,
  };
}

function countEmbeddings(db: Awaited<ReturnType<typeof openKvDb>>) {
  return Number(
    db.get<{ count: number }>("select count(1) as count from unified_memory_embeddings")?.count ?? 0,
  );
}

describe("embeddingWorkerService", () => {
  it("queues memoryAdd writes for asynchronous embedding without blocking the write", async () => {
    const { db, worker, memoryService } = await createFixture();

    const memory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "Queue the new memory for embeddings.",
      importance: "high",
    });

    expect(memory.id).toBeTruthy();
    expect(countEmbeddings(db)).toBe(0);

    await worker.waitForIdle();

    expect(countEmbeddings(db)).toBe(1);
  });

  it("backfills entries missing embeddings on startup", async () => {
    const { db, worker, memoryService, embeddingService } = await createFixture({ attachQueueHook: false });

    const existing = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "Already embedded",
      importance: "medium",
    });
    const missing = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "Needs startup backfill",
      importance: "medium",
    });

    db.run(
      `
        insert into unified_memory_embeddings(
          id, memory_id, project_id, embedding_model, embedding_blob, dimensions, norm, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "embedding-1",
        existing.id,
        "project-1",
        DEFAULT_EMBEDDING_MODEL_ID,
        Buffer.from(buildVector(existing.content).buffer),
        EXPECTED_EMBEDDING_DIMENSIONS,
        1,
        "2026-03-09T12:00:00.000Z",
        "2026-03-09T12:00:00.000Z",
      ],
    );

    await worker.start();
    await worker.waitForIdle();

    expect(embeddingService.embed).toHaveBeenCalledTimes(1);
    const rows = db.all<{ memory_id: string }>(
      "select memory_id from unified_memory_embeddings order by memory_id asc",
    );
    expect(rows.map((row) => row.memory_id)).toEqual([existing.id, missing.id].sort());
  });

  it("processes queued memories in bounded batches and stores 384-d blobs", async () => {
    const { db, worker, memoryService } = await createFixture({ idleBatchSize: 10, activeBatchSize: 10 });

    for (let index = 0; index < 12; index += 1) {
      memoryService.addMemory({
        projectId: "project-1",
        scope: "project",
        category: "fact",
        content: `Batch memory ${index}`,
        importance: "medium",
      });
    }

    await worker.waitForIdle();

    const status = worker.getStatus();
    const sample = db.get<{ dimensions: number; embedding_blob: Uint8Array }>(
      "select dimensions, embedding_blob from unified_memory_embeddings limit 1",
    );

    expect(countEmbeddings(db)).toBe(12);
    expect(status.batchesProcessed).toBe(2);
    expect(status.maxBatchSizeObserved).toBe(10);
    expect(sample?.dimensions).toBe(EXPECTED_EMBEDDING_DIMENSIONS);
    expect(sample?.embedding_blob).toBeInstanceOf(Uint8Array);
    expect(sample?.embedding_blob.byteLength).toBe(EXPECTED_EMBEDDING_DIMENSIONS * 4);
  });

  it("reduces batch size and yields between batches while sessions are active", async () => {
    const sleep = vi.fn(async () => {});
    const { worker, memoryService } = await createFixture({
      withActiveSession: true,
      sleep,
      idleBatchSize: 50,
      activeBatchSize: 10,
    });

    for (let index = 0; index < 12; index += 1) {
      memoryService.addMemory({
        projectId: "project-1",
        scope: "project",
        category: "fact",
        content: `Active session memory ${index}`,
        importance: "medium",
      });
    }

    await worker.waitForIdle();

    expect(worker.getStatus()).toEqual(
      expect.objectContaining({
        batchesProcessed: 2,
        maxBatchSizeObserved: 10,
      }),
    );
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it("logs and skips a failed entry without blocking the rest of the batch", async () => {
    const { db, logger, worker, memoryService } = await createFixture({
      idleBatchSize: 10,
      activeBatchSize: 10,
      embedImpl: async (text: string) => {
        if (text.includes("broken")) {
          throw new Error("embedding failed");
        }
        return buildVector(text);
      },
    });

    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "good memory 1",
      importance: "medium",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "broken memory",
      importance: "medium",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "good memory 2",
      importance: "medium",
    });

    await worker.waitForIdle();

    expect(countEmbeddings(db)).toBe(2);
    expect(worker.getStatus()).toEqual(expect.objectContaining({ failedEntries: 1 }));
    expect(logger.error).toHaveBeenCalledWith(
      "memory.embedding_worker.entry_failed",
      expect.objectContaining({ error: "embedding failed" }),
    );
  });
});
