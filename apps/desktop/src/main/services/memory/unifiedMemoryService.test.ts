import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createUnifiedMemoryService } from "./unifiedMemoryService";

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
    memoryService: createUnifiedMemoryService(db),
  };
}

describe("unifiedMemoryService", () => {
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
});
