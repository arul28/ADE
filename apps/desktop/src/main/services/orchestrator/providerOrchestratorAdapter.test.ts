import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProviderOrchestratorAdapter } from "./providerOrchestratorAdapter";

describe("providerOrchestratorAdapter", () => {
  let projectRoot: string | null = null;

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
