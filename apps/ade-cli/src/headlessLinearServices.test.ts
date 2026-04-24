import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  syncService: {
    processIssueUpdate: vi.fn(async () => {}),
    dispose: vi.fn(),
  },
  ingressOnEvent: null as ((event: { issueId?: string | null }) => Promise<void>) | null,
}));

vi.mock("../../desktop/src/main/services/cto/linearClient", () => ({
  createLinearClient: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearIssueTracker", () => ({
  createLinearIssueTracker: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearTemplateService", () => ({
  createLinearTemplateService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearWorkflowFileService", () => ({
  createLinearWorkflowFileService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/flowPolicyService", () => ({
  createFlowPolicyService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearRoutingService", () => ({
  createLinearRoutingService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearIntakeService", () => ({
  createLinearIntakeService: vi.fn(() => ({ issueHash: vi.fn(() => "hash-current") })),
}));

vi.mock("../../desktop/src/main/services/cto/linearOutboundService", () => ({
  createLinearOutboundService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearCloseoutService", () => ({
  createLinearCloseoutService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearDispatcherService", () => ({
  createLinearDispatcherService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/cto/linearSyncService", () => ({
  createLinearSyncService: vi.fn(() => mockState.syncService),
}));

vi.mock("../../desktop/src/main/services/cto/linearIngressService", () => ({
  createLinearIngressService: vi.fn((args: { onEvent?: (event: { issueId?: string | null }) => Promise<void> }) => {
    mockState.ingressOnEvent = args.onEvent ?? null;
    return {
      canAutoStart: vi.fn(() => false),
      start: vi.fn(async () => {}),
      ensureRelayWebhook: vi.fn(async () => {}),
      getStatus: vi.fn(() => ({})),
      listRecentEvents: vi.fn(() => []),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock("../../desktop/src/main/services/cto/workerTaskSessionService", () => ({
  createWorkerTaskSessionService: vi.fn(() => ({})),
}));

vi.mock("../../desktop/src/main/services/files/fileService", () => ({
  createFileService: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/processes/processService", () => ({
  createProcessService: vi.fn(() => ({ disposeAll: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/prs/prService", () => ({
  createPrService: vi.fn(() => ({ setAgentChatService: vi.fn() })),
}));

vi.mock("../../desktop/src/main/services/automations/automationSecretService", () => ({
  createAutomationSecretService: vi.fn(() => ({})),
}));

import { createHeadlessLinearServices } from "./headlessLinearServices";

function createDeps() {
  return {
    projectRoot: "/tmp/ade-project",
    adeDir: "/tmp/ade-project/.ade",
    paths: {
      adeDir: "/tmp/ade-project/.ade",
      logsDir: "/tmp/ade-project/.ade/logs",
      processLogsDir: "/tmp/ade-project/.ade/logs/processes",
      testLogsDir: "/tmp/ade-project/.ade/logs/tests",
      transcriptsDir: "/tmp/ade-project/.ade/transcripts",
      worktreesDir: "/tmp/ade-project/.ade/worktrees",
      packsDir: "/tmp/ade-project/.ade/packs",
      dbPath: "/tmp/ade-project/.ade/ade.db",
      socketPath: "/tmp/ade-project/.ade/ade.sock",
      cacheDir: "/tmp/ade-project/.ade/cache",
      artifactsDir: "/tmp/ade-project/.ade/artifacts",
      chatSessionsDir: "/tmp/ade-project/.ade/chats/sessions",
      chatTranscriptsDir: "/tmp/ade-project/.ade/chats/transcripts",
      orchestratorCacheDir: "/tmp/ade-project/.ade/cache/orchestrator",
      missionStateDir: "/tmp/ade-project/.ade/missions",
    },
    projectId: "project-1",
    db: {} as any,
    logger: { debug() {}, info() {}, warn() {}, error() {} } as any,
    projectConfigService: {} as any,
    laneService: {} as any,
    operationService: {} as any,
    conflictService: {} as any,
    missionService: {} as any,
    orchestratorService: {} as any,
    aiOrchestratorService: {} as any,
    workerAgentService: {} as any,
    workerBudgetService: {} as any,
    computerUseArtifactBrokerService: {} as any,
    openExternal: async () => {},
  };
}

describe("headlessLinearServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockState.ingressOnEvent = null;
  });

  it("reuses identity sessions and exposes desktop-compatible session summaries", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const first = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-1",
      laneId: "lane-1",
      reuseExisting: true,
      permissionMode: "plan",
      reasoningEffort: "medium",
    });
    const second = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-1",
      laneId: "lane-2",
      reuseExisting: true,
    });

    expect(second.id).toBe(first.id);

    await services.agentChatService.sendMessage({
      sessionId: first.id,
      text: "Check the failing issue flow.",
    });

    const sessions = await services.agentChatService.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toEqual(expect.objectContaining({
      id: first.id,
      sessionId: first.id,
      laneId: "lane-1",
      identityKey: "agent:worker-1",
      status: "idle",
      startedAt: expect.any(String),
      endedAt: null,
      lastOutputPreview: null,
      summary: expect.stringContaining("Automatic agent execution is not available"),
      permissionMode: "plan",
      reasoningEffort: "medium",
    }));

    const transcript = await services.agentChatService.getChatTranscript({ sessionId: first.id });
    expect(transcript.entries).toEqual([
      expect.objectContaining({
        role: "user",
        text: "Check the failing issue flow.",
      }),
    ]);

    services.dispose();
  });

  it("fails worker-backed targets immediately instead of leaving queued headless runs behind", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const wake = await services.workerHeartbeatService.triggerWakeup({
      agentId: "worker-1",
      reason: "assignment",
      taskKey: "task-1",
      issueKey: "ABC-42",
      context: { source: "linear_workflow" },
    });

    expect(wake.status).toBe("failed");
    expect(services.workerHeartbeatService.listRuns({ limit: 10 })).toEqual([
      expect.objectContaining({
        id: wake.runId,
        agentId: "worker-1",
        status: "failed",
        taskKey: "task-1",
        issueKey: "ABC-42",
        errorMessage: expect.stringContaining("does not support worker-backed Linear targets"),
      }),
    ]);

    services.dispose();
  });

  it("forwards ingress issue events into sync processing", async () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(mockState.ingressOnEvent).toBeTypeOf("function");

    await mockState.ingressOnEvent?.({ issueId: "issue-123" });
    await mockState.ingressOnEvent?.({ issueId: null });

    expect(mockState.syncService.processIssueUpdate).toHaveBeenCalledTimes(1);
    expect(mockState.syncService.processIssueUpdate).toHaveBeenCalledWith("issue-123");

    services.dispose();
  });

  it("creates a fresh session with createSession and assigns unique ids", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1", title: "My session" });
    expect(session.id).toBeTruthy();
    expect(session.laneId).toBe("lane-1");
    expect(session.title).toBe("My session");
    expect(session.status).toBe("idle");
    expect(session.provider).toBe("codex");

    const session2 = await services.agentChatService.createSession({ laneId: "lane-2" });
    expect(session2.id).not.toBe(session.id);

    services.dispose();
  });

  it("updates session title via updateSession", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const updated = await services.agentChatService.updateSession({ sessionId: session.id, title: "Updated Title" });
    expect(updated.title).toBe("Updated Title");
    expect(updated.id).toBe(session.id);

    services.dispose();
  });

  it("getSessionSummary returns null for unknown sessions and the session for known ones", async () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(await services.agentChatService.getSessionSummary("nonexistent")).toBeNull();

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const summary = await services.agentChatService.getSessionSummary(session.id);
    expect(summary).not.toBeNull();
    expect((summary as Record<string, unknown>).id).toBe(session.id);

    services.dispose();
  });

  it("getChatTranscript respects limit and maxChars parameters", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    for (let i = 0; i < 5; i++) {
      await services.agentChatService.sendMessage({ sessionId: session.id, text: `Message ${i}` });
    }

    const transcript = await services.agentChatService.getChatTranscript({ sessionId: session.id, limit: 2 });
    expect(transcript.entries).toHaveLength(2);
    expect(transcript.totalEntries).toBe(5);
    expect(transcript.truncated).toBe(true);

    // maxChars clips text
    const longText = "x".repeat(200);
    await services.agentChatService.sendMessage({ sessionId: session.id, text: longText });
    const clipped = await services.agentChatService.getChatTranscript({ sessionId: session.id, limit: 1, maxChars: 50 });
    expect(clipped.entries[0]!.text.length).toBeLessThanOrEqual(50);

    services.dispose();
  });

  it("dispose removes session and transcript data", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:worker-dispose",
      laneId: "lane-1",
    });
    await services.agentChatService.sendMessage({ sessionId: session.id, text: "hello" });

    await services.agentChatService.dispose({ sessionId: session.id });

    const summary = await services.agentChatService.getSessionSummary(session.id);
    expect(summary).toBeNull();

    const sessions = await services.agentChatService.listSessions();
    expect(sessions.find((s) => (s as Record<string, unknown>).id === session.id)).toBeUndefined();

    services.dispose();
  });

  it("resumeSession resets status to idle and clears endedAt", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const resumed = await services.agentChatService.resumeSession({ sessionId: session.id });

    expect(resumed.status).toBe("idle");
    expect(resumed.endedAt).toBeNull();

    services.dispose();
  });

  it("interrupt updates lastActivityAt on existing session", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.createSession({ laneId: "lane-1" });
    const initialActivity = session.lastActivityAt;

    // Small delay to ensure timestamp changes
    await new Promise((resolve) => setTimeout(resolve, 5));
    await services.agentChatService.interrupt({ sessionId: session.id });

    const summary = await services.agentChatService.getSessionSummary(session.id) as Record<string, unknown>;
    expect(summary).not.toBeNull();
    // lastActivityAt should be updated (or at least not before initial)
    expect(new Date(summary.lastActivityAt as string).getTime()).toBeGreaterThanOrEqual(new Date(initialActivity).getTime());

    services.dispose();
  });

  it("ensureIdentitySession creates a new session when reuseExisting is false", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const first = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:no-reuse",
      laneId: "lane-1",
      reuseExisting: true,
    });

    const second = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:no-reuse",
      laneId: "lane-2",
      reuseExisting: false,
    });

    expect(second.id).not.toBe(first.id);

    services.dispose();
  });

  it("workerHeartbeatService listRuns respects limit and returns in LIFO order", async () => {
    const services = createHeadlessLinearServices(createDeps());

    await services.workerHeartbeatService.triggerWakeup({ agentId: "w1", reason: "timer" });
    await services.workerHeartbeatService.triggerWakeup({ agentId: "w2", reason: "manual" });
    await services.workerHeartbeatService.triggerWakeup({ agentId: "w3", reason: "api" });

    const all = services.workerHeartbeatService.listRuns({ limit: 10 });
    expect(all).toHaveLength(3);
    expect(all[0]!.agentId).toBe("w3"); // most recent first

    const limited = services.workerHeartbeatService.listRuns({ limit: 1 });
    expect(limited).toHaveLength(1);
    expect(limited[0]!.agentId).toBe("w3");

    services.dispose();
  });

  it("workerHeartbeatService dispose clears all runs", async () => {
    const services = createHeadlessLinearServices(createDeps());

    await services.workerHeartbeatService.triggerWakeup({ agentId: "w1" });
    expect(services.workerHeartbeatService.listRuns()).toHaveLength(1);

    services.workerHeartbeatService.dispose();
    expect(services.workerHeartbeatService.listRuns()).toHaveLength(0);

    services.dispose();
  });

  it("exposes all expected service properties", () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(services.linearCredentialService).toBeTruthy();
    expect(services.linearClient).toBeTruthy();
    expect(services.linearIssueTracker).toBeTruthy();
    expect(services.linearTemplateService).toBeTruthy();
    expect(services.linearWorkflowFileService).toBeTruthy();
    expect(services.flowPolicyService).toBeTruthy();
    expect(services.linearRoutingService).toBeTruthy();
    expect(services.linearIntakeService).toBeTruthy();
    expect(services.linearOutboundService).toBeTruthy();
    expect(services.linearCloseoutService).toBeTruthy();
    expect(services.linearDispatcherService).toBeTruthy();
    expect(services.linearSyncService).toBeTruthy();
    expect(services.linearIngressService).toBeTruthy();
    expect(services.fileService).toBeTruthy();
    expect(services.processService).toBeTruthy();
    expect(services.prService).toBeTruthy();
    expect(services.agentChatService).toBeTruthy();
    expect(services.workerTaskSessionService).toBeTruthy();
    expect(services.workerHeartbeatService).toBeTruthy();
    expect(typeof services.dispose).toBe("function");

    services.dispose();
  });

  it("assigns CTO default title for cto identityKey", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const session = await services.agentChatService.ensureIdentitySession({
      identityKey: "cto" as any,
      laneId: "lane-1",
    });
    expect(session.title).toBe("CTO Headless Session");
    expect(session.model).toBe("gpt-5.5");
    expect(session.modelId).toBe("openai/gpt-5.5-codex");

    services.dispose();
  });

  it("resolves explicit model IDs to their native runtime model refs in headless sessions", async () => {
    const services = createHeadlessLinearServices(createDeps());

    const codex = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:codex-model",
      laneId: "lane-1",
      modelId: "openai/gpt-5.5-codex",
    });
    const claude = await services.agentChatService.ensureIdentitySession({
      identityKey: "agent:claude-model",
      laneId: "lane-1",
      modelId: "anthropic/claude-opus-4-7-1m",
    });

    expect(codex.model).toBe("gpt-5.5");
    expect(codex.modelId).toBe("openai/gpt-5.5-codex");
    expect(claude.model).toBe("opus-1m");
    expect(claude.modelId).toBe("anthropic/claude-opus-4-7-1m");

    services.dispose();
  });

  it("ignores empty issue IDs in ingress events", async () => {
    const services = createHeadlessLinearServices(createDeps());

    expect(mockState.ingressOnEvent).toBeTypeOf("function");

    // Empty string should be ignored
    await mockState.ingressOnEvent?.({ issueId: "" });
    await mockState.ingressOnEvent?.({ issueId: "  " });

    expect(mockState.syncService.processIssueUpdate).not.toHaveBeenCalled();

    services.dispose();
  });
});
