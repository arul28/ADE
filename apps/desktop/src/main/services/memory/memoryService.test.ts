import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createMemoryService, resolveAgentMemoryWritePolicy } from "./memoryService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-unified-memory-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const now = "2026-03-05T12:00:00.000Z";

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    ["project-1", root, "ADE", "main", now, now]
  );

  return {
    db,
    memoryService: createMemoryService(db),
  };
}

describe("memoryService", () => {
  it("scopes mission memories by scope owner id", async () => {
    const { memoryService } = await createFixture();

    memoryService.addMemory({
      projectId: "project-1",
      scope: "mission",
      scopeOwnerId: "run-1",
      category: "fact",
      content: "Mission A uses the staging mirror.",
      importance: "high",
      sourceRunId: "run-1",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "mission",
      scopeOwnerId: "run-2",
      category: "fact",
      content: "Mission B requires the production seed.",
      importance: "high",
      sourceRunId: "run-2",
    });

    const runOne = await memoryService.searchMemories(
      "mission",
      "project-1",
      "mission",
      10,
      "promoted",
      "run-1"
    );
    const runTwo = await memoryService.searchMemories(
      "mission",
      "project-1",
      "mission",
      10,
      "promoted",
      "run-2"
    );

    expect(runOne).toHaveLength(1);
    expect(runOne[0]?.content).toContain("staging mirror");
    expect(runTwo).toHaveLength(1);
    expect(runTwo[0]?.content).toContain("production seed");
  });

  it("pins memories into tier 1 without relying on promote", async () => {
    const { memoryService } = await createFixture();

    const memory = memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "pattern",
      content: "Run focused tests before integration merges.",
      importance: "high",
    });

    expect(memory.pinned).toBe(false);
    expect(memory.tier).toBe(2);

    const pinned = memoryService.pinMemory(memory.id);

    expect(pinned?.pinned).toBe(true);
    expect(pinned?.tier).toBe(1);
  });

  it("filters budget retrieval by scope and scope owner id", async () => {
    const { memoryService } = await createFixture();

    memoryService.addMemory({
      projectId: "project-1",
      scope: "project",
      category: "decision",
      content: "Project-level memory",
      importance: "high",
    });
    memoryService.addMemory({
      projectId: "project-1",
      scope: "mission",
      scopeOwnerId: "run-1",
      category: "decision",
      content: "Mission-specific memory",
      importance: "high",
      sourceRunId: "run-1",
    });

    const missionBudget = memoryService.getMemoryBudget("project-1", "deep", {
      scope: "mission",
      scopeOwnerId: "run-1",
    });

    expect(missionBudget).toHaveLength(1);
    expect(missionBudget[0]?.scope).toBe("mission");
    expect(missionBudget[0]?.scopeOwnerId).toBe("run-1");
  });

  it("rejects memory writes that are obviously derivable from code or raw logs", async () => {
    const { memoryService } = await createFixture();

    const result = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "fact",
      content: [
        "Error: Build failed",
        "    at build (src/build.ts:12:3)",
        "    at main (src/main.ts:40:2)",
      ].join("\n"),
      importance: "medium",
      status: "candidate",
      confidence: 0.6,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("raw stack trace");
  });

  it("rejects raw automated review output instead of saving it as memory", async () => {
    const { memoryService } = await createFixture();

    const result = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "** ![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat) Fall back to pull on branch divergence**",
      importance: "high",
      status: "candidate",
      confidence: 0.6,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("raw review output");
  });

  it("rejects prompt questions instead of treating them as conventions", async () => {
    const { memoryService } = await createFixture();

    const result = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "What should this test mission accomplish?",
      importance: "medium",
      status: "candidate",
      confidence: 0.6,
    });

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain("prompt question");
  });

  it("lexical memory search matches relevant query terms without requiring every prompt word", async () => {
    const { memoryService } = await createFixture();

    const write = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "Always update snapshot coverage when changing prompt templates.",
      importance: "high",
      status: "promoted",
      tier: 2,
      confidence: 0.9,
    });
    expect(write.accepted).toBe(true);

    const hits = await memoryService.search({
      projectId: "project-1",
      scope: "project",
      status: "promoted",
      query: "please debug the failing renderer test before changing prompt snapshots",
      mode: "lexical",
      limit: 5,
    });

    expect(hits.map((memory) => memory.id)).toContain(write.memory?.id);
  });

  it("indexes file-scoped memory entities and retrieves them by file path", async () => {
    const { db, memoryService } = await createFixture();

    const write = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "gotcha",
      content: "Changing prompt rendering requires snapshot coverage because renderer prompts are cached.",
      fileScopePattern: "apps/desktop/src/main/services/ai/tools/systemPrompt.ts",
      importance: "high",
      status: "promoted",
      tier: 2,
      confidence: 0.9,
    });
    expect(write.accepted).toBe(true);
    expect(write.memory?.id).toBeTruthy();
    const memoryId = write.memory!.id;

    const links = db.get<{ count: number }>(
      "select count(*) as count from memory_entity_links where memory_id = ?",
      [memoryId],
    )?.count ?? 0;
    expect(links).toBeGreaterThan(0);

    const hits = await memoryService.search({
      projectId: "project-1",
      scope: "project",
      status: "promoted",
      query: "apps/desktop/src/main/services/ai/tools/systemPrompt.ts",
      mode: "lexical",
      limit: 5,
    });

    expect(hits.map((memory) => memory.id)).toContain(memoryId);
  });

  it("records bounded retrieval telemetry for memory use", async () => {
    const { db, memoryService } = await createFixture();

    const write = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "decision",
      content: "Decision: route agent memory through a central planner before mutating tools.",
      importance: "high",
      status: "promoted",
      tier: 2,
      confidence: 0.9,
    });
    expect(write.accepted).toBe(true);

    const hits = await memoryService.search({
      projectId: "project-1",
      scope: "project",
      status: "promoted",
      query: "central planner mutating tools",
      recordRetrieval: true,
      retrievalSourceType: "unit_test",
      injectedMemoryIds: write.memory?.id ? [write.memory.id] : [],
      limit: 5,
    });

    expect(hits.map((memory) => memory.id)).toContain(write.memory?.id);
    const ledger = db.get<Record<string, unknown>>(
      "select * from memory_retrieval_ledger where project_id = ? order by created_at desc limit 1",
      ["project-1"],
    );
    expect(ledger?.source_type).toBe("unit_test");
    expect(ledger?.injected_count).toBe(1);
    expect(String(ledger?.top_memory_ids_json ?? "")).toContain(write.memory?.id ?? "");

    const stats = memoryService.getMemoryHealthStats("project-1");
    expect(stats.recentRetrievals).toBeGreaterThan(0);
    expect(stats.recentInjectedMemories).toBeGreaterThan(0);
  });

  it("can rebuild entity links for existing active memories", async () => {
    const { db, memoryService } = await createFixture();

    const write = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "Convention: WorkViewArea keeps open chat tabs mounted during route changes.",
      fileScopePattern: "apps/desktop/src/renderer/components/work/WorkViewArea.tsx",
      importance: "high",
      status: "promoted",
      tier: 2,
      confidence: 0.9,
    });
    expect(write.accepted).toBe(true);
    expect(write.memory?.id).toBeTruthy();
    db.run("delete from memory_entity_links where memory_id = ?", [write.memory!.id]);

    const result = memoryService.reindexMemoryEntities("project-1");

    expect(result.indexedMemories).toBeGreaterThan(0);
    expect(result.entityLinkCount).toBeGreaterThan(0);
    expect(memoryService.getMemoryHealthStats("project-1").memoriesMissingEntityLinks).toBe(0);
  });

  it("keeps default agent memory writes as reviewable candidates unless pinned or strict", () => {
    expect(resolveAgentMemoryWritePolicy({ writeGateMode: "default" })).toEqual({
      status: "candidate",
      tier: 3,
      confidence: 0.6,
    });
    expect(resolveAgentMemoryWritePolicy({ writeGateMode: "strict" })).toEqual({
      status: "promoted",
      tier: 2,
      confidence: 0.9,
    });
    expect(resolveAgentMemoryWritePolicy({ pin: true, writeGateMode: "default" })).toEqual({
      status: "promoted",
      tier: 1,
      confidence: 1,
    });
  });

  it("dedupes repeated candidate memories instead of accumulating identical pending rows", async () => {
    const { memoryService } = await createFixture();

    const first = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "Always add coverage when changing validation logic.",
      importance: "medium",
      status: "candidate",
      tier: 3,
      confidence: 0.6,
      sourceType: "system",
      sourceId: "pr:1:comment:1",
    });
    const second = memoryService.writeMemory({
      projectId: "project-1",
      scope: "project",
      category: "convention",
      content: "Always add coverage when changing validation logic.",
      importance: "medium",
      status: "candidate",
      tier: 3,
      confidence: 0.6,
      sourceType: "system",
      sourceId: "pr:2:comment:1",
    });

    const memories = memoryService.listMemories({
      projectId: "project-1",
      scope: "project",
      status: "candidate",
      limit: 20,
    });

    expect(first.accepted).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.mergedIntoId).toBe(first.memory?.id);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.observationCount).toBe(2);
  });
});
