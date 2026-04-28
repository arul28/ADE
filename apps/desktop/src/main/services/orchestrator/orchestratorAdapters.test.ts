import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildFullPrompt } from "./baseOrchestratorAdapter";
import {
  mapPermissionToClaude,
  mapPermissionToCodex,
  mergeMissionPermissionConfig,
  normalizeMissionPermissions,
} from "./permissionMapping";
import {
  resolveMissionDecisionTimeoutCapMs,
  resolveMissionModelConfig,
  resolveOrchestratorModelConfig,
} from "./modelConfigResolver";

const mockState = vi.hoisted(() => ({
  resolveClaudeCodeExecutable: vi.fn(() => ({ path: "/mock/bin/claude", source: "path" as const })),
}));

vi.mock("../ai/claudeCodeExecutable", () => ({
  resolveClaudeCodeExecutable: mockState.resolveClaudeCodeExecutable,
}));

import { createProviderOrchestratorAdapter } from "./providerOrchestratorAdapter";

describe("buildFullPrompt", () => {
  it("injects shared facts, mission memory, and project knowledge into worker prompts", () => {
    const memoryService = {
      getMemoryBudget: (_projectId: string, _level: string, opts?: { scope?: string; scopeOwnerId?: string | null }) => {
        return [
          {
            id: "mem-project-1",
            category: "decision",
            content: "Project-wide decisions should stay visible across runs.",
            importance: "high",
          },
        ];
      },
    } as any;

    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Stabilize W6 memory behavior",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Fix mission memory scoping",
          stepKey: "fix-memory",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
        memoryBriefing: {
          l0: { title: "Project Memory", entries: [] },
          l1: {
            title: "Relevant Project Knowledge",
            entries: [
              {
                id: "mem-project-1",
                category: "decision",
                content: "Project-wide decisions should stay visible across runs.",
                importance: "high",
              },
            ],
          },
          l2: { title: "Agent Memory", entries: [] },
          mission: {
            title: "Mission Memory",
            entries: [
              {
                id: "mem-mission-1",
                category: "pattern",
                content: "Mission memory stays scoped to the current run.",
                importance: "medium",
              },
            ],
          },
          sharedFacts: [
            {
              id: "mem-mission-1",
              factType: "api_pattern",
              content: "Mission memory stays scoped to the current run.",
              createdAt: "2026-03-05T12:00:00.000Z",
            },
          ],
          usedProcedureIds: [],
          usedDigestIds: [],
          usedMissionMemoryIds: ["mem-mission-1"],
        } as any,
      },
      "opencode",
      {
        memoryService,
        projectId: "project-1",
      }
    );

    expect(prompt.prompt).toContain("## Shared Team Knowledge");
    expect(prompt.prompt).toContain("## Mission Memory");
    expect(prompt.prompt).toContain("Mission memory stays scoped to the current run.");
    expect(prompt.prompt).toContain("## Project Knowledge");
    expect(prompt.prompt).toContain("Project-wide decisions should stay visible across runs.");
  });

  it("routes read-only workers to ADE result reporting instead of file writes", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Research the sidebar flow",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Plan sidebar changes",
          stepKey: "plan-sidebar",
          laneId: "lane-1",
          metadata: {
            readOnlyExecution: true,
          },
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(prompt.prompt).toContain("ALWAYS call `report_result`");
    expect(prompt.prompt).toContain("This step cannot write files.");
    expect(prompt.prompt).not.toContain("PROGRESS CHECKPOINTING:");
    expect(prompt.prompt).not.toContain("STEP OUTPUT FILE:");
  });

  it("handles partial briefing structures without throwing", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Recover the mission landing path",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Recover landing flow",
          stepKey: "recover-landing",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
        memoryBriefing: {
          mission: {
            title: "Mission Memory",
            entries: [
              {
                id: "mission-memory-1",
                category: "note",
                content: "Mission landing failures should point to the focused intervention.",
                importance: "high",
              },
            ],
          },
          l1: {
            title: "Project Knowledge",
          },
        } as any,
      },
      "opencode",
      {}
    );

    expect(prompt.prompt).toContain("Mission landing failures should point to the focused intervention.");
    expect(prompt.prompt).toContain("## Mission Memory");
  });

  it("keeps checkpoint and step output instructions for writable workers", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Implement the sidebar flow",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Implement sidebar changes",
          stepKey: "implement-sidebar",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      {}
    );

    expect(prompt.prompt).toContain("ALWAYS call `report_result`");
    expect(prompt.prompt).toContain("PROGRESS CHECKPOINTING:");
    expect(prompt.prompt).toContain("STEP OUTPUT FILE:");
  });

  it("removes ADE mission-tool instructions for in-process workers", () => {
    const prompt = buildFullPrompt(
      {
        run: {
          id: "run-1",
          missionId: "mission-1",
          metadata: {
            missionGoal: "Implement the sidebar flow",
          },
        } as any,
        step: {
          id: "step-1",
          title: "Implement sidebar changes",
          stepKey: "implement-sidebar",
          laneId: "lane-1",
          metadata: {},
          dependencyStepIds: [],
          joinPolicy: "all_success",
        } as any,
        attempt: {} as any,
        allSteps: [],
        contextProfile: {} as any,
        laneExport: null,
        projectExport: {
          content: "Project context body",
        } as any,
        docsRefs: [],
        fullDocs: [],
        createTrackedSession: async () => ({ ptyId: "pty-1", sessionId: "session-1" }),
      },
      "opencode",
      { workerRuntime: "in_process" }
    );

    expect(prompt.prompt).toContain("This worker is running in-process.");
    expect(prompt.prompt).toContain("RUNTIME LIMITS:");
    expect(prompt.prompt).not.toContain("ALWAYS call `report_result`");
    expect(prompt.prompt).not.toContain("ADE TOOLING:");
  });
});

describe("providerOrchestratorAdapter", () => {
  let projectRoot: string | null = null;

  beforeEach(() => {
    mockState.resolveClaudeCodeExecutable.mockReturnValue({ path: "/mock/bin/claude", source: "path" });
  });

  afterEach(() => {
    if (projectRoot) {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      projectRoot = null;
    }
  });

  it("passes Codex config-toml through to managed chat sessions", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-adapter-"));
    const createSession = vi.fn(async () => ({ id: "managed-session-1" }));
    const adapter = createProviderOrchestratorAdapter({
      projectRoot,
      workspaceRoot: projectRoot,
      agentChatService: {
        createSession,
      } as any,
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: {},
      },
      step: {
        id: "step-1",
        runId: "run-1",
        stepKey: "codex-worker",
        title: "Codex worker",
        stepIndex: 0,
        dependencyStepIds: [],
        dependencyStepKeys: [],
        laneId: "lane-1",
        status: "ready",
        metadata: {
          modelId: "openai/gpt-5.3-codex",
        },
      },
      attempt: {
        id: "attempt-1",
        runId: "run-1",
        stepId: "step-1",
      },
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "", truncated: false },
      docsRefs: [],
      fullDocs: [],
      createTrackedSession: vi.fn(),
      permissionConfig: {
        _providers: {
          claude: "full-auto",
          codex: "config-toml",
          opencode: "full-auto",
          codexSandbox: "workspace-write",
        },
      },
    } as any);

    expect(result.status).toBe("accepted");
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelId: "openai/gpt-5.3-codex",
      permissionMode: "config-toml",
      codexConfigSource: "config-toml",
    }));
  });

  it("resolves the Claude executable for direct startup-command overrides", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-adapter-"));
    mockState.resolveClaudeCodeExecutable.mockReturnValue({
      path: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      source: "path",
    });
    const createTrackedSession = vi.fn(async () => ({ ptyId: "pty-override", sessionId: "session-override" }));
    const adapter = createProviderOrchestratorAdapter({
      projectRoot,
      workspaceRoot: projectRoot,
      agentChatService: null,
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: {},
      },
      step: {
        id: "step-1",
        runId: "run-1",
        stepKey: "override-worker",
        title: "Override worker",
        stepIndex: 0,
        dependencyStepIds: [],
        dependencyStepKeys: [],
        laneId: "lane-1",
        status: "ready",
        metadata: {
          startupCommand: "diagnose the failing check",
        },
      },
      attempt: {
        id: "attempt-1",
        runId: "run-1",
        stepId: "step-1",
      },
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "", truncated: false },
      docsRefs: [],
      fullDocs: [],
      createTrackedSession,
    } as any);

    expect(result.status).toBe("accepted");
    expect(mockState.resolveClaudeCodeExecutable).toHaveBeenCalledTimes(1);
    expect(createTrackedSession).toHaveBeenCalledWith(expect.objectContaining({
      command: "C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd",
      args: ["-p", expect.stringContaining("diagnose the failing check")],
      startupCommand: expect.stringContaining("exec claude -p"),
    }));
  });

  it("launches CLI-wrapped fallback workers without shell-only command syntax", async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-provider-adapter-"));
    const createTrackedSession = vi.fn(async () => ({ ptyId: "pty-1", sessionId: "session-1" }));
    const adapter = createProviderOrchestratorAdapter({
      projectRoot,
      workspaceRoot: projectRoot,
      agentChatService: null,
    });

    const result = await adapter.start({
      run: {
        id: "run-1",
        missionId: "mission-1",
        metadata: {},
      },
      step: {
        id: "step-1",
        runId: "run-1",
        stepKey: "codex-worker",
        title: "Codex worker",
        stepIndex: 0,
        dependencyStepIds: [],
        dependencyStepKeys: [],
        laneId: "lane-1",
        status: "ready",
        metadata: {
          modelId: "openai/gpt-5.3-codex",
        },
      },
      attempt: {
        id: "attempt-1",
        runId: "run-1",
        stepId: "step-1",
      },
      allSteps: [],
      contextProfile: {} as any,
      laneExport: null,
      projectExport: { content: "Project context", truncated: false },
      docsRefs: [],
      fullDocs: [],
      createTrackedSession,
      permissionConfig: {
        _providers: {
          codex: "default",
          codexSandbox: "workspace-write",
        },
      },
    } as any);

    expect(result.status).toBe("accepted");
    expect(createTrackedSession).toHaveBeenCalledWith(expect.objectContaining({
      command: process.execPath,
      args: expect.arrayContaining(["-e"]),
      env: expect.objectContaining({
        ELECTRON_RUN_AS_NODE: "1",
        ADE_MISSION_ID: "mission-1",
        ADE_RUN_ID: "run-1",
        ADE_STEP_ID: "step-1",
        ADE_ATTEMPT_ID: "attempt-1",
        ADE_DEFAULT_ROLE: "agent",
      }),
      startupCommand: expect.stringContaining("exec codex"),
    }));
    const firstCreateArgs = (createTrackedSession.mock.calls as any[])[0]?.[0];
    expect(firstCreateArgs?.startupCommand).toContain("< ");
  });
});

describe("permissionMapping", () => {
  it("maps Codex edit to writable guarded execution", () => {
    expect(mapPermissionToCodex("edit")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "workspace-write",
    });
    expect(mapPermissionToCodex("plan")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    expect(mapPermissionToCodex("default")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
    });
  });

  it("preserves Codex full-auto and Claude accept-edits semantics", () => {
    expect(mapPermissionToCodex("full-auto")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    expect(mapPermissionToClaude("edit")).toBe("acceptEdits");
  });

  it("merges raw mission overrides without resetting unrelated provider settings", () => {
    const merged = mergeMissionPermissionConfig(
      {
        providers: {
          codex: "config-toml",
          claude: "edit",
        },
      },
      {
        inProcess: { mode: "plan" },
      },
    );

    expect(normalizeMissionPermissions(merged)).toMatchObject({
      codex: "config-toml",
      claude: "edit",
      opencode: "plan",
    });
  });
});

function createModelConfigCtx(metadata: Record<string, unknown>) {
  return {
    db: {
      get: () => ({
        metadata_json: JSON.stringify(metadata),
      }),
    },
    callTypeConfigCache: new Map(),
  } as any;
}

describe("modelConfigResolver", () => {
  it("reads mission model config from launch metadata", () => {
    const ctx = createModelConfigCtx({
      launch: {
        modelConfig: {
          orchestratorModel: {
            modelId: "openai/gpt-5.3-codex",
            provider: "codex",
            thinkingLevel: "medium",
          },
          decisionTimeoutCapHours: 12,
        },
      },
    });

    expect(resolveMissionModelConfig(ctx, "mission-1")?.orchestratorModel?.modelId).toBe("openai/gpt-5.3-codex");
    expect(resolveOrchestratorModelConfig(ctx, "mission-1", "coordinator").modelId).toBe("openai/gpt-5.3-codex");
    expect(resolveMissionDecisionTimeoutCapMs(ctx, "mission-1")).toBe(12 * 60 * 60 * 1000);
  });

  it("falls back to the legacy root model config shape", () => {
    const ctx = createModelConfigCtx({
      modelConfig: {
        orchestratorModel: {
          modelId: "anthropic/claude-sonnet-4-6",
          provider: "claude",
          thinkingLevel: "medium",
        },
        decisionTimeoutCapHours: 6,
      },
    });

    expect(resolveMissionModelConfig(ctx, "mission-2")?.orchestratorModel?.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(resolveMissionDecisionTimeoutCapMs(ctx, "mission-2")).toBe(6 * 60 * 60 * 1000);
  });
});
