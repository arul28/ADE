import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOrchestratorService } from "./orchestratorService";
import { transitionMissionStatus } from "./missionLifecycle";
import { createMissionService } from "../missions/missionService";
import { openKvDb } from "../state/kvDb";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture(initialStatus: string = "in_progress") {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lifecycle-regression-"));
  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const missionId = "mission-1";
  const now = "2026-03-10T00:00:00.000Z";

  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at)
     values (?, ?, ?, ?, ?, ?)`,
    [projectId, projectRoot, "ADE", "main", now, now]
  );

  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref,
      worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
      color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId, projectId, "Lane 1", null, "worktree", "main", "feature/lane-1",
      projectRoot, null, 0, null, null, null, null, "active", now, null,
    ]
  );

  db.run(
    `insert into missions(
      id, project_id, lane_id, title, prompt, status, priority,
      execution_mode, target_machine_id, outcome_summary, last_error,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      missionId, projectId, laneId, "Lifecycle Regression Test",
      "Test lifecycle regression guard.", initialStatus, "normal", "local",
      null, null, null, null, now, now, now, null,
    ]
  );

  const orchestratorService = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    ptyService: {
      create: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
    } as any,
    projectConfigService: null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
  });

  const missionService = createMissionService({ db, projectId });

  const ctx = {
    db,
    logger: createLogger(),
    missionService,
    orchestratorService,
    projectRoot,
    hookCommandRunner: async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: "",
      stderr: "",
      spawnError: null,
    }),
    agentChatService: null,
    laneService: null,
    projectConfigService: null,
    aiIntegrationService: null,
    prService: null,
    missionBudgetService: null,
    onThreadEvent: undefined,
    onDagMutation: undefined,
    syncLocks: new Set<string>(),
    workerStates: new Map(),
    activeSteeringDirectives: new Map(),
    runRuntimeProfiles: new Map(),
    chatMessages: new Map(),
    activeChatSessions: new Map(),
    chatTurnQueues: new Map(),
    activeHealthSweepRuns: new Set<string>(),
    sessionRuntimeSignals: new Map(),
    attemptRuntimeTrackers: new Map(),
    sessionSignalQueues: new Map(),
    workerDeliveryThreadQueues: new Map(),
    workerDeliveryInterventionCooldowns: new Map(),
    runTeamManifests: new Map(),
    runRecoveryLoopStates: new Map(),
    aiTimeoutBudgetStepLocks: new Set<string>(),
    aiTimeoutBudgetRunLocks: new Set<string>(),
    aiRetryDecisionLocks: new Set<string>(),
    coordinatorSessions: new Map(),
    pendingIntegrations: new Map(),
    coordinatorThinkingLoops: new Map(),
    pendingCoordinatorEvals: new Map(),
    coordinatorAgents: new Map(),
    coordinatorRecoveryAttempts: new Map(),
    teamRuntimeStates: new Map(),
    callTypeConfigCache: new Map(),
    disposed: { current: false },
    healthSweepTimer: { current: null },
  } as any;

  return {
    ctx,
    missionId,
    missionService,
    dispose: () => {
      db.close();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

// ─────────────────────────────────────────────────────
// Terminal status regression guard tests
// ─────────────────────────────────────────────────────

describe("transitionMissionStatus — terminal status regression guard", () => {
  it("blocks transition from completed to in_progress", async () => {
    const fixture = await createFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from failed to running", async () => {
    const fixture = await createFixture("failed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from canceled to in_progress", async () => {
    const fixture = await createFixture("canceled");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("canceled");
    } finally {
      fixture.dispose();
    }
  });

  it("passes through the regression guard for terminal-to-terminal (completed to completed)", async () => {
    // completed -> completed is a self-transition with no args, so it's a no-op
    // but the regression guard itself does NOT block it
    const fixture = await createFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "completed");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("does not throw for terminal-to-terminal even when missionService rejects it", async () => {
    // completed -> failed passes the regression guard (both terminal),
    // but missionService rejects it (not in MISSION_TRANSITIONS).
    // transitionMissionStatus catches the error silently and status stays.
    const fixture = await createFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "failed");
      const mission = fixture.missionService.get(fixture.missionId);
      // Status stays completed because missionService rejects the transition
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("allows failed -> canceled (valid in missionService transition table)", async () => {
    const fixture = await createFixture("failed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "canceled");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("canceled");
    } finally {
      fixture.dispose();
    }
  });

  it("allows transition from non-terminal to terminal (in_progress to completed)", async () => {
    const fixture = await createFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "completed", {
        outcomeSummary: "All tasks done",
      });
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("allows transition from non-terminal to non-terminal (in_progress to intervention_required)", async () => {
    const fixture = await createFixture("in_progress");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "intervention_required", {
        lastError: "Needs human review",
      });
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("intervention_required");
    } finally {
      fixture.dispose();
    }
  });

  it("blocks transition from completed to intervention_required (non-terminal)", async () => {
    const fixture = await createFixture("completed");
    try {
      transitionMissionStatus(fixture.ctx, fixture.missionId, "intervention_required");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("completed");
    } finally {
      fixture.dispose();
    }
  });

  it("no-ops when transitioning to the same status with no args", async () => {
    const fixture = await createFixture("in_progress");
    try {
      // Same status, no outcomeSummary or lastError => early return (no-op)
      transitionMissionStatus(fixture.ctx, fixture.missionId, "in_progress");
      const mission = fixture.missionService.get(fixture.missionId);
      expect(mission?.status).toBe("in_progress");
    } finally {
      fixture.dispose();
    }
  });

  it("returns silently for a non-existent mission", async () => {
    const fixture = await createFixture("in_progress");
    try {
      // Should not throw, just return
      transitionMissionStatus(fixture.ctx, "non-existent-mission-id", "completed");
    } finally {
      fixture.dispose();
    }
  });
});
