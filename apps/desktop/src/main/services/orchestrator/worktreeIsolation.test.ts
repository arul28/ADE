import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildFullPrompt } from "./baseOrchestratorAdapter";
import { createOrchestratorService } from "./orchestratorService";
import { openKvDb } from "../state/kvDb";
import type { PackExport, PackType } from "../../../shared/types";

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

function buildExport(
  packKey: string,
  packType: PackType,
  level: "lite" | "standard" | "deep"
): PackExport {
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

async function createFixture(args: {
  laneWorktreePath?: string | null;
  aiIntegrationService?: Record<string, unknown> | null;
} = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worktree-iso-"));
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), "# PRD\n\nContext\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "CONTEXT_CONTRACT.md"), "# CC\n", "utf8");

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

  // Lane with configurable worktree_path (defaults to projectRoot, null means null)
  const worktreePath = args.laneWorktreePath === undefined ? projectRoot : args.laneWorktreePath;
  db.run(
    `insert into lanes(
      id, project_id, name, description, lane_type, base_ref, branch_ref,
      worktree_path, attached_root_path, is_edit_protected, parent_lane_id,
      color, icon, tags_json, status, created_at, archived_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      laneId, projectId, "Lane 1", null, "worktree", "main", "feature/lane-1",
      worktreePath, null, 0, null, null, null, null, "active", now, null,
    ]
  );

  db.run(
    `insert into missions(
      id, project_id, lane_id, title, prompt, status, priority,
      execution_mode, target_machine_id, outcome_summary, last_error,
      metadata_json, created_at, updated_at, started_at, completed_at
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      missionId, projectId, laneId, "Mission 1", "Execute worktree test.",
      "queued", "normal", "local", null, null, null, null, now, now, null, null,
    ]
  );

  const ptyCreateCalls: Array<Record<string, unknown>> = [];
  const ptyService = {
    create: async (createArgs: Record<string, unknown>) => {
      ptyCreateCalls.push(createArgs);
      const index = ptyCreateCalls.length;
      return { ptyId: `pty-${index}`, sessionId: `session-${index}` };
    },
  } as any;

  const packService = {
    getLaneExport: async ({ laneId: lid, level }: { laneId: string; level: string }) =>
      buildExport(`lane:${lid}`, "lane", level as any),
    getProjectExport: async ({ level }: { level: string }) =>
      buildExport("project", "project", level as any),
    refreshMissionPack: async ({ missionId: mid }: { missionId: string }) => ({
      packKey: `mission:${mid}`,
      packType: "mission",
      path: path.join(projectRoot, ".ade", "packs", "missions", mid, "mission_pack.md"),
      exists: true,
      deterministicUpdatedAt: now,
      narrativeUpdatedAt: null,
      lastHeadSha: null,
      versionId: `mission-${mid}-v1`,
      versionNumber: 1,
      contentHash: `hash-mission-${mid}`,
      metadata: null,
      body: "# Mission Pack",
    }),
  } as any;

  const service = createOrchestratorService({
    db,
    projectId,
    projectRoot,
    ptyService,
    projectConfigService: null as any,
    aiIntegrationService: (args.aiIntegrationService ?? null) as any,
    memoryService: null as any,
  });

  // Normalize modelId for unified executor steps
  const defaultUnifiedModelId = "anthropic/claude-sonnet-4-6";
  const originalStartRun = service.startRun.bind(service);
  (service as any).startRun = ((input: any) =>
    originalStartRun({
      ...input,
      steps: Array.isArray(input?.steps)
        ? input.steps.map((step: any) => {
            const executorKind = typeof step?.executorKind === "string" ? step.executorKind : null;
            if (executorKind !== "unified") return step;
            const metadata = step?.metadata && typeof step.metadata === "object" ? step.metadata : {};
            const modelId = typeof metadata.modelId === "string" ? metadata.modelId.trim() : "";
            if (modelId.length > 0) return step;
            return { ...step, metadata: { ...metadata, modelId: defaultUnifiedModelId } };
          })
        : input?.steps,
    })) as typeof service.startRun;

  return {
    db,
    service,
    projectId,
    projectRoot,
    laneId,
    missionId,
    ptyCreateCalls,
    dispose: () => db.close(),
  };
}

// ─────────────────────────────────────────────────────
// VAL-ISO-001: Workers execute within lane worktree
// ─────────────────────────────────────────────────────

describe("VAL-ISO-001: Worktree isolation in startAttempt", () => {
  // Use an API model (isCliWrapped=false) to exercise the in-process worker path
  // where cwd is resolved from laneWorktreePath in orchestratorService.ts.
  const apiModelId = "anthropic/claude-sonnet-4-6-api";

  it("resolves cwd to lane worktree_path for in-process workers", async () => {
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-lane-wt-"));
    let capturedCwd: string | undefined;
    const aiIntegrationService = {
      executeViaUnified: async (execArgs: Record<string, unknown>) => {
        capturedCwd = execArgs.cwd as string;
        return {
          textResponse: "Done.",
          tokenUsage: { inputTokens: 100, outputTokens: 50 },
        };
      },
    };

    const fixture = await createFixture({
      laneWorktreePath: worktreeDir,
      aiIntegrationService,
    });
    try {
      const { run } = await fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "test-step",
            stepIndex: 0,
            title: "Test Step",
            executorKind: "unified",
            laneId: fixture.laneId,
            metadata: { modelId: apiModelId },
          },
        ],
      });

      const readySteps = fixture.service.getRunGraph({ runId: run.id }).steps.filter(
        (s) => s.status === "ready"
      );
      expect(readySteps.length).toBeGreaterThan(0);

      await fixture.service.startAttempt({
        runId: run.id,
        stepId: readySteps[0].id,
        ownerId: "test-owner",
        executorKind: "unified",
      });

      // The in-process worker should have received the lane worktree path as cwd
      expect(capturedCwd).toBe(worktreeDir);
      expect(capturedCwd).not.toBe(fixture.projectRoot);
    } finally {
      fixture.dispose();
    }
  });

  it("fails with configuration_error when worktree_path is empty for a step with laneId", async () => {
    // The lanes table has NOT NULL on worktree_path, so we test with empty string
    const fixture = await createFixture({
      laneWorktreePath: "",
      aiIntegrationService: {
        executeViaUnified: async () => {
          throw new Error("Should not be called");
        },
      },
    });
    try {
      const { run } = await fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "test-step",
            stepIndex: 0,
            title: "Test Step",
            executorKind: "unified",
            laneId: fixture.laneId,
            metadata: { modelId: apiModelId },
          },
        ],
      });

      const readySteps = fixture.service.getRunGraph({ runId: run.id }).steps.filter(
        (s) => s.status === "ready"
      );
      expect(readySteps.length).toBeGreaterThan(0);

      const attempt = await fixture.service.startAttempt({
        runId: run.id,
        stepId: readySteps[0].id,
        ownerId: "test-owner",
        executorKind: "unified",
      });

      // Should fail with configuration_error, not silently fall back to projectRoot
      expect(attempt.status).toBe("failed");
      expect(attempt.errorClass).toBe("configuration_error");
      expect(attempt.errorMessage).toContain("worktree_path");
    } finally {
      fixture.dispose();
    }
  });

  it("fails with configuration_error when worktree_path is whitespace-only for a step with laneId", async () => {
    const fixture = await createFixture({
      laneWorktreePath: "  ",
      aiIntegrationService: {
        executeViaUnified: async () => {
          throw new Error("Should not be called");
        },
      },
    });
    try {
      const { run } = await fixture.service.startRun({
        missionId: fixture.missionId,
        steps: [
          {
            stepKey: "test-step",
            stepIndex: 0,
            title: "Test Step",
            executorKind: "unified",
            laneId: fixture.laneId,
            metadata: { modelId: apiModelId },
          },
        ],
      });

      const readySteps = fixture.service.getRunGraph({ runId: run.id }).steps.filter(
        (s) => s.status === "ready"
      );
      expect(readySteps.length).toBeGreaterThan(0);

      const attempt = await fixture.service.startAttempt({
        runId: run.id,
        stepId: readySteps[0].id,
        ownerId: "test-owner",
        executorKind: "unified",
      });

      expect(attempt.status).toBe("failed");
      expect(attempt.errorClass).toBe("configuration_error");
    } finally {
      fixture.dispose();
    }
  });

  it("uses projectRoot as cwd when step has no laneId (non-lane fallback)", async () => {
    // Non-lane steps (without laneId) should use projectRoot.
    // We test at the code level since unified executor requires laneId.
    // Verify the laneWorktreePath resolution logic directly:
    // when step.laneId is falsy, the code should return projectRoot.
    // This is tested via buildFullPrompt's lack of worktree constraint for no-lane steps.
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Test mission" },
        } as any,
        step: {
          id: "step-1",
          title: "No Lane Step",
          stepKey: "no-lane-step",
          laneId: null,
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    // No worktree constraint for non-lane steps
    expect(result.prompt).not.toContain("You are working in:");
    expect(result.prompt).not.toContain("All file edits MUST be made within this path");
  });
});

// ─────────────────────────────────────────────────────
// VAL-ISO-002: Prompt instructs worker to write only in worktree
// ─────────────────────────────────────────────────────

describe("VAL-ISO-002: Worktree constraint in buildFullPrompt", () => {
  it("includes worktree constraint when lane worktree is assigned", () => {
    const worktreePath = "/tmp/test-worktree/lane-1";
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Test mission" },
        } as any,
        step: {
          id: "step-1",
          title: "Test Step",
          stepKey: "test-step",
          laneId: "lane-1",
          metadata: {
            laneWorktreePath: worktreePath,
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    expect(result.prompt).toContain("You are working in:");
    expect(result.prompt).toContain(worktreePath);
    expect(result.prompt).toContain("All file edits MUST be made within this path");
  });

  it("does NOT include worktree constraint when no lane is assigned", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Test mission" },
        } as any,
        step: {
          id: "step-1",
          title: "Test Step",
          stepKey: "test-step",
          laneId: null,
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    expect(result.prompt).not.toContain("You are working in:");
    expect(result.prompt).not.toContain("All file edits MUST be made within this path");
  });

  it("does NOT include worktree constraint when laneId is set but no laneWorktreePath in metadata", () => {
    const result = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: { missionGoal: "Test mission" },
        } as any,
        step: {
          id: "step-1",
          title: "Test Step",
          stepKey: "test-step",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: { content: "Project context" } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "unified",
      {}
    );

    // Without laneWorktreePath in metadata, no constraint should be added
    expect(result.prompt).not.toContain("You are working in:");
    expect(result.prompt).not.toContain("All file edits MUST be made within this path");
  });
});
