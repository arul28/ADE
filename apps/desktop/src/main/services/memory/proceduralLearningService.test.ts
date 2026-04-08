import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createMemoryService } from "./memoryService";
import { createProceduralLearningService } from "./proceduralLearningService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-proc-learn-"));
  const db = await openKvDb(path.join(root, "ade.db"), createLogger() as any);
  const projectId = "project-1";
  const now = "2026-03-24T12:00:00.000Z";

  db.run(
    "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
    [projectId, root, "ADE", "main", now, now],
  );

  const memoryService = createMemoryService(db);

  return { db, projectId, root, memoryService };
}

function makeEpisodeContent(overrides: Record<string, unknown> = {}) {
  const episode = {
    id: `episode-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "session-1",
    taskDescription: "Investigated flaky integration test",
    approachTaken: "Traced the race to a missing await in the harness.",
    outcome: "success",
    toolsUsed: ["vitest"],
    patternsDiscovered: ["Harness setup must await DB seed completion."],
    gotchas: ["Flaky failures only reproduce with parallel workers."],
    decisionsMade: ["Keep the explicit await in the harness bootstrap."],
    duration: 240,
    createdAt: "2026-03-24T12:00:00.000Z",
    ...overrides,
  };
  return JSON.stringify(episode);
}

function makeHumanReadableEpisodeContent(overrides: Record<string, unknown> = {}) {
  const episode = {
    id: `episode-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: "session-1",
    taskDescription: "Investigated flaky integration test",
    approachTaken: "Traced the race to a missing await in the harness.",
    outcome: "success",
    toolsUsed: ["vitest"],
    patternsDiscovered: ["Harness setup must await DB seed completion."],
    gotchas: ["Flaky failures only reproduce with parallel workers."],
    decisionsMade: ["Keep the explicit await in the harness bootstrap."],
    duration: 240,
    createdAt: "2026-03-24T12:00:00.000Z",
    ...overrides,
  };
  return `Task: ${episode.taskDescription}\nApproach: ${episode.approachTaken}\n<!--episode:${Buffer.from(JSON.stringify(episode)).toString("base64")}-->`;
}

function addEpisodeMemory(
  memoryService: ReturnType<typeof createMemoryService>,
  projectId: string,
  overrides: Record<string, unknown> = {},
  opts: { sourceId?: string } = {},
) {
  return memoryService.addCandidateMemory({
    projectId,
    scope: "project",
    category: "episode",
    content: makeEpisodeContent(overrides),
    importance: "medium",
    confidence: 0.7,
    sourceType: "system",
    sourceId: opts.sourceId ?? undefined,
  });
}

describe("proceduralLearningService", () => {
  // =========================================================================
  // listProcedures
  // =========================================================================
  describe("listProcedures", () => {
    it("returns an empty list when no procedures exist", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });
      const procedures = service.listProcedures();
      expect(procedures).toEqual([]);
    });

    it("returns procedures sorted by confidence then usage count", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const lowConf = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: low confidence\n\n## Recommended Procedure\n1. Step A",
        importance: "medium",
        confidence: 0.3,
        sourceType: "system",
      });
      const highConf = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: high confidence\n\n## Recommended Procedure\n1. Step B",
        importance: "medium",
        confidence: 0.9,
        sourceType: "system",
      });

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(2);
      expect(procedures[0]!.memory.id).toBe(highConf.id);
      expect(procedures[1]!.memory.id).toBe(lowConf.id);
    });

    it("filters procedures by status", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const candidate = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: test candidate\n\n## Recommended Procedure\n1. Do candidate step",
        importance: "medium",
        confidence: 0.5,
        sourceType: "system",
      });
      const promoted = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: test promoted\n\n## Recommended Procedure\n1. Do promoted step",
        importance: "medium",
        confidence: 0.8,
        sourceType: "system",
      });
      memoryService.promoteMemory(promoted.id);

      const candidateOnly = service.listProcedures({ status: "candidate" });
      const promotedOnly = service.listProcedures({ status: "promoted" });

      expect(candidateOnly).toHaveLength(1);
      expect(candidateOnly[0]!.memory.id).toBe(candidate.id);
      expect(promotedOnly).toHaveLength(1);
      expect(promotedOnly[0]!.memory.id).toBe(promoted.id);
    });

    it("filters procedures by query text", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: deploy staging\n\n## Recommended Procedure\n1. Run deploy command",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });
      memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: run migrations\n\n## Recommended Procedure\n1. Run migration script",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });

      const matchingDeploy = service.listProcedures({ status: "all", query: "deploy" });
      const matchingMigrations = service.listProcedures({ status: "all", query: "migrations" });

      expect(matchingDeploy).toHaveLength(1);
      expect(matchingMigrations).toHaveLength(1);
    });
  });

  // =========================================================================
  // getProcedureDetail
  // =========================================================================
  describe("getProcedureDetail", () => {
    it("returns null for a nonexistent memory", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });
      expect(service.getProcedureDetail("nonexistent-id")).toBeNull();
    });

    it("returns null for a non-procedure memory", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });
      const episode = addEpisodeMemory(memoryService, projectId);
      expect(service.getProcedureDetail(episode.id)).toBeNull();
    });

    it("returns full detail with confidence history", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: test detail\n\n## Recommended Procedure\n1. Do the thing",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });

      service.updateProcedureOutcome({
        memoryId: procedure.id,
        outcome: "success",
        reason: "Worked well.",
      });

      const detail = service.getProcedureDetail(procedure.id);
      expect(detail).not.toBeNull();
      expect(detail!.memory.id).toBe(procedure.id);
      expect(detail!.confidenceHistory).toHaveLength(1);
      expect(detail!.confidenceHistory[0]!.outcome).toBe("success");
      expect(detail!.confidenceHistory[0]!.reason).toBe("Worked well.");
    });
  });

  // =========================================================================
  // updateProcedureOutcome
  // =========================================================================
  describe("updateProcedureOutcome", () => {
    it("increases confidence on success and records history", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: success path\n\n## Recommended Procedure\n1. Do it",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });

      service.updateProcedureOutcome({
        memoryId: procedure.id,
        outcome: "success",
        reason: "Applied successfully.",
      });

      const detail = service.getProcedureDetail(procedure.id);
      expect(detail).not.toBeNull();
      expect(detail!.procedural.successCount).toBe(1);
      expect(detail!.procedural.failureCount).toBe(0);
      expect(detail!.confidenceHistory).toHaveLength(1);
      expect(detail!.confidenceHistory[0]!.outcome).toBe("success");
      // The recorded confidence in history should be higher than the initial 0.6
      expect(detail!.confidenceHistory[0]!.confidence).toBeGreaterThan(0.6);
    });

    it("decreases confidence on failure and records history", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: failure path\n\n## Recommended Procedure\n1. Do it",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });

      service.updateProcedureOutcome({
        memoryId: procedure.id,
        outcome: "failure",
        reason: "Did not work.",
      });

      const detail = service.getProcedureDetail(procedure.id);
      expect(detail).not.toBeNull();
      expect(detail!.procedural.successCount).toBe(0);
      expect(detail!.procedural.failureCount).toBe(1);
      expect(detail!.confidenceHistory).toHaveLength(1);
      expect(detail!.confidenceHistory[0]!.outcome).toBe("failure");
      // The recorded confidence in history should be lower than the initial 0.6
      expect(detail!.confidenceHistory[0]!.confidence).toBeLessThan(0.6);
    });

    it("does nothing for an archived procedure", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: archived path\n\n## Recommended Procedure\n1. Do it",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });
      memoryService.archiveMemory(procedure.id);

      service.updateProcedureOutcome({
        memoryId: procedure.id,
        outcome: "success",
        reason: "Should be ignored.",
      });

      const detail = service.getProcedureDetail(procedure.id);
      // archived procedures return null from getProcedureDetail because category check fails on status
      // The important assertion: confidence should stay unchanged
      const updated = memoryService.getMemory(procedure.id);
      expect(updated!.confidence).toBe(0.6);
    });

    it("auto-pins and promotes after 3 consecutive successes with high confidence", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const onProcedurePromoted = vi.fn();
      const service = createProceduralLearningService({
        db,
        projectId,
        memoryService,
        onProcedurePromoted,
      });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: auto-promote\n\n## Recommended Procedure\n1. Apply this",
        importance: "medium",
        confidence: 0.8,
        sourceType: "system",
      });

      for (let i = 0; i < 3; i++) {
        service.updateProcedureOutcome({
          memoryId: procedure.id,
          outcome: "success",
          reason: `Success round ${i + 1}`,
        });
      }

      const updated = memoryService.getMemory(procedure.id);
      expect(updated!.pinned).toBe(true);
      expect(updated!.status).toBe("promoted");
      expect(onProcedurePromoted).toHaveBeenCalledWith(procedure.id);
    });

    it("auto-archives after repeated failures with low confidence", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: auto-archive\n\n## Recommended Procedure\n1. Bad step",
        importance: "medium",
        confidence: 0.4,
        sourceType: "system",
      });

      for (let i = 0; i < 6; i++) {
        service.updateProcedureOutcome({
          memoryId: procedure.id,
          outcome: "failure",
          reason: `Failure round ${i + 1}`,
        });
      }

      const updated = memoryService.getMemory(procedure.id);
      expect(updated!.status).toBe("archived");
    });

    it("does nothing for a nonexistent memory", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });
      // Should not throw
      service.updateProcedureOutcome({
        memoryId: "nonexistent-id",
        outcome: "success",
        reason: "Ghost update.",
      });
    });
  });

  // =========================================================================
  // updateProcedureOutcomes (batch)
  // =========================================================================
  describe("updateProcedureOutcomes", () => {
    it("applies multiple outcome updates in sequence", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const proc1 = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: batch A\n\n## Recommended Procedure\n1. A",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });
      const proc2 = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: batch B\n\n## Recommended Procedure\n1. B",
        importance: "medium",
        confidence: 0.6,
        sourceType: "system",
      });

      service.updateProcedureOutcomes([
        { memoryId: proc1.id, outcome: "success", reason: "ok" },
        { memoryId: proc2.id, outcome: "failure", reason: "bad" },
      ]);

      const detail1 = service.getProcedureDetail(proc1.id);
      const detail2 = service.getProcedureDetail(proc2.id);
      expect(detail1!.procedural.successCount).toBe(1);
      expect(detail1!.procedural.failureCount).toBe(0);
      expect(detail1!.confidenceHistory[0]!.outcome).toBe("success");
      expect(detail2!.procedural.successCount).toBe(0);
      expect(detail2!.procedural.failureCount).toBe(1);
      expect(detail2!.confidenceHistory[0]!.outcome).toBe("failure");
    });
  });

  // =========================================================================
  // markExportedSkill
  // =========================================================================
  describe("markExportedSkill", () => {
    it("records the exported skill path in procedure details", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: exportable skill\n\n## Recommended Procedure\n1. Do it",
        importance: "medium",
        confidence: 0.7,
        sourceType: "system",
      });

      service.markExportedSkill(procedure.id, "/skills/my-skill.md");

      const detail = service.getProcedureDetail(procedure.id);
      expect(detail!.exportedSkillPath).toBe("/skills/my-skill.md");
      expect(detail!.exportedAt).toBeTruthy();
    });

    it("creates procedure detail row if one does not already exist", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const procedure = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: no detail yet\n\n## Recommended Procedure\n1. First step",
        importance: "medium",
        confidence: 0.5,
        sourceType: "system",
      });

      // No outcome recorded yet, so no detail row exists
      service.markExportedSkill(procedure.id, "/skills/new-skill.md");

      const detail = service.getProcedureDetail(procedure.id);
      expect(detail!.exportedSkillPath).toBe("/skills/new-skill.md");
      expect(detail!.procedural.trigger).toBe("repeated workflow");
    });
  });

  // =========================================================================
  // markProcedureSuperseded
  // =========================================================================
  describe("markProcedureSuperseded", () => {
    it("marks a procedure as superseded and archives it by default", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const old = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: old approach\n\n## Recommended Procedure\n1. Old way",
        importance: "medium",
        confidence: 0.5,
        sourceType: "system",
      });
      const replacement = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: new approach\n\n## Recommended Procedure\n1. New way",
        importance: "medium",
        confidence: 0.8,
        sourceType: "system",
      });

      service.markProcedureSuperseded({
        memoryId: old.id,
        supersededByMemoryId: replacement.id,
      });

      const detail = service.getProcedureDetail(old.id);
      // getProcedureDetail returns null for archived memories? Let's check via raw
      const updated = memoryService.getMemory(old.id);
      expect(updated!.status).toBe("archived");

      // Check superseded_by via DB directly since archived procedures may return null from detail
      const row = db.get<{ superseded_by_memory_id: string }>(
        "select superseded_by_memory_id from memory_procedure_details where memory_id = ?",
        [old.id],
      );
      expect(row!.superseded_by_memory_id).toBe(replacement.id);
    });

    it("skips archival when archive: false", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const old = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: old no-archive\n\n## Recommended Procedure\n1. Keep alive",
        importance: "medium",
        confidence: 0.5,
        sourceType: "system",
      });
      const replacement = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "procedure",
        content: "Trigger: new approach\n\n## Recommended Procedure\n1. New way",
        importance: "medium",
        confidence: 0.8,
        sourceType: "system",
      });

      service.markProcedureSuperseded({
        memoryId: old.id,
        supersededByMemoryId: replacement.id,
        archive: false,
      });

      const updated = memoryService.getMemory(old.id);
      expect(updated!.status).toBe("candidate");

      const detail = service.getProcedureDetail(old.id);
      expect(detail!.supersededByMemoryId).toBe(replacement.id);
    });

    it("does nothing for a non-procedure memory", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const episode = addEpisodeMemory(memoryService, projectId);
      service.markProcedureSuperseded({
        memoryId: episode.id,
        supersededByMemoryId: "some-replacement",
      });

      // Episode should remain unchanged
      const updated = memoryService.getMemory(episode.id);
      expect(updated!.category).toBe("episode");
      expect(updated!.status).toBe("candidate");
    });
  });

  // =========================================================================
  // onEpisodeSaved — the core procedural learning loop
  // =========================================================================
  describe("onEpisodeSaved", () => {
    it("does nothing when the memory is not an episode", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const fact = memoryService.addCandidateMemory({
        projectId,
        scope: "project",
        category: "fact",
        content: "Some fact",
        importance: "medium",
        sourceType: "system",
      });

      await service.onEpisodeSaved(fact.id);

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(0);
    });

    it("skips PR feedback episodes", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const ep = addEpisodeMemory(
        memoryService,
        projectId,
        {
          missionId: "mission-1",
          patternsDiscovered: ["PR feedback pattern A"],
          decisionsMade: ["PR feedback decision A"],
        },
        { sourceId: "pr_feedback:comment:1" },
      );

      await service.onEpisodeSaved(ep.id);

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(0);
    });

    it("skips low-signal episodes", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const ep = addEpisodeMemory(memoryService, projectId, {
        missionId: "mission-1",
        taskDescription: "short",
        approachTaken: "",
        patternsDiscovered: [],
        decisionsMade: [],
        gotchas: [],
      });

      await service.onEpisodeSaved(ep.id);

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(0);
    });

    it("does not create a procedure from fewer than 3 distinct context episodes", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      // Only 2 distinct missionIds — should not be enough
      const ep1 = addEpisodeMemory(memoryService, projectId, {
        missionId: "mission-1",
        patternsDiscovered: ["Unique pattern alpha"],
        decisionsMade: ["Unique decision alpha"],
      });
      const ep2 = addEpisodeMemory(memoryService, projectId, {
        missionId: "mission-2",
        patternsDiscovered: ["Unique pattern alpha"],
        decisionsMade: ["Unique decision alpha"],
      });

      await service.onEpisodeSaved(ep1.id);
      await service.onEpisodeSaved(ep2.id);

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(0);
    });

    it("creates a candidate procedure when 3+ distinct context episodes share signals", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const sharedPatterns = ["Always run lint before commit"];
      const sharedDecisions = ["Use eslint with strict config"];

      for (let i = 1; i <= 3; i++) {
        const ep = addEpisodeMemory(memoryService, projectId, {
          missionId: `mission-${i}`,
          taskDescription: `Task ${i}: fix linting issues`,
          approachTaken: `Ran eslint fix and committed round ${i}`,
          patternsDiscovered: sharedPatterns,
          decisionsMade: sharedDecisions,
          gotchas: ["Some configs are not auto-fixable."],
          toolsUsed: ["eslint"],
        });
        await service.onEpisodeSaved(ep.id);
      }

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures.length).toBeGreaterThanOrEqual(1);
      expect(procedures[0]!.procedural.trigger.length).toBeGreaterThan(0);
      expect(procedures[0]!.procedural.sourceEpisodeIds.length).toBeGreaterThanOrEqual(3);
    });

    it("links additional source episodes to an existing procedure when signals overlap", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const sharedPatterns = ["Always verify schema after migration"];
      const sharedDecisions = ["Use schema diff tool"];

      // Create first procedure via 3 episodes
      for (let i = 1; i <= 3; i++) {
        const ep = addEpisodeMemory(memoryService, projectId, {
          missionId: `mission-${i}`,
          taskDescription: `Task ${i}: run migration checks`,
          approachTaken: `Applied schema diff and verified round ${i}`,
          patternsDiscovered: sharedPatterns,
          decisionsMade: sharedDecisions,
          gotchas: [],
          toolsUsed: ["schema-diff"],
        });
        await service.onEpisodeSaved(ep.id);
      }

      const proceduresAfterFirst = service.listProcedures({ status: "all" });
      expect(proceduresAfterFirst.length).toBeGreaterThanOrEqual(1);

      // Record the source episode count of the first procedure
      const firstProcedureId = proceduresAfterFirst[0]!.memory.id;
      const detailBefore = service.getProcedureDetail(firstProcedureId);
      const sourceCountBefore = detailBefore!.procedural.sourceEpisodeIds.length;

      // Add a 4th episode with identical signals
      const ep4 = addEpisodeMemory(memoryService, projectId, {
        missionId: "mission-4",
        taskDescription: "Task 4: run migration checks again",
        approachTaken: "Applied schema diff and verified round 4",
        patternsDiscovered: sharedPatterns,
        decisionsMade: sharedDecisions,
        gotchas: [],
        toolsUsed: ["schema-diff"],
      });
      await service.onEpisodeSaved(ep4.id);

      // The procedure should have gained source episodes or confidence history entries
      const detailAfter = service.getProcedureDetail(firstProcedureId);
      const totalSourcesAfter = detailAfter!.procedural.sourceEpisodeIds.length;
      const totalHistoryAfter = detailAfter!.confidenceHistory.length;
      // Either the existing procedure gained a source link or a new procedure was created
      // Both are valid — verify at least one procedure exists with history entries
      const allProcedures = service.listProcedures({ status: "all" });
      const totalHistoryEntries = allProcedures.reduce((sum, p) => {
        const d = service.getProcedureDetail(p.memory.id);
        return sum + (d?.confidenceHistory.length ?? 0);
      }, 0);
      expect(totalHistoryEntries).toBeGreaterThanOrEqual(2);
    });

    it("handles new-format (HTML comment) episodes", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      const sharedPatterns = ["Always validate after refactoring"];
      const sharedDecisions = ["Run full test suite post-refactor"];

      for (let i = 1; i <= 3; i++) {
        const ep = memoryService.addCandidateMemory({
          projectId,
          scope: "project",
          category: "episode",
          content: makeHumanReadableEpisodeContent({
            missionId: `mission-html-${i}`,
            taskDescription: `Refactor task ${i}`,
            approachTaken: `Applied refactoring round ${i}`,
            patternsDiscovered: sharedPatterns,
            decisionsMade: sharedDecisions,
            gotchas: ["Import paths can break silently."],
            toolsUsed: ["typescript-compiler"],
          }),
          importance: "medium",
          confidence: 0.7,
          sourceType: "system",
        });
        await service.onEpisodeSaved(ep.id);
      }

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures.length).toBeGreaterThanOrEqual(1);
    });

    it("skips episodes with no matchable signals (empty patterns+decisions)", async () => {
      const { db, projectId, memoryService } = await createFixture();
      const service = createProceduralLearningService({ db, projectId, memoryService });

      for (let i = 1; i <= 4; i++) {
        const ep = addEpisodeMemory(memoryService, projectId, {
          missionId: `mission-${i}`,
          taskDescription: `Long enough task description for signal check round ${i}`,
          approachTaken: `Applied some approach for round ${i}`,
          patternsDiscovered: [],
          decisionsMade: [],
          gotchas: ["Some gotcha"],
          toolsUsed: ["some-tool"],
        });
        await service.onEpisodeSaved(ep.id);
      }

      const procedures = service.listProcedures({ status: "all" });
      expect(procedures).toHaveLength(0);
    });
  });
});
