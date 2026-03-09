import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { MemorySweepStatusEventPayload } from "../../../shared/types";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createMemoryLifecycleService } from "./memoryLifecycleService";

const PROJECT_ID = "project-1";
const NOW_ISO = "2026-03-09T12:00:00.000Z";
const DAY_MS = 24 * 60 * 60 * 1000;

function createLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

type Fixture = {
  db: AdeDb;
  root: string;
  now: Date;
  events: MemorySweepStatusEventPayload[];
  service: ReturnType<typeof createMemoryLifecycleService>;
};

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
  accessScore?: number;
  compositeScore?: number;
  createdAt?: string;
  updatedAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
};

async function createFixture(args: {
  nowIso?: string;
  limits?: { project?: number; agent?: number; mission?: number };
} = {}): Promise<Fixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-memory-lifecycle-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const now = new Date(args.nowIso ?? NOW_ISO);
  const nowIso = now.toISOString();

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [PROJECT_ID, root, "ADE", "main", nowIso, nowIso],
  );

  const events: MemorySweepStatusEventPayload[] = [];
  const service = createMemoryLifecycleService({
    db,
    logger: createLogger(),
    projectId: PROJECT_ID,
    now: () => new Date(now.toISOString()),
    onStatus: (event) => events.push(event),
    limits: args.limits,
  });

  return { db, root, now, events, service };
}

function daysAgoIso(reference: Date, days: number): string {
  return new Date(reference.getTime() - days * DAY_MS).toISOString();
}

function insertMemory(db: AdeDb, now: Date, args: InsertMemoryArgs = {}): string {
  const id = args.id ?? randomUUID();
  const scope = args.scope ?? "project";
  const scopeOwnerId = args.scopeOwnerId ?? null;
  const createdAt = args.createdAt ?? now.toISOString();
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
        pinned,
        access_score,
        composite_score,
        dedupe_key,
        created_at,
        updated_at,
        last_accessed_at,
        access_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?, ?)
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
      args.confidence ?? 1,
      args.observationCount ?? 1,
      args.status ?? "promoted",
      args.pinned ? 1 : 0,
      args.accessScore ?? 0,
      args.compositeScore ?? 0,
      content.toLowerCase(),
      createdAt,
      updatedAt,
      lastAccessedAt,
      args.accessCount ?? 0,
    ],
  );

  return id;
}

function insertRun(db: AdeDb, now: Date, runId: string) {
  const nowIso = now.toISOString();
  db.run(
    `
      INSERT INTO missions (
        id,
        project_id,
        title,
        prompt,
        status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'in_progress', ?, ?)
    `,
    [`mission-${runId}`, PROJECT_ID, `Mission ${runId}`, `Prompt ${runId}`, nowIso, nowIso],
  );
  db.run(
    `
      INSERT INTO orchestrator_runs (
        id,
        project_id,
        mission_id,
        status,
        context_profile,
        scheduler_state,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, 'running', 'orchestrator_deterministic_v1', 'active', ?, ?)
    `,
    [runId, PROJECT_ID, `mission-${runId}`, nowIso, nowIso],
  );
}

function insertSweepLog(db: AdeDb, args: { sweepId?: string; completedAt: string; startedAt?: string }) {
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
      ) VALUES (?, ?, 'manual', ?, ?, 0, 0, 0, 0, 0, 1)
    `,
    [args.sweepId ?? randomUUID(), PROJECT_ID, args.startedAt ?? args.completedAt, args.completedAt],
  );
}

function getMemory(db: AdeDb, id: string) {
  return db.get<Record<string, unknown>>("select * from unified_memories where id = ?", [id]);
}

function getActiveScopeCount(db: AdeDb, scope: "project" | "agent" | "mission", scopeOwnerId = "") {
  const row = db.get<{ count: number }>(
    `
      select count(*) as count
      from unified_memories
      where project_id = ?
        and scope = ?
        and coalesce(scope_owner_id, '') = ?
        and status != 'archived'
    `,
    [PROJECT_ID, scope, scopeOwnerId],
  );
  return Number(row?.count ?? 0);
}

describe("memoryLifecycleService", () => {
  it("decays access_score using the half-life formula", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      accessScore: 1,
      lastAccessedAt: daysAgoIso(fixture.now, 30),
    });

    const result = await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(result.entriesDecayed).toBe(1);
    expect(Number(row?.access_score ?? 0)).toBeCloseTo(0.5, 6);
  });

  it("skips temporal decay for tier 1 entries", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      tier: 1,
      pinned: true,
      accessScore: 0.75,
      lastAccessedAt: daysAgoIso(fixture.now, 120),
    });

    await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(Number(row?.access_score ?? 0)).toBeCloseTo(0.75, 6);
  });

  it("skips temporal decay for evergreen preference and convention memories", async () => {
    const fixture = await createFixture();
    const preferenceId = insertMemory(fixture.db, fixture.now, {
      category: "preference",
      importance: "high",
      accessScore: 0.9,
      lastAccessedAt: daysAgoIso(fixture.now, 90),
    });
    const conventionId = insertMemory(fixture.db, fixture.now, {
      category: "convention",
      importance: "high",
      accessScore: 0.8,
      lastAccessedAt: daysAgoIso(fixture.now, 60),
    });

    await fixture.service.runSweep();

    expect(Number(getMemory(fixture.db, preferenceId)?.access_score ?? 0)).toBeCloseTo(0.9, 6);
    expect(Number(getMemory(fixture.db, conventionId)?.access_score ?? 0)).toBeCloseTo(0.8, 6);
  });

  it("demotes tier 2 entries after 90 days", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      tier: 2,
      lastAccessedAt: daysAgoIso(fixture.now, 91),
      accessScore: 1,
    });

    const result = await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(result.entriesDemoted).toBe(1);
    expect(row?.tier).toBe(3);
  });

  it("archives tier 3 entries after 180 days", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      tier: 3,
      status: "promoted",
      lastAccessedAt: daysAgoIso(fixture.now, 181),
      accessScore: 0.4,
    });

    const result = await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(result.entriesArchived).toBe(1);
    expect(row?.status).toBe("archived");
  });

  it("auto-promotes high-confidence candidates with repeated observations", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      tier: 3,
      status: "candidate",
      confidence: 0.7,
      observationCount: 2,
      accessScore: 0.2,
    });

    const result = await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(result.entriesPromoted).toBe(1);
    expect(row?.status).toBe("promoted");
    expect(row?.tier).toBe(2);
    expect(typeof row?.promoted_at).toBe("string");
  });

  it("auto-archives low-confidence old candidates", async () => {
    const fixture = await createFixture();
    const id = insertMemory(fixture.db, fixture.now, {
      tier: 3,
      status: "candidate",
      confidence: 0.2,
      accessScore: 0.2,
      createdAt: daysAgoIso(fixture.now, 31),
      updatedAt: daysAgoIso(fixture.now, 31),
      lastAccessedAt: daysAgoIso(fixture.now, 1),
    });

    const result = await fixture.service.runSweep();
    const row = getMemory(fixture.db, id);

    expect(result.entriesArchived).toBe(1);
    expect(row?.status).toBe("archived");
  });

  it("enforces the project scope hard limit by archiving the lowest-scoring tier 3 entry", async () => {
    const fixture = await createFixture();
    let lowestId = "";
    for (let index = 0; index < 2001; index += 1) {
      const id = insertMemory(fixture.db, fixture.now, {
        scope: "project",
        tier: 3,
        status: "promoted",
        accessScore: index === 0 ? 0.01 : 0.5 + index / 5000,
        createdAt: daysAgoIso(fixture.now, 5),
        updatedAt: daysAgoIso(fixture.now, 5),
        lastAccessedAt: daysAgoIso(fixture.now, 5),
      });
      if (index === 0) lowestId = id;
    }

    const result = await fixture.service.runSweep();

    expect(result.entriesArchived).toBe(1);
    expect(getActiveScopeCount(fixture.db, "project")).toBe(2000);
    expect(getMemory(fixture.db, lowestId)?.status).toBe("archived");
  });

  it("enforces the agent scope hard limit per scope owner", async () => {
    const fixture = await createFixture();
    let lowestId = "";
    for (let index = 0; index < 501; index += 1) {
      const id = insertMemory(fixture.db, fixture.now, {
        scope: "agent",
        scopeOwnerId: "agent-1",
        tier: 3,
        status: "promoted",
        accessScore: index === 0 ? 0.01 : 0.4 + index / 1000,
      });
      if (index === 0) lowestId = id;
    }

    await fixture.service.runSweep();

    expect(getActiveScopeCount(fixture.db, "agent", "agent-1")).toBe(500);
    expect(getMemory(fixture.db, lowestId)?.status).toBe("archived");
  });

  it("enforces the mission scope hard limit per mission run", async () => {
    const fixture = await createFixture();
    insertRun(fixture.db, fixture.now, "run-1");
    let lowestId = "";
    for (let index = 0; index < 201; index += 1) {
      const id = insertMemory(fixture.db, fixture.now, {
        scope: "mission",
        scopeOwnerId: "run-1",
        tier: 3,
        status: "promoted",
        accessScore: index === 0 ? 0.01 : 0.4 + index / 1000,
      });
      if (index === 0) lowestId = id;
    }

    await fixture.service.runSweep();

    expect(getActiveScopeCount(fixture.db, "mission", "run-1")).toBe(200);
    expect(getMemory(fixture.db, lowestId)?.status).toBe("archived");
  });

  it("archives mission-scoped memories whose orchestrator run no longer exists", async () => {
    const fixture = await createFixture();
    const orphanId = insertMemory(fixture.db, fixture.now, {
      scope: "mission",
      scopeOwnerId: "missing-run",
      tier: 2,
      status: "promoted",
      accessScore: 0.8,
    });
    insertRun(fixture.db, fixture.now, "run-1");
    insertMemory(fixture.db, fixture.now, {
      scope: "mission",
      scopeOwnerId: "run-1",
      tier: 2,
      status: "promoted",
      accessScore: 0.8,
    });

    const result = await fixture.service.runSweep();

    expect(result.entriesOrphaned).toBe(1);
    expect(getMemory(fixture.db, orphanId)?.status).toBe("archived");
  });

  it("runs a startup sweep only when the last sweep is older than 24 hours", async () => {
    const staleFixture = await createFixture();
    const staleId = insertMemory(staleFixture.db, staleFixture.now, {
      accessScore: 1,
      lastAccessedAt: daysAgoIso(staleFixture.now, 30),
    });
    insertSweepLog(staleFixture.db, { completedAt: daysAgoIso(staleFixture.now, 2) });

    const staleResult = await staleFixture.service.runStartupSweepIfDue();

    expect(staleResult).not.toBeNull();
    expect(Number(getMemory(staleFixture.db, staleId)?.access_score ?? 0)).toBeCloseTo(0.5, 6);

    const freshFixture = await createFixture();
    const freshId = insertMemory(freshFixture.db, freshFixture.now, {
      accessScore: 1,
      lastAccessedAt: daysAgoIso(freshFixture.now, 30),
    });
    insertSweepLog(freshFixture.db, { completedAt: daysAgoIso(freshFixture.now, 0.5) });

    const freshResult = await freshFixture.service.runStartupSweepIfDue();

    expect(freshResult).toBeNull();
    expect(Number(getMemory(freshFixture.db, freshId)?.access_score ?? 0)).toBeCloseTo(1, 6);
  });

  it("records sweep logs with accurate counts and emits status events", async () => {
    const fixture = await createFixture();

    insertMemory(fixture.db, fixture.now, {
      id: "decayed",
      tier: 2,
      status: "promoted",
      accessScore: 1,
      lastAccessedAt: daysAgoIso(fixture.now, 30),
    });
    insertMemory(fixture.db, fixture.now, {
      id: "demoted",
      tier: 2,
      status: "promoted",
      accessScore: 1,
      lastAccessedAt: daysAgoIso(fixture.now, 91),
    });
    insertMemory(fixture.db, fixture.now, {
      id: "promoted",
      tier: 3,
      status: "candidate",
      confidence: 0.8,
      observationCount: 2,
      accessScore: 0.2,
    });
    insertMemory(fixture.db, fixture.now, {
      id: "candidate-archive",
      tier: 3,
      status: "candidate",
      confidence: 0.2,
      accessScore: 0.2,
      createdAt: daysAgoIso(fixture.now, 31),
      updatedAt: daysAgoIso(fixture.now, 31),
      lastAccessedAt: daysAgoIso(fixture.now, 1),
    });
    insertMemory(fixture.db, fixture.now, {
      id: "orphan",
      scope: "mission",
      scopeOwnerId: "missing-run",
      tier: 2,
      status: "promoted",
      accessScore: 0.5,
    });

    const result = await fixture.service.runSweep();
    const logRow = fixture.db.get<Record<string, unknown>>(
      "select * from memory_sweep_log where sweep_id = ?",
      [result.sweepId],
    );

    expect(result.entriesDecayed).toBe(3);
    expect(result.entriesDemoted).toBe(1);
    expect(result.entriesPromoted).toBe(1);
    expect(result.entriesArchived).toBe(2);
    expect(result.entriesOrphaned).toBe(1);
    expect(logRow).toMatchObject({
      entries_decayed: 3,
      entries_demoted: 1,
      entries_promoted: 1,
      entries_archived: 2,
      entries_orphaned: 1,
    });
    expect(Number(logRow?.duration_ms ?? 0)).toBeGreaterThanOrEqual(0);
    expect(fixture.events.map((event) => event.type)).toEqual([
      "memory-sweep-started",
      "memory-sweep-completed",
    ]);
  });
});
