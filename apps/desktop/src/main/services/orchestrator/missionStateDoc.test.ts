import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInitialMissionStateDocument,
  getMissionStateDocumentPath,
  getCoordinatorCheckpointPath,
  updateMissionStateDocument,
  readMissionStateDocument,
  writeCoordinatorCheckpoint,
  readCoordinatorCheckpoint,
  deleteCoordinatorCheckpoint,
} from "./missionStateDoc";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-msd-test-"));
  // Create .ade/cache/mission-state directory structure expected by resolveAdeLayout
  const missionStateDir = path.join(tmpDir, ".ade", "cache", "mission-state");
  fs.mkdirSync(missionStateDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getMissionStateDocumentPath", () => {
  it("returns path under .ade/cache/mission-state", () => {
    const result = getMissionStateDocumentPath(tmpDir, "run-abc");
    expect(result).toContain("mission-state");
    expect(result).toContain("mission-state-run-abc.json");
  });
});

describe("getCoordinatorCheckpointPath", () => {
  it("returns path under .ade/cache/mission-state", () => {
    const result = getCoordinatorCheckpointPath(tmpDir, "run-abc");
    expect(result).toContain("mission-state");
    expect(result).toContain("coordinator-checkpoint-run-abc.json");
  });
});

describe("createInitialMissionStateDocument", () => {
  it("creates a document with schemaVersion 1 and empty collections", () => {
    const doc = createInitialMissionStateDocument({
      missionId: "mission-1",
      runId: "run-1",
      goal: "Build feature X",
    });
    expect(doc.schemaVersion).toBe(1);
    expect(doc.missionId).toBe("mission-1");
    expect(doc.runId).toBe("run-1");
    expect(doc.goal).toBe("Build feature X");
    expect(doc.stepOutcomes).toEqual([]);
    expect(doc.decisions).toEqual([]);
    expect(doc.activeIssues).toEqual([]);
    expect(doc.modifiedFiles).toEqual([]);
    expect(doc.pendingInterventions).toEqual([]);
    expect(doc.reflections).toEqual([]);
    expect(doc.latestRetrospective).toBeNull();
  });

  it("initializes progress with defaults when not provided", () => {
    const doc = createInitialMissionStateDocument({
      missionId: "m1",
      runId: "r1",
      goal: "Test",
    });
    expect(doc.progress.currentPhase).toBe("unknown");
    expect(doc.progress.completedSteps).toBe(0);
    expect(doc.progress.totalSteps).toBe(0);
    expect(doc.progress.activeWorkers).toEqual([]);
    expect(doc.progress.blockedSteps).toEqual([]);
    expect(doc.progress.failedSteps).toEqual([]);
  });

  it("accepts partial progress overrides", () => {
    const doc = createInitialMissionStateDocument({
      missionId: "m1",
      runId: "r1",
      goal: "Test",
      progress: { currentPhase: "development", totalSteps: 5 },
    });
    expect(doc.progress.currentPhase).toBe("development");
    expect(doc.progress.totalSteps).toBe(5);
    expect(doc.progress.completedSteps).toBe(0);
  });
});

describe("updateMissionStateDocument", () => {
  it("creates a new document and applies the patch", async () => {
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-update-1",
      goal: "Build X",
      patch: {
        updateProgress: {
          currentPhase: "development",
          totalSteps: 3,
        },
      },
    });
    expect(result.missionId).toBe("m1");
    expect(result.progress.currentPhase).toBe("development");
    expect(result.progress.totalSteps).toBe(3);
  });

  it("adds a step outcome", async () => {
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-step-outcome",
      goal: "Build X",
      patch: {
        addStepOutcome: {
          stepKey: "step-1",
          stepName: "Implement auth",
          phase: "development",
          status: "succeeded",
          summary: "Auth module completed",
          filesChanged: ["src/auth.ts"],
          warnings: [],
          completedAt: "2026-03-25T12:00:00.000Z",
        },
      },
    });
    expect(result.stepOutcomes).toHaveLength(1);
    expect(result.stepOutcomes[0].stepKey).toBe("step-1");
    expect(result.stepOutcomes[0].status).toBe("succeeded");
    expect(result.stepOutcomes[0].filesChanged).toEqual(["src/auth.ts"]);
    expect(result.modifiedFiles).toContain("src/auth.ts");
  });

  it("merges step outcome updates on existing step", async () => {
    // First create with a step outcome
    await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-merge-outcome",
      goal: "Build X",
      patch: {
        addStepOutcome: {
          stepKey: "step-1",
          stepName: "Implement auth",
          phase: "development",
          status: "in_progress",
          summary: "Started",
          filesChanged: ["src/auth.ts"],
          warnings: [],
          completedAt: null,
        },
      },
    });

    // Then update the same step
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-merge-outcome",
      goal: "Build X",
      patch: {
        addStepOutcome: {
          stepKey: "step-1",
          stepName: "Implement auth",
          phase: "development",
          status: "succeeded",
          summary: "Completed auth module",
          filesChanged: ["src/auth.ts", "src/middleware.ts"],
          warnings: [],
          completedAt: "2026-03-25T13:00:00.000Z",
        },
      },
    });
    expect(result.stepOutcomes).toHaveLength(1);
    expect(result.stepOutcomes[0].status).toBe("succeeded");
    expect(result.stepOutcomes[0].summary).toBe("Completed auth module");
  });

  it("adds decisions", async () => {
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-decision",
      goal: "Build X",
      patch: {
        addDecision: {
          timestamp: "2026-03-25T12:00:00.000Z",
          decision: "Use JWT for auth",
          rationale: "Standard approach",
          context: "Architecture decision",
        },
      },
    });
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].decision).toBe("Use JWT for auth");
  });

  it("adds and resolves issues", async () => {
    // Add an issue
    await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-issue",
      goal: "Build X",
      patch: {
        addIssue: {
          id: "issue-1",
          severity: "high",
          description: "Auth module failing tests",
          affectedSteps: ["step-1"],
          status: "open",
        },
      },
    });

    // Resolve it
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-issue",
      goal: "Build X",
      patch: {
        resolveIssue: {
          id: "issue-1",
          resolution: "Fixed the test setup",
        },
      },
    });
    expect(result.activeIssues).toHaveLength(1);
    expect(result.activeIssues[0].status).toBe("resolved");
    expect(result.decisions.some((d) => d.decision.includes("Resolved issue issue-1"))).toBe(true);
  });

  it("sets and clears finalization state", async () => {
    const result = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-fin",
      goal: "Build X",
      patch: {
        finalization: {
          policy: {
            kind: "integration",
            targetBranch: "main",
            draft: false,
            prDepth: null,
            autoRebase: true,
            ciGating: true,
            autoLand: false,
            autoResolveConflicts: false,
            archiveLaneOnLand: true,
            mergeMethod: "squash",
            conflictResolverModel: null,
            reasoningEffort: null,
            description: null,
          },
          status: "creating_pr",
          executionComplete: true,
          contractSatisfied: false,
          blocked: false,
          blockedReason: null,
          summary: "Creating PR",
          detail: null,
          resolverJobId: null,
          integrationLaneId: null,
          resultLaneId: null,
          queueGroupId: null,
          queueId: null,
          activePrId: null,
          waitReason: null,
          proposalUrl: null,
          prUrls: [],
          reviewStatus: null,
          mergeReadiness: null,
          requirements: [],
          warnings: [],
          updatedAt: "2026-03-25T12:00:00.000Z",
          startedAt: "2026-03-25T12:00:00.000Z",
          completedAt: null,
        },
      },
    });
    expect(result.finalization).not.toBeNull();
    expect(result.finalization!.status).toBe("creating_pr");
    expect(result.finalization!.policy.kind).toBe("integration");

    // Clear it
    const cleared = await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-fin",
      goal: "Build X",
      patch: { finalization: null },
    });
    expect(cleared.finalization).toBeNull();
  });
});

describe("readMissionStateDocument", () => {
  it("returns null when no document exists", async () => {
    const doc = await readMissionStateDocument({
      projectRoot: tmpDir,
      runId: "nonexistent-run",
    });
    expect(doc).toBeNull();
  });

  it("reads back a previously written document", async () => {
    await updateMissionStateDocument({
      projectRoot: tmpDir,
      missionId: "m1",
      runId: "run-read-test",
      goal: "Readable goal",
      patch: { updateProgress: { currentPhase: "testing" } },
    });

    const doc = await readMissionStateDocument({
      projectRoot: tmpDir,
      runId: "run-read-test",
    });
    expect(doc).not.toBeNull();
    expect(doc!.goal).toBe("Readable goal");
    expect(doc!.progress.currentPhase).toBe("testing");
  });
});

describe("writeCoordinatorCheckpoint / readCoordinatorCheckpoint", () => {
  it("writes and reads a checkpoint", async () => {
    await writeCoordinatorCheckpoint(tmpDir, "run-cp-1", {
      version: 1,
      runId: "run-cp-1",
      missionId: "m1",
      conversationSummary: "Worker completed step 1",
      lastEventTimestamp: "2026-03-25T12:00:00.000Z",
      turnCount: 5,
      compactionCount: 1,
      savedAt: "2026-03-25T12:01:00.000Z",
    });

    const cp = await readCoordinatorCheckpoint(tmpDir, "run-cp-1");
    expect(cp).not.toBeNull();
    expect(cp!.missionId).toBe("m1");
    expect(cp!.conversationSummary).toBe("Worker completed step 1");
    expect(cp!.turnCount).toBe(5);
    expect(cp!.compactionCount).toBe(1);
  });

  it("returns null for non-existent checkpoint", async () => {
    const cp = await readCoordinatorCheckpoint(tmpDir, "nonexistent");
    expect(cp).toBeNull();
  });

  it("rejects invalid checkpoint payload", async () => {
    await expect(
      writeCoordinatorCheckpoint(tmpDir, "run-bad", {
        version: 1,
        runId: "",
        missionId: "",
        conversationSummary: "",
        lastEventTimestamp: null,
        turnCount: 0,
        compactionCount: 0,
        savedAt: "",
      }),
    ).rejects.toThrow("Invalid coordinator checkpoint payload");
  });

  it("truncates oversized conversation summaries", async () => {
    const longSummary = "x".repeat(10_000);
    await writeCoordinatorCheckpoint(tmpDir, "run-long", {
      version: 1,
      runId: "run-long",
      missionId: "m1",
      conversationSummary: longSummary,
      lastEventTimestamp: null,
      turnCount: 0,
      compactionCount: 0,
      savedAt: "2026-03-25T12:00:00.000Z",
    });
    const cp = await readCoordinatorCheckpoint(tmpDir, "run-long");
    expect(cp).not.toBeNull();
    expect(cp!.conversationSummary.length).toBeLessThanOrEqual(8_000);
  });
});

describe("deleteCoordinatorCheckpoint", () => {
  it("deletes an existing checkpoint", async () => {
    await writeCoordinatorCheckpoint(tmpDir, "run-del", {
      version: 1,
      runId: "run-del",
      missionId: "m1",
      conversationSummary: "Test",
      lastEventTimestamp: null,
      turnCount: 1,
      compactionCount: 0,
      savedAt: "2026-03-25T12:00:00.000Z",
    });

    await deleteCoordinatorCheckpoint(tmpDir, "run-del");
    const cp = await readCoordinatorCheckpoint(tmpDir, "run-del");
    expect(cp).toBeNull();
  });

  it("does not throw when deleting a non-existent checkpoint", async () => {
    await expect(
      deleteCoordinatorCheckpoint(tmpDir, "nonexistent"),
    ).resolves.toBeUndefined();
  });
});
