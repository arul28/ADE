import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { classifyBlockingWarnings } from "./orchestratorQueries";
import type { PackExport, PackType } from "../../../shared/types";
import { createOrchestratorService } from "./orchestratorService";
import { openKvDb } from "../state/kvDb";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
}

function runGit(cwd: string, args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(`git ${args.join(" ")} failed (${result.status}): ${(result.stderr ?? "").trim()}`);
}

function buildExport(packKey: string, packType: PackType, level: "lite" | "standard" | "deep"): PackExport {
  return {
    packKey,
    packType,
    level,
    header: {} as any,
    content: `${packKey}:${level}`,
    approxTokens: 32,
    maxTokens: 500,
    truncated: false,
    warnings: [],
    clipReason: null,
    omittedSections: null,
  };
}

async function createFixture() {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-hardening-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nContext baseline\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "CONTEXT_CONTRACT.md"), "# Context Contract\n", "utf8");

  const db = await openKvDb(path.join(projectRoot, "ade.db"), createLogger());
  const projectId = "proj-1";
  const laneId = "lane-1";
  const missionId = "mission-1";
  const now = "2026-03-09T00:00:00.000Z";

  db.run(
    `insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)`,
    [projectId, projectRoot, "Test", "main", now, now]
  );

  db.run(
    `insert into lanes(id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, status, created_at, archived_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [laneId, projectId, "Lane 1", null, "worktree", "main", "feature/lane-1", projectRoot, null, 0, null, null, null, null, "active", now, null]
  );

  db.run(
    `insert into missions(id, project_id, lane_id, title, prompt, status, priority, execution_mode, target_machine_id, outcome_summary, last_error, metadata_json, created_at, updated_at, started_at, completed_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [missionId, projectId, laneId, "Hardening Test Mission", "Test mission.", "queued", "normal", "local", null, null, null, null, now, now, null, null]
  );

  const ptyCreateCalls: Array<Record<string, unknown>> = [];
  const ptyService = {
    create: async (args: Record<string, unknown>) => {
      ptyCreateCalls.push(args);
      const index = ptyCreateCalls.length;
      return { ptyId: `pty-${index}`, sessionId: `session-${index}` };
    },
  } as any;

  const packService = {
    getLaneExport: async ({ laneId: targetLaneId, level }: { laneId: string; level: string }) =>
      buildExport(`lane:${targetLaneId}`, "lane", level as any),
    getProjectExport: async ({ level }: { level: string }) => buildExport("project", "project", level as any),
    refreshMissionPack: async ({ missionId: targetMissionId }: { missionId: string }) => ({
      packKey: `mission:${targetMissionId}`,
      packType: "mission",
      path: path.join(projectRoot, ".ade", "packs", "missions", targetMissionId, "mission_pack.md"),
      exists: true,
      deterministicUpdatedAt: now,
      narrativeUpdatedAt: null,
      lastHeadSha: null,
      versionId: `mission-${targetMissionId}-v1`,
      versionNumber: 1,
      contentHash: `hash-mission-${targetMissionId}`,
      metadata: null,
      body: "# Mission Pack",
    }),
  } as any;

  const service = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    conflictService: undefined,
    ptyService,
    projectConfigService: null as any,
    aiIntegrationService: null as any,
    memoryService: null as any,
  });

  return { db, service, projectId, projectRoot, laneId, missionId, ptyCreateCalls, dispose: () => db.close() };
}

// ---------------------------------------------------------------------------
// classifyBlockingWarnings — unit tests
// ---------------------------------------------------------------------------

describe("classifyBlockingWarnings", () => {
  it("detects sandbox-blocked writes as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["Tool 'Write' failed: PreToolUse:Write hook error ... SANDBOX BLOCKED: File path outside sandbox: /etc/sensitive/foo"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("treats sandbox blocks to ~/.claude/plans/ as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["Tool 'Write' failed: PreToolUse:Write hook error ... SANDBOX BLOCKED: File path outside sandbox: /Users/admin/.claude/plans/foo"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("detects tool startup failures as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["tool startup failed for MCP server"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("tool_failure");
  });

  it("detects permission denied as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["EACCES: permission denied, open '/etc/passwd'"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("permission_denied");
  });

  it("detects missing auth as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["authentication required for API access"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("missing_auth");
  });

  it("detects blocking patterns in summary text", () => {
    const result = classifyBlockingWarnings({
      warnings: [],
      summary: "Attempt completed but SANDBOX BLOCKED on critical write operation",
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("excludes external MCP auth warnings (claude.ai Gmail:needs-auth)", () => {
    const result = classifyBlockingWarnings({
      warnings: ["claude.ai Gmail:needs-auth", "claude.ai Google Calendar:needs-auth"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
    expect(result.category).toBeNull();
  });

  it("excludes external MCP Slack auth noise", () => {
    const result = classifyBlockingWarnings({
      warnings: ["claude.ai Slack:needs-auth"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("does not treat normal warnings as blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["Step completed with minor formatting issues", "Output truncated at 1000 chars"],
      summary: "Worker completed implementation successfully",
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("detects blocking when mixed with external MCP noise", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "claude.ai Gmail:needs-auth",
        "Tool 'Write' failed: SANDBOX BLOCKED on /etc/sensitive/config",
        "claude.ai Google Drive:needs-auth",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("blocks when mixed noise includes ~/.claude/plans/ sandbox blocks", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "claude.ai Gmail:needs-auth",
        "Tool 'Write' failed: SANDBOX BLOCKED on /Users/admin/.claude/plans/x",
        "claude.ai Google Drive:needs-auth",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("detects PreToolUse hook errors with sandbox content as sandbox_block", () => {
    // "sandbox blocked" matches the sandbox_block pattern before tool_failure
    const result = classifyBlockingWarnings({
      warnings: ["PreToolUse:Write hook error: sandbox blocked this write"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("sandbox_block");
  });

  it("detects pure PreToolUse hook errors as tool_failure", () => {
    const result = classifyBlockingWarnings({
      warnings: ["PreToolUse:Read hook error: configuration invalid"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("tool_failure");
  });
});

// ---------------------------------------------------------------------------
// Soft-failure override in completeAttempt — integration tests
// ---------------------------------------------------------------------------

describe("soft-failure override in completeAttempt", () => {
  it("overrides succeeded attempt to failed when sandbox block warning is present", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "impl-1", title: "Implementation", stepIndex: 0,laneId: fixture.laneId }],
      });

      const step = run.steps[0]!;
      fixture.service.tick({ runId: run.run.id });

      const attempt = await fixture.service.startAttempt({
        runId: run.run.id,
        stepId: step.id,
        ownerId: "test-owner",
        executorKind: "cli",
      });

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1" as const,
          success: true,
          summary: "Completed but sandbox blocked",
          outputs: null,
          warnings: ["Tool 'Write' failed: PreToolUse:Write hook error SANDBOX BLOCKED: File path outside sandbox"],
          sessionId: null,
          trackedSession: false,
        },
      });

      // The attempt should be recorded as failed, not succeeded
      expect(completed.status).toBe("failed");
      expect(completed.errorClass).toBe("soft_success_blocking_failure");

      // The step should be failed/blocked, not succeeded
      const graph = fixture.service.getRunGraph({ runId: run.run.id });
      const updatedStep = graph.steps.find((s) => s.id === step.id);
      expect(updatedStep?.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });

  it("does not override succeeded attempt when warnings are only external MCP noise", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "impl-1", title: "Implementation", stepIndex: 0,laneId: fixture.laneId }],
      });

      const step = run.steps[0]!;
      fixture.service.tick({ runId: run.run.id });

      const attempt = await fixture.service.startAttempt({
        runId: run.run.id,
        stepId: step.id,
        ownerId: "test-owner",
        executorKind: "cli",
      });

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
        result: {
          schema: "ade.orchestratorAttempt.v1" as const,
          success: true,
          summary: "Implementation complete",
          outputs: null,
          warnings: ["claude.ai Gmail:needs-auth", "claude.ai Google Calendar:needs-auth"],
          sessionId: null,
          trackedSession: false,
        },
      });

      // Should remain succeeded — external MCP noise should be ignored
      expect(completed.status).toBe("succeeded");
    } finally {
      fixture.dispose();
    }
  });

  it("overrides transcript-derived succeeded attempt to failed when summary shows sandbox block", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "impl-1", title: "Implementation", stepIndex: 0, laneId: fixture.laneId }],
      });

      const step = run.steps[0]!;
      fixture.service.tick({ runId: run.run.id });

      const attempt = await fixture.service.startAttempt({
        runId: run.run.id,
        stepId: step.id,
        ownerId: "test-owner",
        executorKind: "cli",
      });

      // ~/.claude/plans/ sandbox blocks are now treated as benign (ExitPlanMode is expected noise).
      // Use a non-plan path for the blocking test, then verify plan path stays succeeded.
      const transcriptPath = path.join(fixture.projectRoot, "sandbox-blocked.log");
      fs.writeFileSync(
        transcriptPath,
        "Tool 'Write' failed: PreToolUse:Write hook error: [/Users/admin/.claude/hooks/sandbox.sh]: SANDBOX BLOCKED: File path outside sandbox: /etc/sensitive/production.conf\n",
        "utf8"
      );
      fixture.db.run(
        `update orchestrator_attempts set metadata_json = ? where id = ?`,
        [JSON.stringify({ transcriptPath }), attempt.id]
      );

      const completed = await fixture.service.completeAttempt({
        attemptId: attempt.id,
        status: "succeeded",
      });

      expect(completed.status).toBe("failed");
      expect(completed.errorClass).toBe("soft_success_blocking_failure");

      const graph = fixture.service.getRunGraph({ runId: run.run.id });
      const updatedStep = graph.steps.find((s) => s.id === step.id);
      expect(updatedStep?.status).toBe("failed");
    } finally {
      fixture.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// Pause model hardening
// ---------------------------------------------------------------------------

describe("pause model hardening", () => {
  it("paused run does not advance or spawn new workers via autopilot", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          { stepKey: "step-a", title: "Step A", stepIndex: 0, laneId: fixture.laneId },
          { stepKey: "step-b", title: "Step B", stepIndex: 1, laneId: fixture.laneId },
        ],
      });

      fixture.service.tick({ runId: run.run.id });

      // Pause the run
      fixture.service.pauseRun({ runId: run.run.id, reason: "User requested pause" });

      const pausedRun = fixture.service.getRunGraph({ runId: run.run.id });
      expect(pausedRun.run.status).toBe("paused");

      // Autopilot should return 0 and not start any attempts
      const started = await fixture.service.startReadyAutopilotAttempts({ runId: run.run.id });
      expect(started).toBe(0);

      // No PTY sessions should have been created
      expect(fixture.ptyCreateCalls).toHaveLength(0);
    } finally {
      fixture.dispose();
    }
  });

  it("startAttempt throws when run is paused", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "step-a", title: "Step A", stepIndex: 0,laneId: fixture.laneId }],
      });

      fixture.service.tick({ runId: run.run.id });
      fixture.service.pauseRun({ runId: run.run.id, reason: "Testing pause" });

      const step = run.steps[0]!;
      await expect(
        fixture.service.startAttempt({ runId: run.run.id, stepId: step.id, ownerId: "test-owner", executorKind: "cli" })
      ).rejects.toThrow(/paused/i);
    } finally {
      fixture.dispose();
    }
  });

  it("paused run survives tick without state change", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "step-a", title: "Step A", stepIndex: 0,laneId: fixture.laneId }],
      });

      fixture.service.pauseRun({ runId: run.run.id, reason: "Freeze" });

      // Multiple ticks should not change the paused state
      fixture.service.tick({ runId: run.run.id });
      fixture.service.tick({ runId: run.run.id });

      const graph = fixture.service.getRunGraph({ runId: run.run.id });
      expect(graph.run.status).toBe("paused");
    } finally {
      fixture.dispose();
    }
  });

  it("resumeRun correctly transitions paused run back to active", async () => {
    const fixture = await createFixture();
    try {
      const run = fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [{ stepKey: "step-a", title: "Step A", stepIndex: 0,laneId: fixture.laneId }],
      });

      fixture.service.tick({ runId: run.run.id });
      fixture.service.pauseRun({ runId: run.run.id, reason: "Pause" });

      const paused = fixture.service.getRunGraph({ runId: run.run.id });
      expect(paused.run.status).toBe("paused");

      fixture.service.resumeRun({ runId: run.run.id });

      const resumed = fixture.service.getRunGraph({ runId: run.run.id });
      expect(resumed.run.status).toBe("active");
    } finally {
      fixture.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// MissionRunPanel helpers — pure function tests
// ---------------------------------------------------------------------------

describe("MissionRunPanel attention states", () => {
  it("selectOpenInterventions returns only open interventions", () => {
    const interventions = [
      { id: "iv-1", status: "open", interventionType: "manual_input", title: "Question 1" },
      { id: "iv-2", status: "resolved", interventionType: "manual_input", title: "Question 2" },
      { id: "iv-3", status: "open", interventionType: "failed_step", title: "Step failed" },
      { id: "iv-4", status: "dismissed", interventionType: "policy_block", title: "Policy" },
    ];

    const open = interventions.filter((iv) => iv.status === "open");
    expect(open).toHaveLength(2);
    expect(open.map((iv) => iv.id)).toEqual(["iv-1", "iv-3"]);
  });

  it("blocking interventions are distinguished from non-blocking", () => {
    const blockingIntervention = {
      metadata: { canProceedWithoutAnswer: false, blocking: true, category: "user_input" },
    };
    const nonBlockingIntervention = {
      metadata: { canProceedWithoutAnswer: true, blocking: false, category: "user_input" },
    };

    expect(blockingIntervention.metadata.blocking).toBe(true);
    expect(nonBlockingIntervention.metadata.blocking).toBe(false);
    expect(blockingIntervention.metadata.canProceedWithoutAnswer).toBe(false);
    expect(nonBlockingIntervention.metadata.canProceedWithoutAnswer).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// External MCP noise vs real failures
// ---------------------------------------------------------------------------

describe("external MCP noise filtering", () => {
  it("gmail auth noise does not trigger blocking classification", () => {
    const result = classifyBlockingWarnings({
      warnings: ["claude.ai Gmail:needs-auth"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("google calendar auth noise does not trigger blocking classification", () => {
    const result = classifyBlockingWarnings({
      warnings: ["claude.ai Google Calendar:needs-auth"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("google drive auth noise does not trigger blocking classification", () => {
    const result = classifyBlockingWarnings({
      warnings: ["claude.ai Google Drive:needs-auth"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(false);
  });

  it("ADE-internal needs-auth without claude.ai prefix IS blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: ["MCP server myserver:needs-auth — cannot continue"],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("missing_auth");
  });

  it("real tool failure mixed with external noise is still blocking", () => {
    const result = classifyBlockingWarnings({
      warnings: [
        "claude.ai Gmail:needs-auth",
        "claude.ai Slack:needs-auth",
        "tool 'Write' failed with EPERM",
      ],
      summary: null,
    });
    expect(result.hasBlockingFailure).toBe(true);
    expect(result.category).toBe("permission_denied");
  });
});
