import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (path: string) => { exec: (sql: string) => void; close: () => void } };

function hasFts(): boolean {
  const tmp = new DatabaseSync(":memory:");
  try {
    tmp.exec("create virtual table _fts_probe using fts4(content)");
    return true;
  } catch {
    return false;
  } finally {
    tmp.close();
  }
}

const ftsAvailable = hasFts();
import { DEFAULT_EMBEDDING_MODEL_ID, EXPECTED_EMBEDDING_DIMENSIONS } from "./embeddingService";
import { createEmbeddingWorkerService } from "./embeddingWorkerService";
import {
  computeBm25Score,
  computeHybridCompositeScore,
  cosineSimilarity,
  createHybridSearchService,
} from "./hybridSearchService";
import { createUnifiedMemoryService, type Memory } from "./unifiedMemoryService";

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const cleanupFns: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  while (cleanupFns.length > 0) {
    cleanupFns.pop()?.();
  }
});

function hashToken(token: string): number {
  let hash = 17;
  for (const char of token) {
    hash = (hash * 31) + char.charCodeAt(0);
  }
  return Math.abs(hash);
}

function buildUnitVector(seed: string): Float32Array {
  const vector = new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS);
  const base = hashToken(seed) + 11;
  let total = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = (Math.sin(base + (index / 13)) + Math.cos((base / 3) + (index / 17))) / 2;
    vector[index] = value;
    total += value * value;
  }
  const norm = Math.sqrt(total) || 1;
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] = vector[index]! / norm;
  }
  return vector;
}

const conceptVectors = {
  vehicle: buildUnitVector("vehicle"),
  manual: buildUnitVector("manual"),
  electric: buildUnitVector("electric"),
  deploy: buildUnitVector("deploy"),
  safety: buildUnitVector("safety"),
} as const;

function addVector(target: Float32Array, source: Float32Array, weight: number) {
  for (let index = 0; index < target.length; index += 1) {
    target[index] = (target[index] ?? 0) + ((source[index] ?? 0) * weight);
  }
}

function normalizeVector(vector: Float32Array): Float32Array {
  let total = 0;
  for (const value of vector) {
    total += value * value;
  }
  const norm = Math.sqrt(total) || 1;
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    normalized[index] = vector[index]! / norm;
  }
  return normalized;
}

function semanticVector(text: string): Float32Array {
  const normalized = String(text ?? "").toLowerCase();
  const vector = new Float32Array(EXPECTED_EMBEDDING_DIMENSIONS);

  if (/car|automobile|vehicle|transport|transit/.test(normalized)) {
    addVector(vector, conceptVectors.vehicle, 1.2);
  }
  if (/manual|guide|handbook|checklist|digest/.test(normalized)) {
    addVector(vector, conceptVectors.manual, 0.8);
  }
  if (/electric|charging|battery/.test(normalized)) {
    addVector(vector, conceptVectors.electric, 0.9);
  }
  if (/deploy|release|rollout|switchover/.test(normalized)) {
    addVector(vector, conceptVectors.deploy, 1.1);
  }
  if (/safety|inspection/.test(normalized)) {
    addVector(vector, conceptVectors.safety, 0.7);
  }

  for (const token of normalized.split(/[^a-z0-9_]+/).filter(Boolean)) {
    addVector(vector, buildUnitVector(`token:${token}`), 0.03);
  }

  return normalizeVector(vector);
}

async function createFixture(opts: {
  attachQueueHook?: boolean;
  embedImpl?: (text: string) => Promise<Float32Array>;
  enableHybridSearch?: boolean;
  now?: Date;
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-hybrid-search-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const timestamp = (opts.now ?? new Date("2026-03-10T12:00:00.000Z")).toISOString();

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-1", root, "ADE", "main", timestamp, timestamp],
  );
  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-2", `${root}-other`, "Other", "main", timestamp, timestamp],
  );

  const embeddingService = {
    embed: vi.fn(opts.embedImpl ?? (async (text: string) => semanticVector(text))),
    getModelId: vi.fn(() => DEFAULT_EMBEDDING_MODEL_ID),
    isAvailable: vi.fn(() => true),
  };

  const hybridSearchService = createHybridSearchService({
    db,
    embeddingService,
    now: () => new Date(timestamp),
  });

  let worker: ReturnType<typeof createEmbeddingWorkerService>;
  const memoryService = createUnifiedMemoryService(db, {
    hybridSearchService: opts.enableHybridSearch === false ? undefined : hybridSearchService,
    onMemoryUpserted: (event) => {
      if (opts.attachQueueHook === false) return;
      if (event.created || event.contentChanged) {
        worker?.queueMemory(event.memory.id);
      }
    },
  });

  worker = createEmbeddingWorkerService({
    db,
    logger: createLogger() as any,
    projectId: "project-1",
    embeddingService,
  });

  cleanupFns.push(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  return {
    db,
    embeddingService,
    hybridSearchService,
    memoryService,
    worker,
    timestamp,
  };
}

function stampMemory(db: Awaited<ReturnType<typeof openKvDb>>, memoryId: string, timestamp: string, accessCount = 0) {
  db.run(
    `
      update unified_memories
      set created_at = ?, updated_at = ?, last_accessed_at = ?, access_count = ?
      where id = ?
    `,
    [timestamp, timestamp, timestamp, accessCount, memoryId],
  );
}

function encodeMatchInfo(values: number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setUint32(index * 4, value, true);
  });
  return bytes;
}

describe("hybridSearchService", () => {
  it.skipIf(!ftsAvailable)("keeps the FTS3 index in sync across insert, update, and delete", async () => {
    const { db, memoryService, timestamp } = await createFixture({ attachQueueHook: false });

    const memory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "alpha release checklist",
      importance: "high",
    });
    stampMemory(db, memory.id, timestamp);

    const inserted = db.all<{ id: string }>(
      `
        select m.id as id
        from unified_memories_fts
        join unified_memories m on m.rowid = unified_memories_fts.rowid
        where unified_memories_fts match ?
      `,
      ['"alpha"'],
    );

    db.run(
      "update unified_memories set content = ?, updated_at = ?, last_accessed_at = ? where id = ?",
      ["beta rollout checklist", timestamp, timestamp, memory.id],
    );

    const updated = db.all<{ id: string }>(
      `
        select m.id as id
        from unified_memories_fts
        join unified_memories m on m.rowid = unified_memories_fts.rowid
        where unified_memories_fts match ?
      `,
      ['"beta"'],
    );
    const removedOldTerm = db.all<{ id: string }>(
      `
        select m.id as id
        from unified_memories_fts
        join unified_memories m on m.rowid = unified_memories_fts.rowid
        where unified_memories_fts match ?
      `,
      ['"alpha"'],
    );

    db.run("delete from unified_memories where id = ?", [memory.id]);
    const removed = db.all<{ id: string }>(
      `
        select m.id as id
        from unified_memories_fts
        join unified_memories m on m.rowid = unified_memories_fts.rowid
        where unified_memories_fts match ?
      `,
      ['"beta"'],
    );

    expect(inserted.map((row) => row.id)).toContain(memory.id);
    expect(updated.map((row) => row.id)).toContain(memory.id);
    expect(removedOldTerm).toHaveLength(0);
    expect(removed).toHaveLength(0);
  });

  it("computes BM25 scores from matchinfo blobs", () => {
    const score = computeBm25Score(
      encodeMatchInfo([
        1, // phrases
        1, // columns
        10, // rows
        100, // avg column length
        12, // row length
        3, // hits in row
        30, // hits across all rows
        2, // docs with hits
      ]),
    );

    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(2.8693045687, 5);
  });

  it.skipIf(!ftsAvailable)("normalizes BM25 scores to [0, 1] and ranks denser keyword hits higher", async () => {
    const { memoryService, worker, hybridSearchService } = await createFixture();

    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "alpha alpha alpha deployment manual",
      importance: "high",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "alpha deployment notes",
      importance: "medium",
    });
    await worker.waitForIdle();

    const hits = await hybridSearchService.search({
      projectId: "project-1",
      query: "alpha",
      limit: 2,
    });

    expect(hits).toHaveLength(2);
    expect(hits[0]!.bm25Score).toBeGreaterThan(hits[1]!.bm25Score);
    expect(hits[0]!.bm25Normalized).toBeGreaterThan(hits[1]!.bm25Normalized);
    expect(hits[0]!.bm25Normalized).toBeGreaterThan(0);
    expect(hits[0]!.bm25Normalized).toBeLessThanOrEqual(1);
    expect(hits[1]!.bm25Normalized).toBeGreaterThan(0);
    expect(hits[1]!.bm25Normalized).toBeLessThanOrEqual(1);
  });

  it("computes cosine similarity in pure TypeScript", () => {
    const left = new Float32Array([1, 0, 0, 0]);
    const right = new Float32Array([1, 0, 0, 0]);
    const orthogonal = new Float32Array([0, 1, 0, 0]);

    expect(cosineSimilarity(left, right)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(left, orthogonal)).toBeCloseTo(0, 6);
  });

  it("applies the hybrid composite score formula", () => {
    const memory = {
      id: "memory-1",
      projectId: "project-1",
      scope: "project",
      scopeOwnerId: null,
      tier: 2,
      category: "fact",
      content: "Automobile manual",
      importance: "high",
      sourceSessionId: null,
      sourcePackKey: null,
      createdAt: "2026-03-10T12:00:00.000Z",
      updatedAt: "2026-03-10T12:00:00.000Z",
      lastAccessedAt: "2026-03-10T12:00:00.000Z",
      accessCount: 5,
      observationCount: 1,
      status: "promoted",
      agentId: null,
      confidence: 0.8,
      promotedAt: null,
      sourceRunId: null,
      sourceType: "agent",
      sourceId: null,
      fileScopePattern: null,
      pinned: false,
      accessScore: 0,
      compositeScore: 0,
      writeGateReason: null,
    } satisfies Memory;

    const { hybridScore, compositeScore } = computeHybridCompositeScore({
      memory,
      bm25Normalized: 0.6,
      cosineSimilarity: 0.8,
      hasEmbedding: true,
      now: new Date("2026-03-10T12:00:00.000Z"),
    });

    expect(hybridScore).toBeCloseTo(0.74, 6);
    expect(compositeScore).toBeCloseTo(0.816, 6);
  });

  it.skipIf(!ftsAvailable)("re-ranks near-duplicates with MMR to favor diversity", async () => {
    const { memoryService, worker, hybridSearchService } = await createFixture();

    const first = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car guide for quick inspections",
      importance: "high",
    });
    const duplicate = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "vehicle guide for quick inspections",
      importance: "high",
    });
    const diverse = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "automobile safety guide for quick inspections",
      importance: "high",
    });
    await worker.waitForIdle();

    const hits = await hybridSearchService.search({
      projectId: "project-1",
      query: "automobile guide quick inspections",
      limit: 3,
    });

    const rankedIds = hits.map((hit) => hit.memory.id);

    expect(rankedIds).toEqual(expect.arrayContaining([first.id, duplicate.id, diverse.id]));
    expect(rankedIds.indexOf(diverse.id)).toBeLessThan(rankedIds.indexOf(duplicate.id));
  });

  it.skipIf(!ftsAvailable)("embeds the query string at search time", async () => {
    const { embeddingService, hybridSearchService } = await createFixture({ attachQueueHook: false });

    await hybridSearchService.search({
      projectId: "project-1",
      query: "automobile",
      limit: 5,
    });

    expect(embeddingService.embed).toHaveBeenCalledWith("automobile");
  });

  it.skipIf(!ftsAvailable)("post-filters vector candidates by project, scope, and scope owner for isolation", async () => {
    const { db, memoryService, worker, hybridSearchService } = await createFixture();

    const projectMemory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car maintenance playbook",
      importance: "high",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "agent",
      scopeOwnerId: "agent-1",
      category: "fact",
      content: "car maintenance playbook",
      importance: "high",
      agentId: "agent-1",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "mission",
      scopeOwnerId: "run-1",
      category: "fact",
      content: "car maintenance playbook",
      importance: "high",
      sourceRunId: "run-1",
    });

    db.run(
      `
        insert into unified_memories (
          id, project_id, scope, scope_owner_id, tier, category, content, importance, confidence, observation_count,
          status, source_type, source_id, source_session_id, source_pack_key, source_run_id, file_scope_pattern,
          agent_id, pinned, access_score, composite_score, write_gate_reason, dedupe_key, created_at, updated_at,
          last_accessed_at, access_count, promoted_at
        ) values (?, ?, 'project', null, 2, 'fact', ?, 'high', 1, 1, 'promoted', 'agent', null, null, null, null, null, null, 0, 1, 0, null, ?, ?, ?, ?, 0, ?)
      `,
      [
        'project-2-memory',
        'project-2',
        'car maintenance playbook',
        'car maintenance playbook',
        '2026-03-10T12:00:00.000Z',
        '2026-03-10T12:00:00.000Z',
        '2026-03-10T12:00:00.000Z',
        '2026-03-10T12:00:00.000Z',
      ],
    );
    db.run(
      `
        insert into unified_memory_embeddings(
          id, memory_id, project_id, embedding_model, embedding_blob, dimensions, norm, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        'project-2-embedding',
        'project-2-memory',
        'project-2',
        DEFAULT_EMBEDDING_MODEL_ID,
        Buffer.from(semanticVector('car maintenance playbook').buffer),
        EXPECTED_EMBEDDING_DIMENSIONS,
        1,
        '2026-03-10T12:00:00.000Z',
        '2026-03-10T12:00:00.000Z',
      ],
    );
    await worker.waitForIdle();

    const hits = await hybridSearchService.search({
      projectId: "project-1",
      scope: "project",
      query: "automobile handbook",
      limit: 10,
    });

    expect(hits.map((hit) => hit.memory.id)).toEqual([projectMemory.id]);
  });

  it.skipIf(!ftsAvailable)("excludes archived entries from hybrid results even when embeddings exist", async () => {
    const { memoryService, worker, hybridSearchService } = await createFixture();

    const archived = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car archive note",
      importance: "high",
    });
    const active = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car active note",
      importance: "high",
    });
    await worker.waitForIdle();
    memoryService.archiveMemory(archived.id);

    const hits = await hybridSearchService.search({
      projectId: "project-1",
      query: "automobile note",
      limit: 10,
    });

    expect(hits.map((hit) => hit.memory.id)).toContain(active.id);
    expect(hits.map((hit) => hit.memory.id)).not.toContain(archived.id);
  });

  it.skipIf(!ftsAvailable)("keeps lexical matches without embeddings by using BM25-only hybrid scoring", async () => {
    const { hybridSearchService, memoryService } = await createFixture({ attachQueueHook: false });

    const memory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "alpha launch note",
      importance: "medium",
    });

    const hits = await hybridSearchService.search({
      projectId: "project-1",
      query: "alpha",
      limit: 5,
    });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.memory.id).toBe(memory.id);
    expect(hits[0]!.hasEmbedding).toBe(false);
    expect(hits[0]!.hybridScore).toBeCloseTo(hits[0]!.bm25Normalized, 6);
  });

  it("falls back to the shipped lexical ranking when the embedding pipeline is unavailable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T12:00:00.000Z"));

    const lexicalFixture = await createFixture({ attachQueueHook: false, enableHybridSearch: false });
    const fallbackFixture = await createFixture({
      attachQueueHook: false,
      embedImpl: async () => {
        throw new Error("embeddings unavailable");
      },
    });

    const seed = async (fixture: Awaited<ReturnType<typeof createFixture>>) => {
      fixture.memoryService.addMemory({
        projectId: "project-1",
        scope: "project",
        category: "fact",
        content: "alpha beta deployment guide",
        importance: "high",
      });
      fixture.memoryService.addMemory({
        projectId: "project-1",
        scope: "project",
        category: "fact",
        content: "alpha deployment note",
        importance: "medium",
      });
    };

    await seed(lexicalFixture);
    await seed(fallbackFixture);

    const lexical = await lexicalFixture.memoryService.searchMemories("alpha deployment", "project-1", "project", 10);
    const fallback = await fallbackFixture.memoryService.searchMemories("alpha deployment", "project-1", "project", 10);

    expect(fallback.map((entry) => entry.content)).toEqual(lexical.map((entry) => entry.content));
    expect(fallback.map((entry) => entry.compositeScore)).toEqual(lexical.map((entry) => entry.compositeScore));
  });

  it.skipIf(!ftsAvailable)("finds synonym matches through semantic search", async () => {
    const { memoryService, worker } = await createFixture();

    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car repair handbook",
      importance: "high",
    });
    await worker.waitForIdle();

    const hits = await memoryService.searchMemories("automobile", "project-1", "project", 5);

    expect(hits).toHaveLength(1);
    expect(hits[0]!.content).toContain("car repair handbook");
  });

  it.skipIf(!ftsAvailable)("makes consolidated entries searchable after the embedding worker processes them", async () => {
    const { db, memoryService, worker } = await createFixture();

    const memory = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "digest",
      content: "vehicle maintenance digest",
      importance: "high",
      sourceType: "consolidation",
      status: "promoted",
      confidence: 1,
    }).memory;

    await worker.waitForIdle();

    const embeddingCount = db.get<{ count: number }>(
      "select count(1) as count from unified_memory_embeddings where memory_id = ?",
      [memory?.id ?? ""],
    )?.count ?? 0;
    const hits = await memoryService.searchMemories("automobile", "project-1", "project", 5);

    expect(memory?.sourceType).toBe("consolidation");
    expect(embeddingCount).toBe(1);
    expect(hits.map((entry) => entry.id)).toContain(memory?.id);
  });

  it.skipIf(!ftsAvailable)("supports the full write to queue to embed to search flow", async () => {
    const { db, memoryService, worker } = await createFixture();

    const memory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "blue green switchover deployment runbook",
      importance: "high",
    });
    await worker.waitForIdle();

    const embeddingCount = db.get<{ count: number }>(
      "select count(1) as count from unified_memory_embeddings where memory_id = ?",
      [memory.id],
    )?.count ?? 0;
    const hits = await memoryService.searchMemories("release switchover", "project-1", "project", 5);

    expect(embeddingCount).toBe(1);
    expect(hits.map((entry) => entry.id)).toContain(memory.id);
  });

  it("re-embeds merged content updates so new terms become searchable", async () => {
    const { embeddingService, db, memoryService, worker } = await createFixture();

    const original = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car manual for electric charging stations",
      importance: "high",
    });
    await worker.waitForIdle();

    const updated = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: "car manual for electric charging stations safety",
      importance: "high",
    });
    await worker.waitForIdle();

    const stored = db.get<{ content: string }>("select content from unified_memories where id = ?", [original.id]);
    const hits = await memoryService.searchMemories("safety", "project-1", "project", 5);
    const writeEmbeds = embeddingService.embed.mock.calls.filter(([text]) => String(text).includes("car manual")).length;

    expect(updated.id).toBe(original.id);
    expect(stored?.content).toContain("safety");
    expect(writeEmbeds).toBe(2);
    expect(hits.map((entry) => entry.id)).toContain(original.id);
  });
});
