import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { createMemoryRepairService } from "./memoryRepairService";

const PROJECT_ID = "project-1";
const NOW_ISO = "2026-03-24T12:00:00.000Z";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-memory-repair-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [PROJECT_ID, root, "ADE", "main", NOW_ISO, NOW_ISO],
  );

  return {
    db,
    service: createMemoryRepairService({
      db,
      projectId: PROJECT_ID,
      logger: createLogger() as any,
    }),
  };
}

function insertMemory(db: AdeDb, args: {
  id?: string;
  category: string;
  content: string;
  status?: "candidate" | "promoted" | "archived";
  sourceId?: string | null;
  sourceType?: string;
}) {
  const id = args.id ?? randomUUID();
  db.run(
    `
      insert into unified_memories(
        id, project_id, scope, scope_owner_id, tier, category, content, importance, confidence,
        observation_count, status, source_type, source_id, pinned, access_score, composite_score,
        write_gate_reason, dedupe_key, created_at, updated_at, last_accessed_at, access_count, promoted_at
      ) values (?, ?, 'project', null, 2, ?, ?, 'medium', 0.8, 1, ?, ?, ?, 0, 0, 0, null, ?, ?, ?, ?, 0, ?)
    `,
    [
      id,
      PROJECT_ID,
      args.category,
      args.content,
      args.status ?? "candidate",
      args.sourceType ?? "system",
      args.sourceId ?? null,
      args.content.toLowerCase(),
      NOW_ISO,
      NOW_ISO,
      NOW_ISO,
      args.status === "promoted" ? NOW_ISO : null,
    ],
  );
  return id;
}

function insertPrFeedbackLedger(db: AdeDb, args: { memoryId?: string | null; episodeMemoryId?: string | null }) {
  db.run(
    `
      insert into memory_capture_ledger(
        id, project_id, source_type, source_key, memory_id, episode_memory_id, metadata_json, created_at, updated_at
      ) values (?, ?, 'pr_feedback', ?, ?, ?, null, ?, ?)
    `,
    [randomUUID(), PROJECT_ID, randomUUID(), args.memoryId ?? null, args.episodeMemoryId ?? null, NOW_ISO, NOW_ISO],
  );
}

function getMemoryRow(db: AdeDb, id: string) {
  return db.get<{ content: string; status: string }>(
    "select content, status from unified_memories where id = ?",
    [id],
  );
}

describe("memoryRepairService", () => {
  it("rewrites legacy episodes and archives low-value PR feedback memory", async () => {
    const fixture = await createFixture();

    const normalEpisodeId = insertMemory(fixture.db, {
      category: "episode",
      status: "promoted",
      sourceId: "system:session-1",
      content: JSON.stringify({
        id: "episode-1",
        sessionId: "session-1",
        taskDescription: "Investigated flaky integration test",
        approachTaken: "Traced the race to a missing await in the harness.",
        outcome: "success",
        patternsDiscovered: ["Harness setup must await DB seed completion."],
        gotchas: ["Flaky failures only reproduce with parallel workers."],
        decisionsMade: ["Keep the explicit await in the harness bootstrap."],
        toolsUsed: ["vitest"],
        duration: 240,
        createdAt: NOW_ISO,
      }),
    });

    const prEpisodeId = insertMemory(fixture.db, {
      category: "episode",
      status: "promoted",
      sourceId: "pr_feedback:comment:1",
      content: JSON.stringify({
        id: "episode-2",
        sessionId: "pr:1",
        taskDescription: "PR feedback for #1",
        approachTaken: "Preview deployment for your docs.",
        outcome: "partial",
        patternsDiscovered: ["Preview deployment for your docs."],
        gotchas: [],
        decisionsMade: [],
        toolsUsed: [],
        duration: 0,
        createdAt: NOW_ISO,
      }),
    });

    const lowValueMemoryId = insertMemory(fixture.db, {
      category: "pattern",
      sourceId: "pr:1:comment:1",
      content: "Preview deployment for your docs.",
    });
    const durablePrFeedbackMemoryId = insertMemory(fixture.db, {
      category: "convention",
      sourceId: "pr:1:comment:2",
      content: "Always add coverage when changing validation logic.",
    });
    const lowValueProcedureId = insertMemory(fixture.db, {
      category: "procedure",
      sourceId: prEpisodeId,
      content: "Trigger: preview deployment for your docs\n\n## Recommended Procedure\n1. Preview deployment for your docs.",
    });

    insertPrFeedbackLedger(fixture.db, { memoryId: lowValueMemoryId, episodeMemoryId: prEpisodeId });
    insertPrFeedbackLedger(fixture.db, { memoryId: durablePrFeedbackMemoryId });
    fixture.db.run(
      "insert into memory_procedure_sources(procedure_memory_id, episode_memory_id) values (?, ?)",
      [lowValueProcedureId, prEpisodeId],
    );

    const result = fixture.service.runRepair();

    expect(result.repairedLegacyEpisodes).toBe(2);
    expect(result.archivedPrFeedbackEpisodes).toBe(1);
    expect(result.archivedLowValuePrFeedbackMemories).toBe(1);
    expect(result.archivedDerivedProcedures).toBe(1);

    expect(getMemoryRow(fixture.db, normalEpisodeId)?.content).toContain("<!--episode:");
    expect(getMemoryRow(fixture.db, prEpisodeId)?.status).toBe("archived");
    expect(getMemoryRow(fixture.db, lowValueMemoryId)?.status).toBe("archived");
    expect(getMemoryRow(fixture.db, durablePrFeedbackMemoryId)?.status).toBe("candidate");
    expect(getMemoryRow(fixture.db, lowValueProcedureId)?.status).toBe("archived");
  });
});
