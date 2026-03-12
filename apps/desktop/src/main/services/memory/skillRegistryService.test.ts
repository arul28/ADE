import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createUnifiedMemoryService } from "./unifiedMemoryService";
import { createProceduralLearningService } from "./proceduralLearningService";
import { createSkillRegistryService } from "./skillRegistryService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-skill-registry-"));
  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger() as any);
  const projectId = "project-1";
  const now = "2026-03-11T12:00:00.000Z";

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, projectRoot, "ADE", "main", now, now],
  );

  const memoryService = createUnifiedMemoryService(db);
  const proceduralLearningService = createProceduralLearningService({
    db,
    projectId,
    memoryService,
  });

  return {
    db,
    projectId,
    projectRoot,
    memoryService,
    proceduralLearningService,
  };
}

describe("skillRegistryService", () => {
  it("exports richer SKILL.md files with when-to-use, steps, and context sections", async () => {
    const fixture = await createFixture();
    const markExportedSkill = vi.fn();
    const service = createSkillRegistryService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectRoot: fixture.projectRoot,
      memoryService: fixture.memoryService,
      proceduralLearningService: {
        getProcedureDetail: () => ({
          memory: {
            id: "proc-1",
            scope: "project",
            scopeOwnerId: null,
            tier: 2,
            pinned: false,
            category: "procedure",
            content: "Trigger: update snapshots",
            importance: "high",
            createdAt: "2026-03-11T12:00:00.000Z",
            updatedAt: "2026-03-11T12:00:00.000Z",
            lastAccessedAt: "2026-03-11T12:00:00.000Z",
            accessCount: 0,
            observationCount: 1,
            status: "promoted",
            confidence: 0.8,
            embedded: false,
            sourceRunId: null,
            sourceType: "system",
            sourceId: null,
          },
          procedural: {
            id: "proc-1",
            trigger: "updating prompt snapshots",
            procedure: [
              "## Trigger",
              "updating prompt snapshots",
              "",
              "## Recommended Procedure",
              "1. Update the snapshots.",
              "2. Re-run the focused tests.",
              "",
              "## Useful Tools",
              "- npm test",
              "",
              "## Watch Outs",
              "- Avoid stale snapshots.",
            ].join("\n"),
            confidence: 0.8,
            successCount: 3,
            failureCount: 0,
            sourceEpisodeIds: [],
            lastUsed: null,
            createdAt: "2026-03-11T12:00:00.000Z",
          },
          exportedSkillPath: null,
          exportedAt: null,
          supersededByMemoryId: null,
          sourceEpisodes: [],
          confidenceHistory: [],
        }),
        markExportedSkill,
        markProcedureSuperseded: vi.fn(),
      },
    });

    const exported = await service.exportProcedureSkill({ id: "proc-1", name: "Prompt Snapshot Skill" });
    if (!exported) throw new Error("Expected exported skill");

    expect(exported.path).toContain(path.join(".ade", "skills", "prompt-snapshot-skill", "SKILL.md"));
    const content = fs.readFileSync(exported.path, "utf8");
    expect(content).toContain("## When to use");
    expect(content).toContain("Use this when updating prompt snapshots.");
    expect(content).toContain("## Steps");
    expect(content).toContain("1. Update the snapshots.");
    expect(content).toContain("## Context");
    expect(content).toContain("- Watch out: Avoid stale snapshots.");
    expect(markExportedSkill).toHaveBeenCalledWith("proc-1", exported.path);
  });

  it("supersedes near-duplicate system procedures when importing user skills", async () => {
    const fixture = await createFixture();
    const skillPath = path.join(fixture.projectRoot, ".claude", "skills", "testing-guide.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(
      skillPath,
      [
        "Keep snapshot coverage aligned with prompt changes.",
        "",
        "Run the focused snapshot suite before you ask for review.",
      ].join("\n"),
      "utf8",
    );

    const duplicateSystemProcedure = fixture.memoryService.addMemory({
      projectId: fixture.projectId,
      scope: "project",
      category: "procedure",
      content: [
        "Imported skill: testing-guide",
        "",
        "Keep snapshot coverage aligned with prompt changes.",
        "",
        "Run the focused snapshot suite before you ask for review.",
      ].join("\n"),
      importance: "high",
      sourceType: "system",
      sourceId: "system-generated-procedure",
    });

    const service = createSkillRegistryService({
      db: fixture.db,
      projectId: fixture.projectId,
      projectRoot: fixture.projectRoot,
      memoryService: fixture.memoryService,
      proceduralLearningService: fixture.proceduralLearningService,
    });

    const indexed = await service.reindexSkills({ paths: [skillPath] });
    const imported = indexed.find((entry) => entry.path === skillPath);
    if (!imported?.memoryId) throw new Error("Expected imported user skill memory");

    const superseded = fixture.proceduralLearningService.getProcedureDetail(duplicateSystemProcedure.id);
    const duplicateMemory = fixture.memoryService.getMemory(duplicateSystemProcedure.id);

    expect(imported.memoryId).not.toBe(duplicateSystemProcedure.id);
    expect(superseded?.supersededByMemoryId).toBe(imported.memoryId);
    expect(duplicateMemory?.status).toBe("archived");
  });
});
