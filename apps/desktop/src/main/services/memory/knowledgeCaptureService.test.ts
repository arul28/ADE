import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createUnifiedMemoryService } from "./unifiedMemoryService";
import { createProceduralLearningService } from "./proceduralLearningService";
import { createKnowledgeCaptureService } from "./knowledgeCaptureService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-knowledge-capture-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const projectId = "project-1";
  const now = "2026-03-11T12:00:00.000Z";

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, root, "ADE", "main", now, now],
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
    root,
    memoryService,
    proceduralLearningService,
  };
}

describe("knowledgeCaptureService", () => {
  it("captures a resolved intervention as candidate memory plus companion episode", async () => {
    const fixture = await createFixture();
    const onEpisodeSaved = vi.fn().mockResolvedValue(undefined);
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: { onEpisodeSaved },
    });

    await service.captureResolvedIntervention({
      missionId: "mission-1",
      intervention: {
        id: "int-1",
        interventionType: "manual_input",
        status: "resolved",
        title: "Reviewer guidance",
        body: "Please preserve the repo naming convention.",
        resolutionNote: "Always preserve the repo naming convention when touching these generators.",
        metadata: {
          runId: "run-1",
          stepId: "step-1",
          fileScopes: ["src/generators/**"],
        },
      },
    });

    const conventionMemories = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      categories: ["convention"],
      status: ["candidate", "promoted"],
      limit: 20,
    });
    const episodes = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      categories: ["episode"],
      limit: 20,
    });

    expect(conventionMemories).toHaveLength(1);
    expect(conventionMemories[0]?.fileScopePattern).toBe("src/generators/**");
    expect(episodes).toHaveLength(1);
    expect(onEpisodeSaved).toHaveBeenCalledWith(episodes[0]?.id);
  });

  it("ignores duplicate intervention captures on replay", async () => {
    const fixture = await createFixture();
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: { onEpisodeSaved: vi.fn().mockResolvedValue(undefined) },
    });

    const input = {
      missionId: "mission-1",
      intervention: {
        id: "int-dup",
        interventionType: "manual_input",
        status: "resolved",
        title: "Retry guidance",
        body: "Prefer the focused worker plan.",
        resolutionNote: "Prefer the focused worker plan for follow-up retries.",
        metadata: { runId: "run-1" },
      },
    } as const;

    await service.captureResolvedIntervention(input);
    const firstCount = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      status: ["candidate", "promoted"],
      limit: 20,
    }).filter((memory) => memory.sourceId === "intervention:int-dup").length;
    await service.captureResolvedIntervention(input);

    const memories = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      status: ["candidate", "promoted"],
      limit: 20,
    });
    const ledgerRows = fixture.db.all<{ source_key: string }>(
      "select source_key from memory_capture_ledger where project_id = ? and source_type = 'intervention'",
      [fixture.projectId],
    );

    expect(memories.filter((memory) => memory.sourceId === "intervention:int-dup")).toHaveLength(firstCount);
    expect(ledgerRows).toHaveLength(1);
  });

  it("promotes recurring gotchas after repeated failures across runs", async () => {
    const fixture = await createFixture();
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: { onEpisodeSaved: vi.fn().mockResolvedValue(undefined) },
    });

    await service.captureFailureGotcha({
      missionId: "mission-1",
      runId: "run-1",
      attemptId: "attempt-1",
      stepId: "step-1",
      summary: "Snapshot mismatch after prompt template changes",
      errorMessage: "Updating prompt templates without snapshots breaks reviewers",
      fileScopePattern: "src/prompts/**",
    });
    await service.captureFailureGotcha({
      missionId: "mission-2",
      runId: "run-2",
      attemptId: "attempt-2",
      stepId: "step-1",
      summary: "Snapshot mismatch after prompt template changes",
      errorMessage: "Updating prompt templates without snapshots breaks reviewers",
      fileScopePattern: "src/prompts/**",
    });
    await service.captureFailureGotcha({
      missionId: "mission-3",
      runId: "run-3",
      attemptId: "attempt-3",
      stepId: "step-2",
      summary: "Snapshot mismatch after prompt template changes",
      errorMessage: "Updating prompt templates without snapshots breaks reviewers",
      fileScopePattern: "src/prompts/**",
    });

    const promotedGotchas = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      categories: ["gotcha"],
      status: "promoted",
      limit: 20,
    });
    const clusterLedger = fixture.db.get<{ source_key: string }>(
      "select source_key from memory_capture_ledger where project_id = ? and source_type = 'error_cluster' limit 1",
      [fixture.projectId],
    );

    expect(promotedGotchas.some((memory) => memory.confidence >= 0.8 && memory.importance === "high")).toBe(true);
    expect(clusterLedger?.source_key).toContain("cluster:");
  });

  it("captures PR review feedback with file scope provenance", async () => {
    const fixture = await createFixture();
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: { onEpisodeSaved: vi.fn().mockResolvedValue(undefined) },
      prService: {
        getComments: async () => [
          {
            id: "comment-1",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Always add coverage when changing validation logic.",
            source: "review",
            url: null,
            path: "src/validation/rules.ts",
            line: 14,
            createdAt: null,
            updatedAt: null,
          },
        ],
        getReviews: async () => [
          {
            reviewer: "lead",
            reviewerAvatarUrl: null,
            state: "changes_requested",
            body: "This breaks the fallback path unless we preserve the older branch logic.",
            submittedAt: "2026-03-11T13:00:00.000Z",
          },
        ],
      },
    });

    await service.capturePrFeedback({ prId: "pr-1", prNumber: 42 });

    const memories = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      status: ["candidate", "promoted"],
      limit: 20,
    });
    const episodes = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      categories: ["episode"],
      limit: 20,
    });

    expect(memories.some((memory) => memory.fileScopePattern === "src/validation/rules.ts")).toBe(true);
    expect(memories.some((memory) => memory.category === "gotcha" || memory.category === "convention")).toBe(true);
    expect(episodes).toHaveLength(0);
  });

  it("ignores low-signal PR nudges that should not become durable memory", async () => {
    const fixture = await createFixture();
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: { onEpisodeSaved: vi.fn().mockResolvedValue(undefined) },
      prService: {
        getComments: async () => [
          {
            id: "comment-link",
            author: "reviewer",
            authorAvatarUrl: null,
            body: "Learn more about https://vercel.link/github-learn-more",
            source: "issue",
            url: null,
            path: null,
            line: null,
            createdAt: null,
            updatedAt: null,
          },
        ],
        getReviews: async () => [
          {
            reviewer: "lead",
            reviewerAvatarUrl: null,
            state: "commented",
            body: "Preview deployment for your docs.",
            submittedAt: "2026-03-11T13:00:00.000Z",
          },
        ],
      },
    });

    await service.capturePrFeedback({ prId: "pr-2", prNumber: 43 });

    const memories = fixture.memoryService.listMemories({
      projectId: fixture.projectId,
      scope: "project",
      status: ["candidate", "promoted"],
      limit: 20,
    });

    expect(memories).toHaveLength(0);
  });

  it("feeds repeated intervention captures into procedural learning", async () => {
    const fixture = await createFixture();
    const service = createKnowledgeCaptureService({
      db: fixture.db,
      projectId: fixture.projectId,
      memoryService: fixture.memoryService,
      proceduralLearningService: fixture.proceduralLearningService,
    });

    for (const index of [1, 2, 3]) {
      await service.captureResolvedIntervention({
        missionId: `mission-${index}`,
        intervention: {
          id: `int-proc-${index}`,
          interventionType: "manual_input",
          status: "resolved",
          title: "Testing guidance",
          body: "Please keep snapshot coverage aligned with prompt changes.",
          resolutionNote: "Always update snapshot coverage when changing prompt templates.",
          metadata: {
            runId: `run-${index}`,
            fileScopes: ["src/prompts/**"],
          },
        },
      });
    }

    const procedures = fixture.proceduralLearningService.listProcedures({
      status: "all",
      scope: "project",
    });
    const searchableConventions = await fixture.memoryService.searchMemories(
      "snapshot coverage prompt templates",
      fixture.projectId,
      "project",
      10,
      ["candidate", "promoted"],
    );

    expect(searchableConventions.length).toBeGreaterThan(0);
    expect(procedures.some((procedure) => procedure.procedural.trigger.includes("update snapshot coverage"))).toBe(true);
  });
});
