import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";
import type { SyncCommandPayload, SyncFileRequest, SyncRemoteCommandAction } from "../../../shared/types";

const IOS_REMOTE_COMMAND_ACTIONS = [
  "lanes.presence.announce",
  "lanes.presence.release",
  "lanes.refreshSnapshots",
  "work.listSessions",
  "prs.refresh",
  "lanes.getDetail",
  "work.updateSessionMeta",
  "prs.getMobileSnapshot",
  "work.runQuickCommand",
  "work.closeSession",
  "processes.listDefinitions",
  "processes.listRuntime",
  "processes.start",
  "processes.stop",
  "processes.kill",
  "lanes.create",
  "lanes.createFromUnstaged",
  "lanes.importBranch",
  "lanes.createChild",
  "lanes.attach",
  "lanes.adoptAttached",
  "lanes.rename",
  "lanes.reparent",
  "lanes.updateAppearance",
  "lanes.archive",
  "lanes.unarchive",
  "lanes.delete",
  "lanes.listTemplates",
  "lanes.getDefaultTemplate",
  "lanes.getEnvStatus",
  "lanes.initEnv",
  "lanes.applyTemplate",
  "lanes.rebaseStart",
  "lanes.rebasePush",
  "lanes.rebaseRollback",
  "lanes.rebaseAbort",
  "lanes.dismissRebaseSuggestion",
  "lanes.deferRebaseSuggestion",
  "lanes.dismissAutoRebaseStatus",
  "git.listBranches",
  "git.checkoutBranch",
  "git.getChanges",
  "git.getFile",
  "git.getFileHistory",
  "files.writeTextAtomic",
  "git.stageFile",
  "git.stageAll",
  "git.unstageFile",
  "git.unstageAll",
  "git.discardFile",
  "git.restoreStagedFile",
  "git.commit",
  "git.generateCommitMessage",
  "git.listRecentCommits",
  "git.listCommitFiles",
  "git.getCommitMessage",
  "git.revertCommit",
  "git.cherryPickCommit",
  "git.stashPush",
  "git.stashList",
  "git.stashApply",
  "git.stashPop",
  "git.stashDrop",
  "git.fetch",
  "git.pull",
  "git.getSyncStatus",
  "git.sync",
  "git.push",
  "git.getConflictState",
  "git.rebaseContinue",
  "git.rebaseAbort",
  "chat.models",
  "chat.listSessions",
  "chat.create",
  "chat.getSummary",
  "chat.getTranscript",
  "chat.send",
  "chat.interrupt",
  "chat.steer",
  "chat.cancelSteer",
  "chat.editSteer",
  "chat.approve",
  "chat.respondToInput",
  "chat.resume",
  "chat.updateSession",
  "chat.dispose",
  "cto.getRoster",
  "cto.ensureSession",
  "cto.ensureAgentSession",
  "prs.createFromLane",
  "prs.land",
  "prs.close",
  "prs.reopen",
  "prs.requestReviewers",
  "prs.draftDescription",
  "prs.rerunChecks",
  "prs.addComment",
  "prs.updateTitle",
  "prs.updateBody",
  "prs.setLabels",
  "prs.submitReview",
  "prs.replyToReviewThread",
  "prs.setReviewThreadResolved",
  "prs.reactToComment",
  "prs.aiReviewSummary",
  "prs.listIntegrationWorkflows",
  "prs.updateIntegrationProposal",
  "prs.deleteIntegrationProposal",
  "prs.dismissIntegrationCleanup",
  "prs.cleanupIntegrationWorkflow",
  "prs.createIntegrationLaneForProposal",
  "prs.startIntegrationResolution",
  "prs.recheckIntegrationStep",
  "prs.landQueueNext",
  "prs.pauseQueueAutomation",
  "prs.resumeQueueAutomation",
  "prs.cancelQueueAutomation",
  "prs.reorderQueue",
  "prs.getGitHubSnapshot",
  "prs.getReviewThreads",
  "prs.getActionRuns",
  "prs.getActivity",
  "prs.getDeployments",
  "prs.issueInventory.sync",
  "prs.issueInventory.get",
  "prs.issueInventory.getNew",
  "prs.issueInventory.markFixed",
  "prs.issueInventory.markDismissed",
  "prs.issueInventory.markEscalated",
  "prs.issueInventory.getConvergence",
  "prs.issueInventory.reset",
  "prs.convergenceState.get",
  "prs.convergenceState.save",
  "prs.convergenceState.delete",
  "prs.pipelineSettings.get",
  "prs.pipelineSettings.save",
  "prs.pipelineSettings.delete",
] satisfies SyncRemoteCommandAction[];

const IOS_FILE_REQUEST_ACTIONS = [
  "listWorkspaces",
  "readFile",
  "writeText",
  "createFile",
  "createDirectory",
  "rename",
  "deletePath",
  "quickOpen",
  "searchText",
  "listTree",
  "readArtifact",
] satisfies SyncFileRequest["action"][];

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createMockLaneService() {
  return {
    list: vi.fn().mockResolvedValue([]),
    refreshSnapshots: vi.fn().mockResolvedValue({ lanes: [] }),
    create: vi.fn().mockResolvedValue({ id: "lane-1" }),
    createChild: vi.fn().mockResolvedValue({ id: "child-1" }),
    createFromUnstaged: vi.fn().mockResolvedValue({ id: "unstaged-1" }),
    importBranch: vi.fn().mockResolvedValue({ id: "imported-1" }),
    attach: vi.fn().mockResolvedValue({ id: "attached-1" }),
    adoptAttached: vi.fn().mockResolvedValue({ ok: true }),
    rename: vi.fn(),
    reparent: vi.fn().mockResolvedValue({ ok: true }),
    updateAppearance: vi.fn(),
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    getStackChain: vi.fn().mockResolvedValue([]),
    getChildren: vi.fn().mockResolvedValue([]),
    rebaseStart: vi.fn().mockResolvedValue({ runId: "run-1" }),
    rebasePush: vi.fn().mockResolvedValue({ ok: true }),
    rebaseRollback: vi.fn().mockResolvedValue({ ok: true }),
    rebaseAbort: vi.fn().mockResolvedValue({ ok: true }),
    listStateSnapshots: vi.fn().mockResolvedValue([]),
    getStateSnapshot: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockPrService() {
  return {
    listAll: vi.fn().mockResolvedValue([]),
    refresh: vi.fn().mockResolvedValue(undefined),
    listSnapshots: vi.fn().mockReturnValue([]),
    getDetail: vi.fn().mockResolvedValue({}),
    getStatus: vi.fn().mockResolvedValue({}),
    getChecks: vi.fn().mockResolvedValue([]),
    getReviews: vi.fn().mockResolvedValue([]),
    getComments: vi.fn().mockResolvedValue([]),
    getFiles: vi.fn().mockResolvedValue([]),
    createFromLane: vi.fn().mockResolvedValue({ prId: "pr-1" }),
    draftDescription: vi.fn().mockResolvedValue({ title: "Draft title", body: "Draft body" }),
    land: vi.fn().mockResolvedValue({ ok: true }),
    closePr: vi.fn().mockResolvedValue(undefined),
    reopenPr: vi.fn().mockResolvedValue(undefined),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
    rerunChecks: vi.fn().mockResolvedValue(undefined),
    addComment: vi.fn().mockResolvedValue({ id: "comment-1", body: "Looks good" }),
    updateTitle: vi.fn().mockResolvedValue(undefined),
    updateBody: vi.fn().mockResolvedValue(undefined),
    setLabels: vi.fn().mockResolvedValue(undefined),
    submitReview: vi.fn().mockResolvedValue(undefined),
    replyToReviewThread: vi.fn().mockResolvedValue({ id: "comment-2" }),
    setReviewThreadResolved: vi.fn().mockResolvedValue({ threadId: "thread-1", isResolved: true }),
    reactToComment: vi.fn().mockResolvedValue(undefined),
    aiReviewSummary: vi.fn().mockResolvedValue({ summary: "ready" }),
    listIntegrationWorkflows: vi.fn().mockResolvedValue([]),
    updateIntegrationProposal: vi.fn().mockResolvedValue(undefined),
    deleteIntegrationProposal: vi.fn().mockResolvedValue({ proposalId: "proposal-1", integrationLaneId: null, deletedIntegrationLane: false }),
    dismissIntegrationCleanup: vi.fn().mockResolvedValue({ proposalId: "proposal-1", cleanupState: "declined" }),
    cleanupIntegrationWorkflow: vi.fn().mockResolvedValue({ proposalId: "proposal-1", archivedLaneIds: [], skippedLaneIds: [], workflowDisplayState: "history", cleanupState: "completed" }),
    createIntegrationLaneForProposal: vi.fn().mockResolvedValue({ integrationLaneId: "lane-int", mergedCleanLanes: [], conflictingLanes: [] }),
    startIntegrationResolution: vi.fn().mockResolvedValue({ conflictFiles: [], mergedClean: true, integrationLaneId: "lane-int" }),
    recheckIntegrationStep: vi.fn().mockResolvedValue({ resolution: "resolved", remainingConflictFiles: [], allResolved: true, message: null }),
    landQueueNext: vi.fn().mockResolvedValue({ ok: true }),
    reorderQueuePrs: vi.fn().mockResolvedValue(undefined),
    getGithubSnapshot: vi.fn().mockResolvedValue({ generatedAt: "2026-04-01T00:00:00Z", repoPullRequests: [], externalPullRequests: [], live: true }),
    getReviewThreads: vi.fn().mockResolvedValue([]),
    getActionRuns: vi.fn().mockResolvedValue([]),
    getActivity: vi.fn().mockResolvedValue([]),
    getDeployments: vi.fn().mockResolvedValue([]),
    getMobileSnapshot: vi.fn().mockResolvedValue({
      generatedAt: "2026-04-01T00:00:00Z",
      prs: [],
      stacks: [],
      capabilities: {},
      createCapabilities: { canCreateAny: false, defaultBaseBranch: null, lanes: [] },
      workflowCards: [],
      live: true,
    }),
  } as any;
}

function createMockIssueInventoryService() {
  const snapshot = {
    prId: "pr-1",
    items: [],
    convergence: {
      currentRound: 0,
      maxRounds: 5,
      issuesPerRound: [],
      totalNew: 0,
      totalFixed: 0,
      totalDismissed: 0,
      totalEscalated: 0,
      totalSentToAgent: 0,
      isConverging: false,
      canAutoAdvance: false,
    },
    runtime: {
      prId: "pr-1",
      autoConvergeEnabled: false,
      status: "idle",
      pollerStatus: "idle",
      currentRound: 0,
      activeSessionId: null,
      activeLaneId: null,
      activeHref: null,
      pauseReason: null,
      errorMessage: null,
      lastStartedAt: null,
      lastPolledAt: null,
      lastPausedAt: null,
      lastStoppedAt: null,
      createdAt: "2026-04-01T00:00:00Z",
      updatedAt: "2026-04-01T00:00:00Z",
    },
  };
  return {
    syncFromPrData: vi.fn().mockReturnValue(snapshot),
    getInventory: vi.fn().mockReturnValue(snapshot),
    getNewItems: vi.fn().mockReturnValue([]),
    markFixed: vi.fn(),
    markDismissed: vi.fn(),
    markEscalated: vi.fn(),
    getConvergenceStatus: vi.fn().mockReturnValue(snapshot.convergence),
    resetInventory: vi.fn(),
    getConvergenceRuntime: vi.fn().mockReturnValue(snapshot.runtime),
    saveConvergenceRuntime: vi.fn().mockReturnValue(snapshot.runtime),
    resetConvergenceRuntime: vi.fn(),
    getPipelineSettings: vi.fn().mockReturnValue({ autoMerge: false, mergeMethod: "repo_default", maxRounds: 5, onRebaseNeeded: "pause" }),
    savePipelineSettings: vi.fn(),
    deletePipelineSettings: vi.fn(),
  } as any;
}

function createMockQueueLandingService() {
  return {
    pauseQueue: vi.fn().mockReturnValue({ queueId: "queue-1", state: "paused" }),
    resumeQueue: vi.fn().mockReturnValue({ queueId: "queue-1", state: "landing" }),
    cancelQueue: vi.fn().mockReturnValue({ queueId: "queue-1", state: "cancelled" }),
  } as any;
}

function createMockPtyService() {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: "pty-1" }),
    dispose: vi.fn().mockResolvedValue(undefined),
    enrichSessions: vi.fn((sessions) => sessions),
  } as any;
}

function createMockSessionService() {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
  } as any;
}

function createMockFileService() {
  return {
    writeTextAtomic: vi.fn(),
  } as any;
}

function createMockGitService() {
  return {
    stageFile: vi.fn().mockResolvedValue(undefined),
    stageAll: vi.fn().mockResolvedValue(undefined),
    unstageFile: vi.fn().mockResolvedValue(undefined),
    unstageAll: vi.fn().mockResolvedValue(undefined),
    discardFile: vi.fn().mockResolvedValue(undefined),
    restoreStagedFile: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue({ sha: "abc123" }),
    generateCommitMessage: vi.fn().mockResolvedValue({ message: "feat: auto" }),
    listRecentCommits: vi.fn().mockResolvedValue([]),
    listCommitFiles: vi.fn().mockResolvedValue([]),
    getFileHistory: vi.fn().mockResolvedValue([]),
    getCommitMessage: vi.fn().mockResolvedValue({ message: "msg" }),
    revertCommit: vi.fn().mockResolvedValue(undefined),
    cherryPickCommit: vi.fn().mockResolvedValue(undefined),
    stashPush: vi.fn().mockResolvedValue(undefined),
    listStashes: vi.fn().mockResolvedValue([]),
    stashApply: vi.fn().mockResolvedValue(undefined),
    stashPop: vi.fn().mockResolvedValue(undefined),
    stashDrop: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    getSyncStatus: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    getConflictState: vi.fn().mockResolvedValue(null),
    rebaseContinue: vi.fn().mockResolvedValue(undefined),
    rebaseAbort: vi.fn().mockResolvedValue(undefined),
    listBranches: vi.fn().mockResolvedValue([]),
    checkoutBranch: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockDiffService() {
  return {
    getChanges: vi.fn().mockResolvedValue([]),
    getFileDiff: vi.fn().mockResolvedValue({}),
  } as any;
}

function createMockAgentChatService() {
  return {
    listSessions: vi.fn().mockResolvedValue([]),
    getSessionSummary: vi.fn().mockResolvedValue({
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-4",
      status: "idle",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-01-01T00:00:00.000Z",
      lastOutputPreview: null,
      summary: null,
    }),
    getChatTranscript: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({
      id: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-4",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    cancelSteer: vi.fn().mockResolvedValue(undefined),
    editSteer: vi.fn().mockResolvedValue(undefined),
    approveToolUse: vi.fn().mockResolvedValue(undefined),
    respondToInput: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    getAvailableModels: vi.fn().mockResolvedValue([{ id: "model-1", modelId: "m1" }]),
    ensureIdentitySession: vi.fn().mockResolvedValue({
      id: "chat-identity-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-4",
      status: "idle",
      createdAt: "2026-01-01T00:00:00.000Z",
      lastActivityAt: "2026-01-01T00:00:00.000Z",
    }),
  } as any;
}

function createMockConflictService() {
  return {
    getLaneStatus: vi.fn().mockResolvedValue(null),
    listOverlaps: vi.fn().mockResolvedValue([]),
    getBatchAssessment: vi.fn().mockResolvedValue({ lanes: [] }),
  } as any;
}

function createMockWorkerAgentService() {
  return {
    listAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn().mockReturnValue(null),
    saveAgent: vi.fn(),
    replaceAgentSnapshot: vi.fn(),
    removeAgent: vi.fn(),
    listOrgTree: vi.fn().mockReturnValue([]),
    getChainOfCommand: vi.fn().mockReturnValue([]),
    getCoreMemory: vi.fn(),
    updateCoreMemory: vi.fn(),
    listSessionLogs: vi.fn().mockReturnValue([]),
    appendSessionLog: vi.fn(),
    buildReconstructionContext: vi.fn().mockReturnValue(""),
    setAgentStatus: vi.fn(),
    updateAgentSpentMonthlyCents: vi.fn(),
    setAgentHeartbeatAt: vi.fn(),
  } as any;
}

function createMockProcessService() {
  return {
    listDefinitions: vi.fn().mockReturnValue([
      {
        id: "dev",
        name: "Dev server",
        command: ["npm", "run", "dev"],
        cwd: ".",
        env: {},
        groupIds: [],
        autostart: false,
        restart: "never",
        gracefulShutdownMs: 7000,
        dependsOn: [],
        readiness: { type: "none" },
      },
    ]),
    listRuntime: vi.fn().mockReturnValue([]),
    start: vi.fn().mockResolvedValue({ runId: "run-1" }),
    stop: vi.fn().mockResolvedValue(null),
    kill: vi.fn().mockResolvedValue(null),
  } as any;
}

function makePayload(action: string, args: Record<string, unknown> = {}): SyncCommandPayload {
  return { commandId: `cmd-${Date.now()}`, action: action as any, args };
}

describe("createSyncRemoteCommandService", () => {
  let laneService: ReturnType<typeof createMockLaneService>;
  let prService: ReturnType<typeof createMockPrService>;
  let ptyService: ReturnType<typeof createMockPtyService>;
  let sessionService: ReturnType<typeof createMockSessionService>;
  let fileService: ReturnType<typeof createMockFileService>;
  let gitService: ReturnType<typeof createMockGitService>;
  let diffService: ReturnType<typeof createMockDiffService>;
  let agentChatService: ReturnType<typeof createMockAgentChatService>;
  let workerAgentService: ReturnType<typeof createMockWorkerAgentService>;
  let conflictService: ReturnType<typeof createMockConflictService>;
  let processService: ReturnType<typeof createMockProcessService>;
  let issueInventoryService: ReturnType<typeof createMockIssueInventoryService>;
  let queueLandingService: ReturnType<typeof createMockQueueLandingService>;
  let service: ReturnType<typeof createSyncRemoteCommandService>;

  beforeEach(() => {
    laneService = createMockLaneService();
    prService = createMockPrService();
    ptyService = createMockPtyService();
    sessionService = createMockSessionService();
    fileService = createMockFileService();
    gitService = createMockGitService();
    diffService = createMockDiffService();
    agentChatService = createMockAgentChatService();
    workerAgentService = createMockWorkerAgentService();
    conflictService = createMockConflictService();
    processService = createMockProcessService();
    issueInventoryService = createMockIssueInventoryService();
    queueLandingService = createMockQueueLandingService();
    service = createSyncRemoteCommandService({
      laneService,
      prService,
      issueInventoryService,
      queueLandingService,
      ptyService,
      sessionService,
      fileService,
      gitService,
      diffService,
      agentChatService,
      workerAgentService,
      conflictService,
      processService,
      logger: createLogger() as any,
    });
  });

  // ---------------------------------------------------------------
  // Introspection: getSupportedActions / getDescriptors / getPolicy
  // ---------------------------------------------------------------

  describe("getSupportedActions", () => {
    it("returns a non-empty array of action strings", () => {
      const actions = service.getSupportedActions();
      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(typeof action).toBe("string");
        expect(action.length).toBeGreaterThan(0);
      }
    });

    it("includes known representative actions from each category", () => {
      const actions = service.getSupportedActions();
      expect(actions).toContain("lanes.list");
      expect(actions).toContain("lanes.create");
      expect(actions).toContain("lanes.importBranch");
      expect(actions).toContain("prs.list");
      expect(actions).toContain("prs.createFromLane");
      expect(actions).toContain("prs.draftDescription");
      expect(actions).toContain("prs.rerunChecks");
      expect(actions).toContain("prs.addComment");
      expect(actions).toContain("git.commit");
      expect(actions).toContain("git.push");
      expect(actions).toContain("git.getFileHistory");
      expect(actions).toContain("chat.create");
      expect(actions).toContain("chat.send");
      expect(actions).toContain("files.writeTextAtomic");
      expect(actions).toContain("work.listSessions");
      expect(actions).toContain("processes.listDefinitions");
      expect(actions).toContain("conflicts.getLaneStatus");
    });

    it("keeps iOS remote command names shared and registered", () => {
      const registeredActions = new Set<SyncRemoteCommandAction | string>([
        ...service.getSupportedActions(),
        "lanes.presence.announce",
        "lanes.presence.release",
      ]);
      for (const action of IOS_REMOTE_COMMAND_ACTIONS) {
        expect(registeredActions.has(action)).toBe(true);
      }
      expect(IOS_FILE_REQUEST_ACTIONS).toEqual([
        "listWorkspaces",
        "readFile",
        "writeText",
        "createFile",
        "createDirectory",
        "rename",
        "deletePath",
        "quickOpen",
        "searchText",
        "listTree",
        "readArtifact",
      ]);
    });
  });

  describe("getDescriptors", () => {
    it("returns descriptors with action and policy for every registered command", () => {
      const descriptors = service.getDescriptors();
      const actions = service.getSupportedActions();
      expect(descriptors).toHaveLength(actions.length);
      for (const desc of descriptors) {
        expect(desc).toHaveProperty("action");
        expect(desc).toHaveProperty("policy");
        expect(desc.policy).toHaveProperty("viewerAllowed");
      }
    });

    it("each descriptor action matches a supported action", () => {
      const actions = new Set(service.getSupportedActions());
      for (const desc of service.getDescriptors()) {
        expect(actions.has(desc.action as any)).toBe(true);
      }
    });
  });

  describe("getPolicy", () => {
    it("returns policy for a known action", () => {
      const policy = service.getPolicy("lanes.list");
      expect(policy).not.toBeNull();
      expect(policy!.viewerAllowed).toBe(true);
    });

    it("returns policy with queueable flag for mutating actions", () => {
      const policy = service.getPolicy("lanes.create");
      expect(policy).not.toBeNull();
      expect(policy!.queueable).toBe(true);
    });

    it("returns null for an unknown action", () => {
      const policy = service.getPolicy("totally.unknown.action");
      expect(policy).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // execute: unknown action
  // ---------------------------------------------------------------

  describe("execute — unknown action", () => {
    it("throws for an unregistered action", async () => {
      await expect(service.execute(makePayload("bogus.action")))
        .rejects.toThrow("Unsupported remote command: bogus.action");
    });
  });

  // ---------------------------------------------------------------
  // execute: lane commands
  // ---------------------------------------------------------------

  describe("execute — lane commands", () => {
    it("lanes.list routes to laneService.list", async () => {
      await service.execute(makePayload("lanes.list", { includeArchived: true }));
      expect(laneService.list).toHaveBeenCalledWith({
        includeArchived: true,
        includeStatus: undefined,
      });
    });

    it("lanes.create parses name and routes to laneService.create", async () => {
      await service.execute(makePayload("lanes.create", {
        name: "my-lane",
        description: "desc",
        baseBranch: "main",
      }));
      expect(laneService.create).toHaveBeenCalledWith({
        name: "my-lane",
        description: "desc",
        baseBranch: "main",
      });
    });

    it("lanes.create throws when name is missing", async () => {
      await expect(service.execute(makePayload("lanes.create", {})))
        .rejects.toThrow("lanes.create requires name.");
    });

    it("lanes.createChild parses name + parentLaneId", async () => {
      await service.execute(makePayload("lanes.createChild", {
        name: "child-lane",
        parentLaneId: "parent-1",
      }));
      expect(laneService.createChild).toHaveBeenCalledWith({
        name: "child-lane",
        parentLaneId: "parent-1",
      });
    });

    it("lanes.createChild throws when parentLaneId is missing", async () => {
      await expect(service.execute(makePayload("lanes.createChild", { name: "child" })))
        .rejects.toThrow("lanes.createChild requires parentLaneId.");
    });

    it("lanes.importBranch parses branchRef and optional metadata", async () => {
      const result = await service.execute(makePayload("lanes.importBranch", {
        branchRef: "origin/feature/mobile",
        name: "Mobile import",
        description: "Imported from mobile",
        baseBranch: "main",
      }));
      expect(laneService.importBranch).toHaveBeenCalledWith({
        branchRef: "origin/feature/mobile",
        name: "Mobile import",
        description: "Imported from mobile",
        baseBranch: "main",
      });
      expect(result).toEqual({ id: "imported-1" });
    });

    it("lanes.importBranch throws when branchRef is missing", async () => {
      await expect(service.execute(makePayload("lanes.importBranch", {})))
        .rejects.toThrow("lanes.importBranch requires branchRef.");
    });

    it("lanes.rename parses laneId and name", async () => {
      await service.execute(makePayload("lanes.rename", {
        laneId: "lane-1",
        name: "new-name",
      }));
      expect(laneService.rename).toHaveBeenCalledWith({
        laneId: "lane-1",
        name: "new-name",
      });
    });

    it("lanes.archive routes to laneService.archive", async () => {
      const result = await service.execute(makePayload("lanes.archive", { laneId: "lane-1" }));
      expect(laneService.archive).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(result).toEqual({ ok: true });
    });

    it("lanes.delete parses all optional flags", async () => {
      await service.execute(makePayload("lanes.delete", {
        laneId: "lane-1",
        deleteBranch: true,
        deleteRemoteBranch: false,
        force: true,
      }));
      expect(laneService.delete).toHaveBeenCalledWith({
        laneId: "lane-1",
        deleteBranch: true,
        deleteRemoteBranch: false,
        force: true,
      });
    });

    it("lanes.getStackChain requires laneId", async () => {
      await expect(service.execute(makePayload("lanes.getStackChain", {})))
        .rejects.toThrow("lanes.getStackChain requires laneId.");
    });
  });

  // ---------------------------------------------------------------
  // execute: PR commands
  // ---------------------------------------------------------------

  describe("execute — PR commands", () => {
    it("prs.list routes to prService.listAll", async () => {
      const result = await service.execute(makePayload("prs.list"));
      expect(prService.listAll).toHaveBeenCalled();
      expect(result).toEqual([]);
    });

    it("prs.getDetail requires prId", async () => {
      await expect(service.execute(makePayload("prs.getDetail", {})))
        .rejects.toThrow("prs.getDetail requires prId.");
    });

    it("prs.getDetail routes to prService.getDetail", async () => {
      const result = await service.execute(makePayload("prs.getDetail", { prId: "pr-42" }));
      expect(prService.getDetail).toHaveBeenCalledWith("pr-42");
      expect(result).toEqual({});
    });

    it("prs.createFromLane parses laneId + title + draft", async () => {
      await service.execute(makePayload("prs.createFromLane", {
        laneId: "lane-1",
        title: "My PR",
        body: "Description",
        draft: true,
      }));
      expect(prService.createFromLane).toHaveBeenCalledWith({
        laneId: "lane-1",
        title: "My PR",
        body: "Description",
        draft: true,
      });
    });

    it("prs.createFromLane throws when laneId or title is missing", async () => {
      await expect(service.execute(makePayload("prs.createFromLane", { laneId: "lane-1" })))
        .rejects.toThrow("prs.createFromLane requires laneId and title.");
    });

    it("prs.draftDescription parses laneId and optional model controls", async () => {
      const result = await service.execute(makePayload("prs.draftDescription", {
        laneId: "lane-1",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      }));
      expect(prService.draftDescription).toHaveBeenCalledWith({
        laneId: "lane-1",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      });
      expect(result).toEqual({ title: "Draft title", body: "Draft body" });
    });

    it("prs.land validates method enum", async () => {
      await expect(service.execute(makePayload("prs.land", {
        prId: "pr-1",
        method: "invalid-method",
      }))).rejects.toThrow("prs.land requires method to be merge, squash, or rebase.");
    });

    it("prs.land routes with valid method", async () => {
      await service.execute(makePayload("prs.land", {
        prId: "pr-1",
        method: "squash",
      }));
      expect(prService.land).toHaveBeenCalledWith({
        prId: "pr-1",
        method: "squash",
      });
    });

    it("prs.close routes to prService.closePr", async () => {
      const result = await service.execute(makePayload("prs.close", {
        prId: "pr-1",
        comment: "closing",
      }));
      expect(prService.closePr).toHaveBeenCalledWith({
        prId: "pr-1",
        comment: "closing",
      });
      expect(result).toEqual({ ok: true });
    });

    it("prs.requestReviewers throws when reviewers array is empty", async () => {
      await expect(service.execute(makePayload("prs.requestReviewers", {
        prId: "pr-1",
        reviewers: [],
      }))).rejects.toThrow("prs.requestReviewers requires at least one reviewer.");
    });

    it("prs.requestReviewers routes with valid reviewers", async () => {
      const result = await service.execute(makePayload("prs.requestReviewers", {
        prId: "pr-1",
        reviewers: ["alice", "bob"],
      }));
      expect(prService.requestReviewers).toHaveBeenCalledWith({
        prId: "pr-1",
        reviewers: ["alice", "bob"],
      });
      expect(result).toEqual({ ok: true });
    });

    it("prs.rerunChecks parses optional checkRunIds", async () => {
      const result = await service.execute(makePayload("prs.rerunChecks", {
        prId: "pr-1",
        checkRunIds: [101, 202],
      }));
      expect(prService.rerunChecks).toHaveBeenCalledWith({
        prId: "pr-1",
        checkRunIds: [101, 202],
      });
      expect(result).toEqual({ ok: true });
    });

    it("prs.rerunChecks rejects invalid checkRunIds", async () => {
      await expect(service.execute(makePayload("prs.rerunChecks", {
        prId: "pr-1",
        checkRunIds: [101, "bad"],
      }))).rejects.toThrow("prs.rerunChecks requires checkRunIds to be an array of numbers when provided.");
    });

    it("prs.addComment parses body and optional reply target", async () => {
      const result = await service.execute(makePayload("prs.addComment", {
        prId: "pr-1",
        body: "Looks good",
        inReplyToCommentId: "comment-parent",
      }));
      expect(prService.addComment).toHaveBeenCalledWith({
        prId: "pr-1",
        body: "Looks good",
        inReplyToCommentId: "comment-parent",
      });
      expect(result).toEqual({ id: "comment-1", body: "Looks good" });
    });

    it("prs.getMobileSnapshot is viewer-allowed and returns the aggregated payload", async () => {
      const policy = service.getPolicy("prs.getMobileSnapshot");
      expect(policy).not.toBeNull();
      expect(policy!.viewerAllowed).toBe(true);

      const result = await service.execute(makePayload("prs.getMobileSnapshot")) as Record<string, unknown>;
      expect(prService.getMobileSnapshot).toHaveBeenCalledTimes(1);
      expect(result).toHaveProperty("prs");
      expect(result).toHaveProperty("stacks");
      expect(result).toHaveProperty("capabilities");
      expect(result).toHaveProperty("createCapabilities");
      expect(result).toHaveProperty("workflowCards");
      expect(result).toHaveProperty("live", true);
    });
  });

  // ---------------------------------------------------------------
  // execute: git commands
  // ---------------------------------------------------------------

  describe("execute — git commands", () => {
    it("git.commit parses laneId + message", async () => {
      await service.execute(makePayload("git.commit", {
        laneId: "lane-1",
        message: "fix: bug",
      }));
      expect(gitService.commit).toHaveBeenCalledWith({
        laneId: "lane-1",
        message: "fix: bug",
        amend: undefined,
      });
    });

    it("git.commit throws when message is missing", async () => {
      await expect(service.execute(makePayload("git.commit", { laneId: "lane-1" })))
        .rejects.toThrow("git.commit requires message.");
    });

    it("git.commit throws when laneId is missing", async () => {
      await expect(service.execute(makePayload("git.commit", { message: "fix" })))
        .rejects.toThrow("git.commit requires laneId.");
    });

    it("git.push parses forceWithLease flag", async () => {
      await service.execute(makePayload("git.push", {
        laneId: "lane-1",
        forceWithLease: true,
      }));
      expect(gitService.push).toHaveBeenCalledWith({
        laneId: "lane-1",
        forceWithLease: true,
      });
    });

    it("git.stageFile requires laneId and path", async () => {
      await service.execute(makePayload("git.stageFile", {
        laneId: "lane-1",
        path: "src/index.ts",
      }));
      expect(gitService.stageFile).toHaveBeenCalledWith({
        laneId: "lane-1",
        path: "src/index.ts",
      });
    });

    it("git.stageFile throws when path is missing", async () => {
      await expect(service.execute(makePayload("git.stageFile", { laneId: "lane-1" })))
        .rejects.toThrow("git.stageFile requires path.");
    });

    it("git.stageAll requires laneId and paths", async () => {
      await service.execute(makePayload("git.stageAll", {
        laneId: "lane-1",
        paths: ["a.ts", "b.ts"],
      }));
      expect(gitService.stageAll).toHaveBeenCalledWith({
        laneId: "lane-1",
        paths: ["a.ts", "b.ts"],
      });
    });

    it("git.listRecentCommits passes laneId and optional limit", async () => {
      await service.execute(makePayload("git.listRecentCommits", {
        laneId: "lane-1",
        limit: 5,
      }));
      expect(gitService.listRecentCommits).toHaveBeenCalledWith({
        laneId: "lane-1",
        limit: 5,
      });
    });

    it("git.revertCommit requires laneId and commitSha", async () => {
      await service.execute(makePayload("git.revertCommit", {
        laneId: "lane-1",
        commitSha: "abc123",
      }));
      expect(gitService.revertCommit).toHaveBeenCalledWith({
        laneId: "lane-1",
        commitSha: "abc123",
      });
    });

    it("git.revertCommit throws when commitSha is missing", async () => {
      await expect(service.execute(makePayload("git.revertCommit", { laneId: "lane-1" })))
        .rejects.toThrow("git.revertCommit requires commitSha.");
    });

    it("git.sync parses optional mode and baseRef", async () => {
      await service.execute(makePayload("git.sync", {
        laneId: "lane-1",
        mode: "rebase",
        baseRef: "main",
      }));
      expect(gitService.sync).toHaveBeenCalledWith({
        laneId: "lane-1",
        mode: "rebase",
        baseRef: "main",
      });
    });

    it("git.checkoutBranch requires laneId and branchName", async () => {
      await service.execute(makePayload("git.checkoutBranch", {
        laneId: "lane-1",
        branchName: "feature/new",
      }));
      expect(gitService.checkoutBranch).toHaveBeenCalledWith({
        laneId: "lane-1",
        branchName: "feature/new",
      });
    });

    it("git.checkoutBranch throws when branchName is missing", async () => {
      await expect(service.execute(makePayload("git.checkoutBranch", { laneId: "lane-1" })))
        .rejects.toThrow("git.checkoutBranch requires branchName.");
    });
  });

  // ---------------------------------------------------------------
  // execute: git commands (when gitService is not provided)
  // ---------------------------------------------------------------

  describe("execute — git commands without gitService", () => {
    it("throws when gitService is not available", async () => {
      const svcNoGit = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        logger: createLogger() as any,
      });
      await expect(svcNoGit.execute(makePayload("git.commit", {
        laneId: "lane-1",
        message: "fix",
      }))).rejects.toThrow("Git service not available.");
    });
  });

  // ---------------------------------------------------------------
  // execute: diff / file commands
  // ---------------------------------------------------------------

  describe("execute — diff and file commands", () => {
    it("git.getChanges routes to diffService.getChanges", async () => {
      await service.execute(makePayload("git.getChanges", { laneId: "lane-1" }));
      expect(diffService.getChanges).toHaveBeenCalledWith("lane-1");
    });

    it("git.getChanges throws when diffService is not available", async () => {
      const svcNoDiff = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        logger: createLogger() as any,
      });
      await expect(svcNoDiff.execute(makePayload("git.getChanges", { laneId: "lane-1" })))
        .rejects.toThrow("Diff service not available.");
    });

    it("files.writeTextAtomic parses laneId + path + text", async () => {
      const result = await service.execute(makePayload("files.writeTextAtomic", {
        laneId: "lane-1",
        path: "readme.md",
        text: "hello world",
      }));
      expect(fileService.writeTextAtomic).toHaveBeenCalledWith({
        laneId: "lane-1",
        relPath: "readme.md",
        text: "hello world",
      });
      expect(result).toEqual({ ok: true });
    });

    it("files.writeTextAtomic throws when text is not a string", async () => {
      await expect(service.execute(makePayload("files.writeTextAtomic", {
        laneId: "lane-1",
        path: "readme.md",
        text: 42,
      }))).rejects.toThrow("files.writeTextAtomic requires text.");
    });

    it("files.writeTextAtomic allows empty string text", async () => {
      await service.execute(makePayload("files.writeTextAtomic", {
        laneId: "lane-1",
        path: "empty.txt",
        text: "",
      }));
      expect(fileService.writeTextAtomic).toHaveBeenCalledWith({
        laneId: "lane-1",
        relPath: "empty.txt",
        text: "",
      });
    });
  });

  // ---------------------------------------------------------------
  // execute: chat commands
  // ---------------------------------------------------------------

  describe("execute — chat commands", () => {
    it("chat.create parses laneId + provider + model and returns a mobile summary", async () => {
      const result = await service.execute(makePayload("chat.create", {
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
      }));
      expect(agentChatService.createSession).toHaveBeenCalledWith({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
      });
      expect(agentChatService.getSessionSummary).toHaveBeenCalledWith("chat-1");
      expect(result).toEqual(expect.objectContaining({ sessionId: "chat-1", startedAt: "2026-01-01T00:00:00.000Z" }));
    });

    it("chat.create resolves model from available models when model is empty", async () => {
      await service.execute(makePayload("chat.create", {
        laneId: "lane-1",
        provider: "codex",
        model: "",
      }));
      expect(agentChatService.getAvailableModels).toHaveBeenCalledWith({ provider: "codex" });
      expect(agentChatService.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ model: "model-1", modelId: "m1" }),
      );
    });

    it("chat.create forwards runtime, profile, cursor config, and cwd fields", async () => {
      await service.execute(makePayload("chat.create", {
        laneId: "lane-1",
        provider: "cursor",
        model: "cursor-agent",
        sessionProfile: "workflow",
        reasoningEffort: "medium",
        permissionMode: "edit",
        interactionMode: "default",
        claudePermissionMode: "acceptEdits",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        cursorModeId: "ask",
        cursorConfigValues: {
          mode: "ask",
          enabled: true,
          temperature: 0.5,
        },
        requestedCwd: "apps/ios",
      }));

      expect(agentChatService.createSession).toHaveBeenCalledWith({
        laneId: "lane-1",
        provider: "cursor",
        model: "cursor-agent",
        sessionProfile: "workflow",
        reasoningEffort: "medium",
        permissionMode: "edit",
        interactionMode: "default",
        claudePermissionMode: "acceptEdits",
        codexApprovalPolicy: "on-request",
        codexSandbox: "workspace-write",
        codexConfigSource: "flags",
        opencodePermissionMode: "edit",
        cursorModeId: "ask",
        cursorConfigValues: {
          mode: "ask",
          enabled: true,
          temperature: 0.5,
        },
        requestedCwd: "apps/ios",
      });
    });

    it("chat.send requires sessionId and text", async () => {
      const result = await service.execute(makePayload("chat.send", {
        sessionId: "sess-1",
        text: "hello",
      }));
      expect(agentChatService.sendMessage).toHaveBeenCalledWith({
        sessionId: "sess-1",
        text: "hello",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.send throws when text is missing", async () => {
      await expect(service.execute(makePayload("chat.send", { sessionId: "sess-1" })))
        .rejects.toThrow("chat.send requires text.");
    });

    it("chat.updateSession forwards cursor mode and config values", async () => {
      await service.execute(makePayload("chat.updateSession", {
        sessionId: "sess-1",
        cursorModeId: "ask",
        cursorConfigValues: {
          mode: "ask",
          enabled: true,
          temperature: 0.5,
        },
      }));

      expect(agentChatService.updateSession).toHaveBeenCalledWith({
        sessionId: "sess-1",
        cursorModeId: "ask",
        cursorConfigValues: {
          mode: "ask",
          enabled: true,
          temperature: 0.5,
        },
      });
    });

    it("chat.dispose routes to agentChatService.dispose", async () => {
      const result = await service.execute(makePayload("chat.dispose", {
        sessionId: "sess-1",
      }));
      expect(agentChatService.dispose).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
    });

    it("chat.interrupt routes to agentChatService.interrupt", async () => {
      const result = await service.execute(makePayload("chat.interrupt", {
        sessionId: "sess-1",
      }));
      expect(agentChatService.interrupt).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
    });

    it("chat.interrupt throws when sessionId is missing", async () => {
      await expect(service.execute(makePayload("chat.interrupt", {})))
        .rejects.toThrow("chat.interrupt requires sessionId.");
    });

    it("chat.steer routes to agentChatService.steer", async () => {
      const result = await service.execute(makePayload("chat.steer", {
        sessionId: "sess-1",
        text: "change direction",
      }));
      expect(agentChatService.steer).toHaveBeenCalledWith({
        sessionId: "sess-1",
        text: "change direction",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.steer throws when text is missing", async () => {
      await expect(service.execute(makePayload("chat.steer", { sessionId: "sess-1" })))
        .rejects.toThrow("chat.steer requires text.");
    });

    it("chat.cancelSteer routes to agentChatService.cancelSteer", async () => {
      const result = await service.execute(makePayload("chat.cancelSteer", {
        sessionId: "sess-1",
        steerId: "steer-9",
      }));
      expect(agentChatService.cancelSteer).toHaveBeenCalledWith({
        sessionId: "sess-1",
        steerId: "steer-9",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.cancelSteer throws when steerId is missing", async () => {
      await expect(service.execute(makePayload("chat.cancelSteer", { sessionId: "sess-1" })))
        .rejects.toThrow("chat.cancelSteer requires steerId.");
    });

    it("chat.editSteer routes to agentChatService.editSteer", async () => {
      const result = await service.execute(makePayload("chat.editSteer", {
        sessionId: "sess-1",
        steerId: "steer-9",
        text: "updated instruction",
      }));
      expect(agentChatService.editSteer).toHaveBeenCalledWith({
        sessionId: "sess-1",
        steerId: "steer-9",
        text: "updated instruction",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.editSteer throws when text is missing", async () => {
      await expect(service.execute(makePayload("chat.editSteer", {
        sessionId: "sess-1",
        steerId: "steer-9",
      })))
        .rejects.toThrow("chat.editSteer requires text.");
    });

    // ==========================================================
    // parseAgentChatSendArgs / parseAgentChatSteerArgs extensions
    // ==========================================================

    describe("parseAgentChatSendArgs (via chat.send) — new attachment / metadata fields", () => {
      it("returns only sessionId and text when no optional metadata is provided", async () => {
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "plain",
        }));
        expect(agentChatService.sendMessage).toHaveBeenCalledTimes(1);
        const sentArg = agentChatService.sendMessage.mock.calls[0][0] as Record<string, unknown>;
        expect(sentArg).toEqual({ sessionId: "sess-1", text: "plain" });
        // Explicitly ensure none of the new optional keys leaked in.
        expect(sentArg).not.toHaveProperty("displayText");
        expect(sentArg).not.toHaveProperty("attachments");
        expect(sentArg).not.toHaveProperty("reasoningEffort");
        expect(sentArg).not.toHaveProperty("executionMode");
        expect(sentArg).not.toHaveProperty("interactionMode");
      });

      it("includes valid attachments when path + type are well-formed", async () => {
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "hello",
          attachments: [
            { path: "a", type: "image" },
            { path: "b", type: "file" },
          ],
        }));
        expect(agentChatService.sendMessage).toHaveBeenCalledWith({
          sessionId: "sess-1",
          text: "hello",
          attachments: [
            { path: "a", type: "image" },
            { path: "b", type: "file" },
          ],
        });
      });

      it("filters out attachment entries missing a valid path or valid type", async () => {
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "hello",
          attachments: [
            { path: "ok", type: "file" },
            { path: "   ", type: "image" }, // whitespace-only path
            { path: "no-type" }, // missing type
            { path: "bad-type", type: "binary" }, // unknown type
            "not-a-record", // not an object
            null,
            { type: "file" }, // missing path entirely
          ],
        }));
        const sent = agentChatService.sendMessage.mock.calls[0][0] as { attachments?: unknown[] };
        expect(sent.attachments, "only the single valid entry should survive").toEqual([
          { path: "ok", type: "file" },
        ]);
      });

      it("omits attachments entirely when every entry is invalid", async () => {
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "hello",
          attachments: [
            { path: "", type: "file" },
            { type: "image" },
            { path: "x" },
          ],
        }));
        const sent = agentChatService.sendMessage.mock.calls[0][0] as Record<string, unknown>;
        expect(sent, "attachments key must be omitted when no valid entries").not.toHaveProperty("attachments");
      });

      it("ignores non-array attachments values (object, string, undefined)", async () => {
        for (const attachments of [{ not: "array" }, "image", 42, null]) {
          agentChatService.sendMessage.mockClear();
          await service.execute(makePayload("chat.send", {
            sessionId: "sess-1",
            text: "hello",
            attachments,
          }));
          const sent = agentChatService.sendMessage.mock.calls[0][0] as Record<string, unknown>;
          expect(sent, `non-array attachments (${JSON.stringify(attachments)}) must not attach anything`).not.toHaveProperty("attachments");
        }
      });

      it("includes displayText, reasoningEffort, executionMode, interactionMode only when non-empty strings", async () => {
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "hello",
          displayText: "shown to user",
          reasoningEffort: "high",
          executionMode: "autonomous",
          interactionMode: "chat",
        }));
        expect(agentChatService.sendMessage).toHaveBeenCalledWith({
          sessionId: "sess-1",
          text: "hello",
          displayText: "shown to user",
          reasoningEffort: "high",
          executionMode: "autonomous",
          interactionMode: "chat",
        });
      });

      it("trims string metadata and omits empty/blank values", async () => {
        agentChatService.sendMessage.mockClear();
        await service.execute(makePayload("chat.send", {
          sessionId: "sess-1",
          text: "hello",
          displayText: "  padded  ",
          reasoningEffort: "",
          executionMode: "   ",
          interactionMode: 42, // non-string, must be ignored
        }));
        const sent = agentChatService.sendMessage.mock.calls[0][0] as Record<string, unknown>;
        expect(sent.displayText, "displayText should be trimmed").toBe("padded");
        expect(sent, "reasoningEffort empty string should be omitted").not.toHaveProperty("reasoningEffort");
        expect(sent, "executionMode whitespace-only should be omitted").not.toHaveProperty("executionMode");
        expect(sent, "non-string interactionMode should be omitted").not.toHaveProperty("interactionMode");
      });
    });

    describe("parseAgentChatSteerArgs — new attachments support", () => {
      it("includes attachments when present and valid", async () => {
        await service.execute(makePayload("chat.steer", {
          sessionId: "sess-1",
          text: "redirect",
          attachments: [
            { path: "img.png", type: "image" },
            { path: "notes.txt", type: "file" },
          ],
        }));
        expect(agentChatService.steer).toHaveBeenCalledWith({
          sessionId: "sess-1",
          text: "redirect",
          attachments: [
            { path: "img.png", type: "image" },
            { path: "notes.txt", type: "file" },
          ],
        });
      });

      it("omits attachments when array has no valid entries", async () => {
        agentChatService.steer.mockClear();
        await service.execute(makePayload("chat.steer", {
          sessionId: "sess-1",
          text: "redirect",
          attachments: [{ path: "", type: "image" }, { type: "file" }],
        }));
        const sent = agentChatService.steer.mock.calls[0][0] as Record<string, unknown>;
        expect(sent, "no valid attachments → key omitted").not.toHaveProperty("attachments");
        expect(sent).toEqual({ sessionId: "sess-1", text: "redirect" });
      });

      it("still throws when text is missing even if attachments are provided", async () => {
        await expect(service.execute(makePayload("chat.steer", {
          sessionId: "sess-1",
          attachments: [{ path: "x", type: "file" }],
        }))).rejects.toThrow("chat.steer requires text.");
      });
    });

    it("chat.resume routes to agentChatService.resumeSession", async () => {
      await service.execute(makePayload("chat.resume", {
        sessionId: "sess-1",
      }));
      expect(agentChatService.resumeSession).toHaveBeenCalledWith({ sessionId: "sess-1" });
    });

    it("chat.resume throws when sessionId is missing", async () => {
      await expect(service.execute(makePayload("chat.resume", {})))
        .rejects.toThrow("chat.resume requires sessionId.");
    });

    it("chat.models returns available models for a provider", async () => {
      await service.execute(makePayload("chat.models", { provider: "codex" }));
      expect(agentChatService.getAvailableModels).toHaveBeenCalledWith({ provider: "codex" });
    });

    it("chat commands throw when agentChatService is not available", async () => {
      const svcNoChat = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        logger: createLogger() as any,
      });
      await expect(svcNoChat.execute(makePayload("chat.send", {
        sessionId: "s1",
        text: "hi",
      }))).rejects.toThrow("Agent chat service not available.");
    });
  });

  // ---------------------------------------------------------------
  // execute: work (session) commands
  // ---------------------------------------------------------------

  describe("execute — work commands", () => {
    it("work.listSessions routes to sessionService.list", async () => {
      await service.execute(makePayload("work.listSessions", { laneId: "lane-1" }));
      expect(sessionService.list).toHaveBeenCalledWith(
        expect.objectContaining({ laneId: "lane-1" }),
      );
    });

    it("work.runQuickCommand parses laneId + title + startupCommand", async () => {
      await service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "test run",
        startupCommand: "npm test",
        toolType: "run-shell",
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "test run",
          startupCommand: "npm test",
          toolType: "run-shell",
        }),
      );
    });

    it("work.runQuickCommand throws when startupCommand is missing and toolType is not shell", async () => {
      await expect(service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "test",
        toolType: "run-shell",
      }))).rejects.toThrow("work.runQuickCommand requires startupCommand unless toolType is shell.");
    });

    it("work.runQuickCommand allows missing startupCommand when toolType is shell", async () => {
      await service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "shell session",
        toolType: "shell",
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "shell session",
          toolType: "shell",
        }),
      );
    });

    it("work.closeSession disposes pty if session has a ptyId", async () => {
      sessionService.get.mockReturnValue({ ptyId: "pty-42" });
      const result = await service.execute(makePayload("work.closeSession", {
        sessionId: "sess-1",
      }));
      expect(sessionService.get).toHaveBeenCalledWith("sess-1");
      expect(ptyService.dispose).toHaveBeenCalledWith({ ptyId: "pty-42", sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
    });

    it("work.closeSession skips pty disposal when the session has no ptyId", async () => {
      sessionService.get.mockReturnValue(null);
      const result = await service.execute(makePayload("work.closeSession", {
        sessionId: "sess-1",
      }));
      expect(sessionService.get).toHaveBeenCalledWith("sess-1");
      expect(ptyService.dispose).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });
  });

  // ---------------------------------------------------------------
  // execute: process commands
  // ---------------------------------------------------------------

  describe("execute — process commands", () => {
    it("processes.listDefinitions routes to processService.listDefinitions", async () => {
      const result = await service.execute(makePayload("processes.listDefinitions"));
      expect(processService.listDefinitions).toHaveBeenCalled();
      expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ id: "dev" })]));
    });

    it("processes.listRuntime requires laneId and routes to processService.listRuntime", async () => {
      await service.execute(makePayload("processes.listRuntime", { laneId: "lane-1" }));
      expect(processService.listRuntime).toHaveBeenCalledWith("lane-1");
    });

    it("processes.start parses laneId and processId", async () => {
      await service.execute(makePayload("processes.start", { laneId: "lane-1", processId: "dev" }));
      expect(processService.start).toHaveBeenCalledWith({ laneId: "lane-1", processId: "dev" });
    });

    it("processes.kill preserves the target runId", async () => {
      await service.execute(makePayload("processes.kill", { laneId: "lane-1", processId: "dev", runId: "run-1" }));
      expect(processService.kill).toHaveBeenCalledWith({ laneId: "lane-1", processId: "dev", runId: "run-1" });
    });

    it("process commands throw when processService is not available", async () => {
      const svcNoProcess = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        logger: createLogger() as any,
      });
      await expect(svcNoProcess.execute(makePayload("processes.listDefinitions")))
        .rejects.toThrow("Process service not available.");
    });
  });

  // ---------------------------------------------------------------
  // execute: conflict commands
  // ---------------------------------------------------------------

  describe("execute — conflict commands", () => {
    it("conflicts.getLaneStatus routes to conflictService", async () => {
      await service.execute(makePayload("conflicts.getLaneStatus", { laneId: "lane-1" }));
      expect(conflictService.getLaneStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
    });

    it("conflicts.getBatchAssessment routes with no args", async () => {
      await service.execute(makePayload("conflicts.getBatchAssessment"));
      expect(conflictService.getBatchAssessment).toHaveBeenCalled();
    });

    it("conflicts commands throw when conflictService is not available", async () => {
      const svcNoConflict = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        logger: createLogger() as any,
      });
      await expect(svcNoConflict.execute(makePayload("conflicts.getLaneStatus", { laneId: "lane-1" })))
        .rejects.toThrow("Conflict service not available.");
    });
  });

  // ---------------------------------------------------------------
  // execute: args edge cases / parse helpers via execute
  // ---------------------------------------------------------------

  describe("execute — argument parsing edge cases", () => {
    it("trims whitespace from string args", async () => {
      await service.execute(makePayload("lanes.create", { name: "  my-lane  " }));
      expect(laneService.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: "my-lane" }),
      );
    });

    it("rejects empty-after-trim string for required fields", async () => {
      await expect(service.execute(makePayload("lanes.create", { name: "   " })))
        .rejects.toThrow("lanes.create requires name.");
    });

    it("ignores non-boolean values for optional boolean fields", async () => {
      await service.execute(makePayload("lanes.list", {
        includeArchived: "yes" as any,
      }));
      expect(laneService.list).toHaveBeenCalledWith({
        includeArchived: undefined,
        includeStatus: undefined,
      });
    });

    it("ignores non-number values for optional number fields", async () => {
      await service.execute(makePayload("work.listSessions", {
        limit: "ten" as any,
      }));
      expect(sessionService.list).toHaveBeenCalledWith({});
    });

    it("handles payload.args being non-object by defaulting to empty record", async () => {
      const result = await service.execute({
        commandId: "cmd-1",
        action: "prs.list",
        args: "not-an-object" as any,
      });
      expect(prService.listAll).toHaveBeenCalled();
    });

    it("filters non-string entries from string arrays", async () => {
      await service.execute(makePayload("prs.requestReviewers", {
        prId: "pr-1",
        reviewers: ["alice", 42, null, "bob", ""],
      }));
      expect(prService.requestReviewers).toHaveBeenCalledWith({
        prId: "pr-1",
        reviewers: ["alice", "bob"],
      });
    });
  });

  // ---------------------------------------------------------------
  // execute: cto commands
  // ---------------------------------------------------------------

  describe("execute — cto commands", () => {
    it("cto.getRoster returns null cto and empty workers when nothing registered", async () => {
      agentChatService.listSessions.mockResolvedValueOnce([]);
      workerAgentService.listAgents.mockReturnValueOnce([]);
      const result = await service.execute(makePayload("cto.getRoster", {}));
      expect(result).toEqual({ cto: null, workers: [] });
    });

    it("cto.getRoster pairs CTO session + worker sessions by identityKey", async () => {
      const ctoSummary = {
        sessionId: "sess-cto",
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet",
        status: "idle",
        identityKey: "cto",
        startedAt: "2026-04-01T00:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-04-01T00:10:00.000Z",
        lastOutputPreview: null,
        summary: null,
      };
      const workerSummary = {
        sessionId: "sess-agent-42",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        status: "running",
        identityKey: "agent:worker-42",
        startedAt: "2026-04-01T00:05:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-04-01T00:06:00.000Z",
        lastOutputPreview: null,
        summary: null,
      };
      agentChatService.listSessions.mockResolvedValueOnce([ctoSummary, workerSummary]);
      workerAgentService.listAgents.mockReturnValueOnce([
        {
          id: "worker-42",
          name: "Mobile Droid",
          slug: "mobile-droid",
          role: "engineer",
          status: "running",
          reportsTo: null,
          capabilities: [],
          adapterType: "claude-local",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);
      const result = await service.execute(makePayload("cto.getRoster", {})) as {
        cto: unknown;
        workers: Array<Record<string, unknown>>;
      };
      expect(agentChatService.listSessions).toHaveBeenCalledWith(undefined, { includeIdentity: true });
      expect(result.cto).toEqual(ctoSummary);
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0]).toEqual({
        agentId: "worker-42",
        name: "Mobile Droid",
        avatarSeed: "mobile-droid",
        status: "running",
        sessionSummary: workerSummary,
      });
    });

    it("cto.ensureSession delegates to agentChatService with identityKey=cto", async () => {
      laneService.list.mockResolvedValueOnce([
        { id: "lane-primary", laneType: "primary" },
      ]);
      const result = await service.execute(makePayload("cto.ensureSession", {
        modelId: "claude-opus-4",
        reasoningEffort: "high",
      })) as Record<string, unknown>;
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith({
        identityKey: "cto",
        laneId: "lane-primary",
        modelId: "claude-opus-4",
        reasoningEffort: "high",
        permissionMode: "full-auto",
      });
      expect(agentChatService.getSessionSummary).toHaveBeenCalledWith("chat-identity-1");
      expect(result).toEqual(expect.objectContaining({ sessionId: "chat-1" }));
    });

    it("cto.ensureSession ignores requested lane overrides and still uses primary", async () => {
      laneService.list.mockResolvedValueOnce([
        { id: "lane-primary", laneType: "primary" },
      ]);
      await service.execute(makePayload("cto.ensureSession", { laneId: "lane-explicit" }));
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith({
        identityKey: "cto",
        laneId: "lane-primary",
        modelId: null,
        reasoningEffort: null,
        permissionMode: "full-auto",
      });
    });

    it("cto.ensureSession throws when no lane is available", async () => {
      laneService.list.mockResolvedValueOnce([]);
      await expect(service.execute(makePayload("cto.ensureSession", {})))
        .rejects.toThrow("No primary lane is available to host the CTO chat session.");
    });

    it("cto.ensureAgentSession requires agentId", async () => {
      await expect(service.execute(makePayload("cto.ensureAgentSession", {})))
        .rejects.toThrow("cto.ensureAgentSession requires agentId.");
    });

    it("cto.ensureAgentSession delegates to agentChatService with agent:<id> identityKey on primary", async () => {
      laneService.list.mockResolvedValueOnce([
        { id: "lane-primary", laneType: "primary" },
      ]);
      workerAgentService.getAgent.mockReturnValueOnce({
        id: "worker-42",
        name: "Mobile Droid",
        slug: "mobile-droid",
        status: "running",
      });
      const result = await service.execute(makePayload("cto.ensureAgentSession", {
        agentId: "worker-42",
      })) as Record<string, unknown>;
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith({
        identityKey: "agent:worker-42",
        laneId: "lane-primary",
        modelId: null,
        reasoningEffort: null,
        permissionMode: "full-auto",
      });
      expect(result).toEqual(expect.objectContaining({ sessionId: "chat-1" }));
    });

    it("cto.ensureAgentSession ignores requested lane overrides and still uses primary", async () => {
      laneService.list.mockResolvedValueOnce([
        { id: "lane-primary", laneType: "primary" },
      ]);
      workerAgentService.getAgent.mockReturnValueOnce({
        id: "worker-42",
        name: "Mobile Droid",
        slug: "mobile-droid",
        status: "running",
      });
      await service.execute(makePayload("cto.ensureAgentSession", {
        agentId: "worker-42",
        laneId: "lane-explicit",
      }));
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledWith({
        identityKey: "agent:worker-42",
        laneId: "lane-primary",
        modelId: null,
        reasoningEffort: null,
        permissionMode: "full-auto",
      });
    });

    it("cto.ensureAgentSession rejects unknown agentIds without creating a session", async () => {
      workerAgentService.getAgent.mockReturnValueOnce(null);
      workerAgentService.listAgents.mockReturnValueOnce([]);
      await expect(service.execute(makePayload("cto.ensureAgentSession", {
        agentId: "ghost-agent",
      }))).rejects.toThrow("cto.ensureAgentSession: unknown agentId 'ghost-agent'");
      expect(agentChatService.ensureIdentitySession).not.toHaveBeenCalled();
    });

    it("cto.ensureAgentSession throws when no primary lane is available", async () => {
      laneService.list.mockResolvedValueOnce([]);
      workerAgentService.getAgent.mockReturnValueOnce({
        id: "worker-42",
        name: "Mobile Droid",
        slug: "mobile-droid",
        status: "running",
      });
      await expect(service.execute(makePayload("cto.ensureAgentSession", {
        agentId: "worker-42",
      }))).rejects.toThrow("No primary lane is available to host the agent chat session.");
    });

    it("cto.ensureSession returns the same session on repeat calls (canonical lane reuse)", async () => {
      // Both calls resolve the same primary lane; ensureIdentitySession is a
      // mock that always returns the same session id, so the handler must
      // forward that id without duplicate creation.
      laneService.list.mockResolvedValue([
        { id: "lane-primary", laneType: "primary" },
      ]);
      const first = await service.execute(makePayload("cto.ensureSession", {})) as Record<string, unknown>;
      const second = await service.execute(makePayload("cto.ensureSession", {})) as Record<string, unknown>;
      expect(first.sessionId).toBe(second.sessionId);
      expect(agentChatService.ensureIdentitySession).toHaveBeenCalledTimes(2);
      // Every call passes the canonical (primary) lane so ensureIdentitySession
      // matches the existing session instead of creating a new one.
      for (const call of agentChatService.ensureIdentitySession.mock.calls) {
        expect(call[0]).toMatchObject({ identityKey: "cto", laneId: "lane-primary" });
      }
    });

    it("cto.getRoster surfaces orphan agent sessions at the bottom of the roster", async () => {
      const livingAgentSession = {
        sessionId: "sess-agent-live",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        status: "running",
        identityKey: "agent:worker-live",
        startedAt: "2026-04-01T00:05:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-04-01T00:06:00.000Z",
        lastOutputPreview: null,
        summary: null,
      };
      const orphanSession = {
        sessionId: "sess-agent-orphan",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        status: "idle",
        identityKey: "agent:worker-gone",
        startedAt: "2026-03-01T00:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-03-01T00:00:00.000Z",
        lastOutputPreview: null,
        summary: null,
      };
      agentChatService.listSessions.mockResolvedValueOnce([livingAgentSession, orphanSession]);
      workerAgentService.listAgents.mockReturnValueOnce([
        {
          id: "worker-live",
          name: "Active Droid",
          slug: "active-droid",
          role: "engineer",
          status: "running",
          reportsTo: null,
          capabilities: [],
          adapterType: "claude-local",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);
      const result = await service.execute(makePayload("cto.getRoster", {})) as {
        cto: unknown;
        workers: Array<Record<string, unknown>>;
      };
      // Live worker first (sorted alphabetically), orphan at the bottom.
      expect(result.workers).toHaveLength(2);
      expect(result.workers[0]).toEqual({
        agentId: "worker-live",
        name: "Active Droid",
        avatarSeed: "active-droid",
        status: "running",
        sessionSummary: livingAgentSession,
      });
      expect(result.workers[1]).toEqual({
        agentId: "worker-gone",
        name: "worker-gone",
        avatarSeed: null,
        status: "orphaned",
        sessionSummary: orphanSession,
      });
    });

    it("cto.getRoster does NOT surface orphan entries for agents still in the roster", async () => {
      const agentSession = {
        sessionId: "sess-agent-live",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        status: "running",
        identityKey: "agent:worker-live",
        startedAt: "2026-04-01T00:05:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-04-01T00:06:00.000Z",
        lastOutputPreview: null,
        summary: null,
      };
      agentChatService.listSessions.mockResolvedValueOnce([agentSession]);
      workerAgentService.listAgents.mockReturnValueOnce([
        {
          id: "worker-live",
          name: "Active Droid",
          slug: "active-droid",
          role: "engineer",
          status: "running",
          reportsTo: null,
          capabilities: [],
          adapterType: "claude-local",
          adapterConfig: {},
          runtimeConfig: {},
          budgetMonthlyCents: 0,
          spentMonthlyCents: 0,
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
          deletedAt: null,
        },
      ]);
      const result = await service.execute(makePayload("cto.getRoster", {})) as {
        cto: unknown;
        workers: Array<Record<string, unknown>>;
      };
      expect(result.workers).toHaveLength(1);
      expect(result.workers[0]).toMatchObject({
        agentId: "worker-live",
        status: "running",
      });
    });
  });

  // ---------------------------------------------------------------
  // execute: git.getFile (compound parse)
  // ---------------------------------------------------------------

  describe("execute — git.getFile", () => {
    it("parses all required and optional fields", async () => {
      await service.execute(makePayload("git.getFile", {
        laneId: "lane-1",
        path: "src/app.ts",
        mode: "staged",
        compareRef: "abc123",
        compareTo: "head",
      }));
      expect(diffService.getFileDiff).toHaveBeenCalledWith({
        laneId: "lane-1",
        filePath: "src/app.ts",
        mode: "staged",
        compareRef: "abc123",
        compareTo: "head",
      });
    });

    it("throws when mode is missing", async () => {
      await expect(service.execute(makePayload("git.getFile", {
        laneId: "lane-1",
        path: "src/app.ts",
      }))).rejects.toThrow("git.getFile requires mode.");
    });
  });

  describe("execute — git.getFileHistory", () => {
    it("passes laneId, path, and optional limit", async () => {
      await service.execute(makePayload("git.getFileHistory", {
        laneId: "lane-1",
        path: "src/app.ts",
        limit: 15,
      }));
      expect(gitService.getFileHistory).toHaveBeenCalledWith({
        laneId: "lane-1",
        path: "src/app.ts",
        limit: 15,
      });
    });

    it("throws when path is missing", async () => {
      await expect(service.execute(makePayload("git.getFileHistory", {
        laneId: "lane-1",
      }))).rejects.toThrow("git.getFileHistory requires path.");
    });
  });

  // ---------------------------------------------------------------
  // execute: prs.refresh
  // ---------------------------------------------------------------

  describe("execute — prs.refresh", () => {
    it("refreshes single PR by prId", async () => {
      prService.listAll.mockResolvedValue([{ id: "pr-1" }]);
      const result = await service.execute(makePayload("prs.refresh", { prId: "pr-1" }));
      expect(prService.refresh).toHaveBeenCalledWith({ prId: "pr-1" });
      expect(result).toEqual(expect.objectContaining({ refreshedCount: 1 }));
    });

    it("refreshes all PRs when no prId or prIds given", async () => {
      prService.listAll.mockResolvedValue([{ id: "pr-1" }, { id: "pr-2" }]);
      const result = await service.execute(makePayload("prs.refresh", {}));
      expect(prService.refresh).toHaveBeenCalledWith({});
      expect(result).toEqual(expect.objectContaining({ refreshedCount: 2 }));
    });
  });

  // ---------------------------------------------------------------
  // execute: lanes.rebase* commands
  // ---------------------------------------------------------------

  describe("execute — lanes rebase commands", () => {
    it("lanes.rebaseStart parses laneId and optional fields", async () => {
      await service.execute(makePayload("lanes.rebaseStart", {
        laneId: "lane-1",
        scope: "chain",
        pushMode: "force",
      }));
      expect(laneService.rebaseStart).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          scope: "chain",
          pushMode: "force",
        }),
      );
    });

    it("lanes.rebasePush parses runId and laneIds", async () => {
      await service.execute(makePayload("lanes.rebasePush", {
        runId: "run-1",
        laneIds: ["lane-1", "lane-2"],
      }));
      expect(laneService.rebasePush).toHaveBeenCalledWith({
        runId: "run-1",
        laneIds: ["lane-1", "lane-2"],
      });
    });

    it("lanes.rebasePush throws when laneIds is empty", async () => {
      await expect(service.execute(makePayload("lanes.rebasePush", {
        runId: "run-1",
        laneIds: [],
      }))).rejects.toThrow("lanes.rebasePush requires laneIds.");
    });
  });

  // ---------------------------------------------------------------
  // execute: git stash commands
  // ---------------------------------------------------------------

  describe("execute — git stash commands", () => {
    it("git.stashPush parses optional message and includeUntracked", async () => {
      await service.execute(makePayload("git.stashPush", {
        laneId: "lane-1",
        message: "wip",
        includeUntracked: true,
      }));
      expect(gitService.stashPush).toHaveBeenCalledWith({
        laneId: "lane-1",
        message: "wip",
        includeUntracked: true,
      });
    });

    it("git.stashApply requires laneId and stashRef", async () => {
      await service.execute(makePayload("git.stashApply", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
      }));
      expect(gitService.stashApply).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
      });
    });

    it("git.stashApply throws when stashRef is missing", async () => {
      await expect(service.execute(makePayload("git.stashApply", { laneId: "lane-1" })))
        .rejects.toThrow("git.stashApply requires stashRef.");
    });
  });

  // ---------------------------------------------------------------
  // execute: chat.approve / chat.respondToInput
  // ---------------------------------------------------------------

  describe("execute — chat approval and input commands", () => {
    it("chat.approve parses sessionId + itemId + decision", async () => {
      const result = await service.execute(makePayload("chat.approve", {
        sessionId: "s1",
        itemId: "item-1",
        decision: "allow",
      }));
      expect(agentChatService.approveToolUse).toHaveBeenCalledWith({
        sessionId: "s1",
        itemId: "item-1",
        decision: "allow",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.approve throws when decision is missing", async () => {
      await expect(service.execute(makePayload("chat.approve", {
        sessionId: "s1",
        itemId: "item-1",
      }))).rejects.toThrow("chat.approve requires decision.");
    });

    it("chat.respondToInput parses sessionId + itemId + answers", async () => {
      const result = await service.execute(makePayload("chat.respondToInput", {
        sessionId: "s1",
        itemId: "item-1",
        answers: { key1: "val1" },
        decision: "submit",
      }));
      expect(agentChatService.respondToInput).toHaveBeenCalledWith({
        sessionId: "s1",
        itemId: "item-1",
        answers: { key1: "val1" },
        decision: "submit",
      });
      expect(result).toEqual({ ok: true });
    });
  });
});
