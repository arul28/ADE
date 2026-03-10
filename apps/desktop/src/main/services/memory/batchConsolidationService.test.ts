import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryConsolidationStatusEventPayload } from "../../../shared/types";
import { openKvDb, type AdeDb } from "../state/kvDb";
import {
  computeJaccardTrigramSimilarity,
  createBatchConsolidationService,
} from "./batchConsolidationService";

const PROJECT_ID = "project-1";
const NOW_ISO = "2026-03-09T12:00:00.000Z";

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

type InsertMemoryArgs = {
  id?: string;
  scope?: "project" | "agent" | "mission";
  scopeOwnerId?: string | null;
  tier?: 1 | 2 | 3;
  category?: string;
  content?: string;
  importance?: "low" | "medium" | "high";
  confidence?: number;
  observationCount?: number;
  status?: "candidate" | "promoted" | "archived";
  pinned?: boolean;
  createdAt?: string;
  updatedAt?: string;
  lastAccessedAt?: string;
};

type Fixture = {
  db: AdeDb;
  root: string;
  events: MemoryConsolidationStatusEventPayload[];
  executeTask: ReturnType<typeof vi.fn>;
  service: ReturnType<typeof createBatchConsolidationService>;
};

async function createFixture(args: {
  nowIso?: string;
  limits?: { project?: number; agent?: number; mission?: number };
  aiConfig?: Record<string, unknown>;
  mergedContent?: string;
} = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-batch-consolidation-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const nowIso = args.nowIso ?? NOW_ISO;

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [PROJECT_ID, root, "ADE", "main", nowIso, nowIso],
  );

  const executeTask = vi.fn(async (taskArgs: Record<string, unknown>) => ({
    text: JSON.stringify({ content: args.mergedContent ?? "Merged consolidated memory" }),
    structuredOutput: { content: args.mergedContent ?? "Merged consolidated memory" },
    provider: "claude",
    model: (typeof taskArgs.model === "string" && taskArgs.model.length > 0)
      ? taskArgs.model
      : "anthropic/claude-haiku-4-5",
    sessionId: "session-1",
    inputTokens: 13,
    outputTokens: 7,
    durationMs: 25,
  }));

  const projectConfigService = {
    get: vi.fn(() => ({
      effective: {
        ai: args.aiConfig ?? {},
      },
    })),
  } as any;

  const events: MemoryConsolidationStatusEventPayload[] = [];
  const service = createBatchConsolidationService({
    db,
    logger: createLogger(),
    projectId: PROJECT_ID,
    projectRoot: root,
    aiIntegrationService: { executeTask } as any,
    projectConfigService,
    now: () => new Date(nowIso),
    limits: args.limits,
    onStatus: (event) => events.push(event),
  });

  return { db, root, events, executeTask, service };
}

function insertMemory(db: AdeDb, args: InsertMemoryArgs = {}): string {
  const id = args.id ?? randomUUID();
  const scope = args.scope ?? "project";
  const scopeOwnerId = args.scopeOwnerId ?? null;
  const createdAt = args.createdAt ?? NOW_ISO;
  const updatedAt = args.updatedAt ?? createdAt;
  const lastAccessedAt = args.lastAccessedAt ?? createdAt;
  const content = args.content ?? `Memory ${id}`;

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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', NULL, ?, 0.5, 0, ?, ?, ?, ?, 0, ?)
    `,
    [
      id,
      PROJECT_ID,
      scope,
      scopeOwnerId,
      args.tier ?? 2,
      args.category ?? "fact",
      content,
      args.importance ?? "medium",
      args.confidence ?? 0.8,
      args.observationCount ?? 1,
      args.status ?? "promoted",
      args.pinned ? 1 : 0,
      content.toLowerCase(),
      createdAt,
      updatedAt,
      lastAccessedAt,
      args.status === "promoted" ? createdAt : null,
    ],
  );

  return id;
}

function getMemory(db: AdeDb, id: string) {
  return db.get<Record<string, unknown>>("SELECT * FROM unified_memories WHERE id = ?", [id]);
}

function listConsolidationMemories(db: AdeDb) {
  return db.all<Record<string, unknown>>(
    `
      SELECT *
      FROM unified_memories
      WHERE project_id = ?
        AND source_type = 'consolidation'
      ORDER BY created_at ASC, id ASC
    `,
    [PROJECT_ID],
  );
}

const TRIPLET = [
  "Use npm test before opening a pull request",
  "Use npm tests before opening any pull request",
  "Always use npm test before opening the pull request",
] as const;

describe("batchConsolidationService", () => {
  it("computes Jaccard trigram similarity for known inputs", () => {
    expect(computeJaccardTrigramSimilarity("hello", "hello")).toBe(1);
    expect(computeJaccardTrigramSimilarity("hello", "helix")).toBeCloseTo(0.2, 6);
    expect(computeJaccardTrigramSimilarity("abc", "xyz")).toBe(0);
  });

  it("reports clusters for similar entries even when fewer than three entries qualify", async () => {
    const fixture = await createFixture();
    insertMemory(fixture.db, { content: TRIPLET[0] });
    insertMemory(fixture.db, { content: TRIPLET[1] });

    const result = await fixture.service.runConsolidation({ reason: "manual" });

    expect(result.clustersFound).toBe(1);
    expect(result.entriesMerged).toBe(0);
    expect(result.entriesCreated).toBe(0);
    expect(fixture.executeTask).not.toHaveBeenCalled();
  });

  it("merges clusters of three or more entries via the AI integration service", async () => {
    const fixture = await createFixture({ mergedContent: "Merged npm test guidance" });
    for (const content of TRIPLET) {
      insertMemory(fixture.db, { content });
    }

    const result = await fixture.service.runConsolidation({ reason: "manual" });
    const created = listConsolidationMemories(fixture.db);

    expect(result.clustersFound).toBe(1);
    expect(result.entriesMerged).toBe(3);
    expect(result.entriesCreated).toBe(1);
    expect(fixture.executeTask).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]?.content).toBe("Merged npm test guidance");
  });

  it("creates merged entries with the highest importance, average confidence, combined observation count, and consolidation source type", async () => {
    const fixture = await createFixture({ mergedContent: "Unified release checklist memory" });
    insertMemory(fixture.db, { content: TRIPLET[0], importance: "low", confidence: 0.3, observationCount: 1 });
    insertMemory(fixture.db, { content: TRIPLET[1], importance: "high", confidence: 0.9, observationCount: 4 });
    insertMemory(fixture.db, { content: TRIPLET[2], importance: "medium", confidence: 0.6, observationCount: 3 });

    await fixture.service.runConsolidation({ reason: "manual" });
    const created = listConsolidationMemories(fixture.db)[0];

    expect(created?.importance).toBe("high");
    expect(Number(created?.confidence ?? 0)).toBeCloseTo((0.3 + 0.9 + 0.6) / 3, 6);
    expect(Number(created?.observation_count ?? 0)).toBe(8);
    expect(created?.source_type).toBe("consolidation");
  });

  it("archives originals instead of deleting them after consolidation", async () => {
    const fixture = await createFixture();
    const ids = TRIPLET.map((content) => insertMemory(fixture.db, { content }));

    await fixture.service.runConsolidation({ reason: "manual" });

    expect(ids.map((id) => getMemory(fixture.db, id)?.status)).toEqual(["archived", "archived", "archived"]);
    expect(fixture.db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM unified_memories WHERE project_id = ? AND id IN (?, ?, ?)",
      [PROJECT_ID, ...ids],
    )?.count).toBe(3);
  });

  it("excludes tier 1 pinned entries from clustering and merging", async () => {
    const fixture = await createFixture();
    insertMemory(fixture.db, { content: TRIPLET[0], tier: 1, pinned: true, importance: "high" });
    insertMemory(fixture.db, { content: TRIPLET[1] });
    insertMemory(fixture.db, { content: TRIPLET[2] });

    const result = await fixture.service.runConsolidation({ reason: "manual" });

    expect(result.clustersFound).toBe(0);
    expect(result.entriesCreated).toBe(0);
    expect(fixture.executeTask).not.toHaveBeenCalled();
  });

  it("never clusters entries across scopes", async () => {
    const fixture = await createFixture();
    insertMemory(fixture.db, { content: TRIPLET[0], scope: "project" });
    insertMemory(fixture.db, { content: TRIPLET[1], scope: "project" });
    insertMemory(fixture.db, { content: TRIPLET[2], scope: "agent", scopeOwnerId: "agent-1" });

    const result = await fixture.service.runConsolidation({ reason: "manual" });

    expect(result.clustersFound).toBe(1);
    expect(result.entriesCreated).toBe(0);
    expect(fixture.executeTask).not.toHaveBeenCalled();
  });

  it("never clusters entries across categories", async () => {
    const fixture = await createFixture();
    insertMemory(fixture.db, { content: TRIPLET[0], category: "fact" });
    insertMemory(fixture.db, { content: TRIPLET[1], category: "fact" });
    insertMemory(fixture.db, { content: TRIPLET[2], category: "decision" });

    const result = await fixture.service.runConsolidation({ reason: "manual" });

    expect(result.clustersFound).toBe(1);
    expect(result.entriesCreated).toBe(0);
    expect(fixture.executeTask).not.toHaveBeenCalled();
  });

  it("records consolidation stats and emits lifecycle status events", async () => {
    const fixture = await createFixture();
    for (const content of TRIPLET) {
      insertMemory(fixture.db, { content });
    }

    const result = await fixture.service.runConsolidation({ reason: "manual" });
    const logRow = fixture.db.get<Record<string, unknown>>(
      "SELECT * FROM memory_consolidation_log WHERE consolidation_id = ?",
      [result.consolidationId],
    );

    expect(logRow?.project_id).toBe(PROJECT_ID);
    expect(Number(logRow?.clusters_found ?? 0)).toBe(1);
    expect(Number(logRow?.entries_merged ?? 0)).toBe(3);
    expect(Number(logRow?.entries_created ?? 0)).toBe(1);
    expect(Number(logRow?.tokens_used ?? 0)).toBe(20);
    expect(fixture.events.map((event) => event.type)).toEqual([
      "memory-consolidation-started",
      "memory-consolidation-completed",
    ]);
  });

  it("auto-triggers consolidation when a scope exceeds 80 percent of its hard limit", async () => {
    const fixture = await createFixture({ limits: { project: 4 } });
    for (const content of [TRIPLET[0], TRIPLET[1], TRIPLET[2], `${TRIPLET[2]} now`]) {
      insertMemory(fixture.db, { content });
    }

    const result = await fixture.service.runAutoConsolidationIfNeeded();

    expect(result?.reason).toBe("auto");
    expect(fixture.executeTask).toHaveBeenCalledTimes(1);
  });

  it("does not auto-trigger when scope counts stay at or below the 80 percent threshold", async () => {
    const fixture = await createFixture({ limits: { project: 5 } });
    for (const content of [TRIPLET[0], TRIPLET[1], TRIPLET[2], `${TRIPLET[2]} now`] as const) {
      insertMemory(fixture.db, { content });
    }

    const result = await fixture.service.runAutoConsolidationIfNeeded();

    expect(result).toBeNull();
    expect(fixture.executeTask).not.toHaveBeenCalled();
  });

  it("uses the configured featureModelOverrides.memory_consolidation model when present", async () => {
    const fixture = await createFixture({
      aiConfig: {
        featureModelOverrides: {
          memory_consolidation: "openai/gpt-5.4-mini",
        },
      },
    });
    for (const content of TRIPLET) {
      insertMemory(fixture.db, { content });
    }

    await fixture.service.runConsolidation({ reason: "manual" });

    expect(fixture.executeTask).toHaveBeenCalledWith(expect.objectContaining({
      feature: "memory_consolidation",
      taskType: "memory_consolidation",
      model: "openai/gpt-5.4-mini",
    }));
  });

  it("falls back to aiIntegrationService task defaults when no feature override is configured", async () => {
    const fixture = await createFixture();
    for (const content of TRIPLET) {
      insertMemory(fixture.db, { content });
    }

    await fixture.service.runConsolidation({ reason: "manual" });

    expect(fixture.executeTask).toHaveBeenCalledWith(expect.objectContaining({
      feature: "memory_consolidation",
      taskType: "memory_consolidation",
      model: undefined,
    }));
  });
});
