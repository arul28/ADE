import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";
import type { SyncCommandPayload, SyncRemoteCommandAction } from "../../../shared/types";
import {
  MOBILE_SYNC_REQUIRED_FILE_REQUEST_ACTIONS,
  MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS,
} from "../../../shared/syncMobileCompatibility";

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
    getSummary: vi.fn().mockResolvedValue(null),
    refreshSnapshots: vi.fn().mockResolvedValue({ lanes: [] }),
    create: vi.fn().mockResolvedValue({ id: "lane-1" }),
    createChild: vi.fn().mockResolvedValue({ id: "child-1" }),
    createFromUnstaged: vi.fn().mockResolvedValue({ id: "unstaged-1" }),
    importBranch: vi.fn().mockResolvedValue({ id: "imported-1" }),
    previewBranchSwitch: vi.fn().mockResolvedValue({
      laneId: "lane-1",
      currentBranchRef: "main",
      targetBranchRef: "feature/foo",
      mode: "existing",
      dirty: false,
      duplicateLaneId: null,
      duplicateLaneName: null,
      activeWork: [],
      targetProfile: null,
    }),
    attach: vi.fn().mockResolvedValue({ id: "attached-1" }),
    listUnregisteredWorktrees: vi.fn().mockResolvedValue([
      { path: "/repo/.ade/unregistered-lanes/feature-one", branch: "feature/one" },
    ]),
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
    getForLane: vi.fn().mockReturnValue(null),
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
    simulateIntegration: vi.fn().mockResolvedValue({ proposalId: "proposal-1", status: "proposed", overallOutcome: "clean" }),
    commitIntegration: vi.fn().mockResolvedValue({ groupId: "group-1", integrationLaneId: "lane-int", pr: { id: "pr-1" }, mergeResults: [] }),
    listIntegrationWorkflows: vi.fn().mockResolvedValue([]),
    updateIntegrationProposal: vi.fn().mockResolvedValue(undefined),
    deleteIntegrationProposal: vi.fn().mockResolvedValue({ proposalId: "proposal-1", integrationLaneId: null, deletedIntegrationLane: false }),
    dismissIntegrationCleanup: vi.fn().mockResolvedValue({ proposalId: "proposal-1", cleanupState: "declined" }),
    cleanupIntegrationWorkflow: vi.fn().mockResolvedValue({ proposalId: "proposal-1", archivedLaneIds: [], skippedLaneIds: [], workflowDisplayState: "history", cleanupState: "completed" }),
    createIntegrationLaneForProposal: vi.fn().mockResolvedValue({ integrationLaneId: "lane-int", mergedCleanLanes: [], conflictingLanes: [] }),
    startIntegrationResolution: vi.fn().mockResolvedValue({ conflictFiles: [], mergedClean: true, integrationLaneId: "lane-int" }),
    recheckIntegrationStep: vi.fn().mockResolvedValue({ resolution: "resolved", remainingConflictFiles: [], allResolved: true, message: null }),
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

function createMockPtyService() {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: "pty-1", ptyId: "pty-proc" }),
    sendToSession: vi.fn().mockResolvedValue({
      sessionId: "pty-1",
      ptyId: "pty-proc",
      pid: 123,
      session: null,
      resumed: true,
      reusedExistingRuntime: false,
    }),
    writeBySessionId: vi.fn().mockReturnValue(true),
    dispose: vi.fn().mockResolvedValue(undefined),
    enrichSessions: vi.fn((sessions) => sessions),
  } as any;
}

function createMockSessionService() {
  return {
    list: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(null),
    updateMeta: vi.fn(),
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
    isCommitInLaneHistory: vi.fn().mockResolvedValue(true),
    revertCommit: vi.fn().mockResolvedValue(undefined),
    cherryPickCommit: vi.fn().mockResolvedValue(undefined),
    createTag: vi.fn().mockResolvedValue(undefined),
    resetToCommit: vi.fn().mockResolvedValue(undefined),
    stashPush: vi.fn().mockResolvedValue(undefined),
    listStashes: vi.fn().mockResolvedValue([]),
    stashApply: vi.fn().mockResolvedValue(undefined),
    stashPop: vi.fn().mockResolvedValue(undefined),
    stashDrop: vi.fn().mockResolvedValue(undefined),
    fetch: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    undoLastHeadChange: vi.fn().mockResolvedValue(undefined),
    redoLastHeadChange: vi.fn().mockResolvedValue(undefined),
    getSyncStatus: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    getConflictState: vi.fn().mockResolvedValue(null),
    rebaseContinue: vi.fn().mockResolvedValue(undefined),
    rebaseAbort: vi.fn().mockResolvedValue(undefined),
    mergeContinue: vi.fn().mockResolvedValue(undefined),
    mergeAbort: vi.fn().mockResolvedValue(undefined),
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
    launchHeadless: vi.fn().mockResolvedValue({
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
    restoreCancelledQueue: vi.fn().mockResolvedValue({ restored: false, restoredCount: 0 }),
    steer: vi.fn().mockResolvedValue(undefined),
    steerUserMessage: vi.fn().mockResolvedValue(undefined),
    cancelSteer: vi.fn().mockResolvedValue(undefined),
    editSteer: vi.fn().mockResolvedValue(undefined),
    approveToolUse: vi.fn().mockResolvedValue(undefined),
    respondToInput: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    getCodexGoal: vi.fn().mockResolvedValue({ objective: "Ship it", status: "active", tokenBudget: null }),
    setCodexGoal: vi.fn().mockResolvedValue({ objective: "Ship it", status: "active", tokenBudget: null }),
    setCodexGoalStatus: vi.fn().mockResolvedValue({ objective: "Ship it", status: "paused", tokenBudget: null }),
    clearCodexGoal: vi.fn().mockResolvedValue(null),
    cancelScheduledWork: vi.fn().mockResolvedValue({
      schedule: {
        id: "wake-1",
        sessionId: "sess-1",
        kind: "wakeup",
        status: "cancelled",
        title: "Check CI",
        prompt: "Check CI",
        createdAt: "2026-01-01T00:00:00.000Z",
        durable: true,
        cancellable: true,
      },
      providerCancellationRequested: false,
      providerCancellationConfirmed: true,
    }),
    dispose: vi.fn().mockResolvedValue(undefined),
    getAvailableModels: vi.fn().mockResolvedValue([{ id: "model-1", modelId: "m1" }]),
    getModelCatalog: vi.fn().mockResolvedValue({ groups: [], fetchedAt: "2026-01-01T00:00:00.000Z" }),
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
    dismissRebase: vi.fn(),
    deferRebase: vi.fn(),
  } as any;
}

function createMockRebaseSuggestionService() {
  return {
    listSuggestions: vi.fn().mockResolvedValue([]),
    dismiss: vi.fn().mockResolvedValue(undefined),
    defer: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockLinearIssueTracker() {
  return {
    listProjects: vi.fn().mockResolvedValue([{ id: "project-1", name: "Mobile", slug: "MOB" }]),
    listUsers: vi.fn().mockResolvedValue([{ id: "user-1", name: "Ada" }]),
    listWorkflowStates: vi.fn().mockResolvedValue([{ id: "state-1", name: "Todo", type: "todo" }]),
    searchIssues: vi.fn().mockResolvedValue({
      issues: [{ id: "issue-1", identifier: "ADE-42", title: "Mobile parity" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    }),
    fetchIssueComments: vi.fn().mockResolvedValue([{ id: "comment-1", body: "Needs mobile", createdAt: "2026-05-28T00:00:00.000Z" }]),
    getConnectionStatus: vi.fn().mockResolvedValue({ connected: true, viewerId: "user-1", viewerName: "Ada", message: null }),
    getQuickView: vi.fn().mockResolvedValue({
      connection: { connected: true, viewerId: "user-1", viewerName: "Ada" },
      organization: null,
      viewer: { id: "user-1", name: "Ada", displayName: "Ada", email: null, avatarUrl: null, admin: null, guest: null, url: null },
      projects: [],
      teams: [],
      assignedIssues: [{ id: "issue-1", identifier: "ADE-42", title: "Mobile parity" }],
      recentIssues: [{ id: "issue-2", identifier: "ADE-43", title: "Recent parity" }],
      fetchedAt: "2026-05-28T00:00:00.000Z",
      sdk: { packageName: "@linear/sdk", surfaces: ["assignedIssues", "recentIssues"] },
    }),
  } as any;
}

function createMockLinearCredentialService() {
  return {
    getStatus: vi.fn().mockReturnValue({
      tokenStored: true,
      authMode: "oauth",
      tokenExpiresAt: null,
      oauthConfigured: true,
    }),
  } as any;
}

function makePayload(action: string, args: Record<string, unknown> = {}): SyncCommandPayload {
  return { commandId: `cmd-${Date.now()}`, action: action as any, args };
}

const CTO_MEMORY_SNAPSHOT = {
  memory: "# CTO Durable Memory\n\n## Facts\n\n- A durable fact.",
  threadState: "# CTO Thread State\n\nCurrent goal: ship memory.",
  dailyLog: "# 2026-07-04\n\n09:00 — do a thing → done",
  dailyLogDate: "2026-07-04",
  updatedAt: "2026-07-04T09:00:00.000Z",
};

describe("createSyncRemoteCommandService", () => {
  let laneService: ReturnType<typeof createMockLaneService>;
  let prService: ReturnType<typeof createMockPrService>;
  let ptyService: ReturnType<typeof createMockPtyService>;
  let sessionService: ReturnType<typeof createMockSessionService>;
  let fileService: ReturnType<typeof createMockFileService>;
  let gitService: ReturnType<typeof createMockGitService>;
  let diffService: ReturnType<typeof createMockDiffService>;
  let agentChatService: ReturnType<typeof createMockAgentChatService>;
  let linearIssueTracker: ReturnType<typeof createMockLinearIssueTracker>;
  let linearCredentialService: ReturnType<typeof createMockLinearCredentialService>;
  let conflictService: ReturnType<typeof createMockConflictService>;
  let rebaseSuggestionService: ReturnType<typeof createMockRebaseSuggestionService>;
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
    linearIssueTracker = createMockLinearIssueTracker();
    linearCredentialService = createMockLinearCredentialService();
    conflictService = createMockConflictService();
    rebaseSuggestionService = createMockRebaseSuggestionService();
    service = createSyncRemoteCommandService({
      laneService,
      prService,
      ptyService,
      sessionService,
      fileService,
      gitService,
      diffService,
      agentChatService,
      linearCredentialService,
      getLinearIssueTracker: () => linearIssueTracker,
      conflictService,
      rebaseSuggestionService,
      ctoMemoryService: {
        getSnapshot: () => CTO_MEMORY_SNAPSHOT,
      } as any,
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
      expect(actions).toContain("chat.launch");
      expect(actions).toContain("chat.send");
      expect(actions).toContain("chat.getCodexGoal");
      expect(actions).toContain("chat.setCodexGoal");
      expect(actions).toContain("chat.setCodexGoalStatus");
      expect(actions).toContain("chat.clearCodexGoal");
      expect(actions).toContain("chat.cancelScheduledWork");
      expect(actions).toContain("files.writeTextAtomic");
      expect(actions).toContain("work.listSessions");
      expect(actions).toContain("conflicts.getLaneStatus");
    });

    it("keeps iOS remote command names shared and registered", () => {
      const registeredActions = new Set<SyncRemoteCommandAction | string>([
        ...service.getSupportedActions(),
        "lanes.presence.announce",
        "lanes.presence.release",
      ]);
      for (const action of MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS) {
        expect(registeredActions.has(action)).toBe(true);
      }
      expect(MOBILE_SYNC_REQUIRED_FILE_REQUEST_ACTIONS).toEqual([
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
        expect(["project", "runtime"]).toContain(desc.scope);
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

  describe("getDescriptor", () => {
    it("returns scope and policy for a known action", () => {
      const descriptor = service.getDescriptor("lanes.list");
      expect(descriptor).toEqual(expect.objectContaining({
        action: "lanes.list",
        scope: "project",
        policy: expect.objectContaining({ viewerAllowed: true }),
      }));
    });

    it("returns null for an unknown action", () => {
      expect(service.getDescriptor("totally.unknown.action")).toBeNull();
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
  // execute: deeplink commands
  // ---------------------------------------------------------------

  describe("execute — deeplinks.open", () => {
    function createServiceWithDispatch(dispatchDeeplinkUrl: (url: string) => Promise<{ ok: boolean; message?: string }>) {
      return createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        gitService,
        diffService,
        agentChatService,
        conflictService,
        dispatchDeeplinkUrl,
        logger: createLogger() as any,
      });
    }

    it("routes canonical ADE HTTPS links to the desktop deeplink dispatcher", async () => {
      const dispatch = vi.fn(async () => ({ ok: true }));
      const svc = createServiceWithDispatch(dispatch);
      const url = "https://ade-app.dev/open?type=pr&repo=arul/ADE&number=42";

      await expect(svc.execute(makePayload("deeplinks.open", { url }))).resolves.toEqual({ ok: true });

      expect(dispatch).toHaveBeenCalledWith(url);
    });

    it("keeps accepting legacy ADE HTTPS links from older mobile shares", async () => {
      const dispatch = vi.fn(async () => ({ ok: true }));
      const svc = createServiceWithDispatch(dispatch);
      const url = "https://ade.app/open?type=pr&repo=arul/ADE&number=42";

      await expect(svc.execute(makePayload("deeplinks.open", { url }))).resolves.toEqual({ ok: true });

      expect(dispatch).toHaveBeenCalledWith(url);
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
        includeConflictStatus: undefined,
        includeRebaseSuggestions: undefined,
        includeAutoRebaseStatus: undefined,
      });
    });

    it("lanes.refreshSnapshots forwards light-refresh flags and skips expensive decorations", async () => {
      const lane = { id: "lane-1", name: "Lane one" };
      laneService.refreshSnapshots.mockResolvedValue({ lanes: [lane] });

      const result = await service.execute(makePayload("lanes.refreshSnapshots", {
        includeArchived: true,
        includeStatus: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      })) as { snapshots: Array<{ lane: unknown }> };

      expect(laneService.refreshSnapshots).toHaveBeenCalledWith({
        includeArchived: true,
        includeStatus: false,
        includeConflictStatus: false,
        includeRebaseSuggestions: false,
        includeAutoRebaseStatus: false,
      });
      expect(conflictService.getBatchAssessment).not.toHaveBeenCalled();
      expect(rebaseSuggestionService.listSuggestions).not.toHaveBeenCalled();
      expect(result.snapshots.map((entry) => entry.lane)).toEqual([lane]);
    });

    it("lanes.getDetail loads only the requested lane summary", async () => {
      const lane = { id: "lane-1", name: "Lane one" };
      laneService.getSummary.mockResolvedValue(lane);

      const result = await service.execute(makePayload("lanes.getDetail", { laneId: "lane-1" })) as { lane: unknown };

      expect(laneService.getSummary).toHaveBeenCalledWith("lane-1", { includeStatus: true });
      expect(laneService.list).not.toHaveBeenCalled();
      expect(rebaseSuggestionService.listSuggestions).toHaveBeenCalledWith({ lanes: [lane] });
      expect(result.lane).toBe(lane);
    });

    it("lanes.getDetail includes the parent lane when computing rebase suggestions", async () => {
      const lane = { id: "lane-child", name: "Child", parentLaneId: "lane-parent" };
      const parent = { id: "lane-parent", name: "Parent" };
      laneService.getSummary.mockImplementation(async (laneId: string) => {
        if (laneId === "lane-child") return lane;
        if (laneId === "lane-parent") return parent;
        return null;
      });
      laneService.getStackChain.mockResolvedValue([parent, lane]);

      await service.execute(makePayload("lanes.getDetail", { laneId: "lane-child" }));

      expect(laneService.getSummary).toHaveBeenCalledWith("lane-child", { includeStatus: true });
      expect(laneService.getSummary).toHaveBeenCalledWith("lane-parent", { includeStatus: true });
      expect(laneService.list).not.toHaveBeenCalled();
      expect(rebaseSuggestionService.listSuggestions).toHaveBeenCalledWith({ lanes: [lane, parent] });
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

    it("lanes.previewBranchSwitch routes to laneService.previewBranchSwitch with optional fields", async () => {
      const result = await service.execute(makePayload("lanes.previewBranchSwitch", {
        laneId: "lane-1",
        branchName: "feature/foo",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      }));
      expect(laneService.previewBranchSwitch).toHaveBeenCalledWith({
        laneId: "lane-1",
        branchName: "feature/foo",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      });
      // The mock returns a preview shape; the result should be the same object.
      expect(result).toMatchObject({ laneId: "lane-1", mode: "existing" });
    });

    it("lanes.previewBranchSwitch requires branchName", async () => {
      await expect(service.execute(makePayload("lanes.previewBranchSwitch", { laneId: "lane-1" })))
        .rejects.toThrow(/branchName/);
    });

    it("lanes.listUnregisteredWorktrees routes to laneService", async () => {
      const result = await service.execute(makePayload("lanes.listUnregisteredWorktrees"));
      expect(laneService.listUnregisteredWorktrees).toHaveBeenCalledTimes(1);
      expect(result).toEqual([
        { path: "/repo/.ade/unregistered-lanes/feature-one", branch: "feature/one" },
      ]);
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
      const result = await service.execute(makePayload("lanes.delete", {
        laneId: "lane-1",
        deleteBranch: true,
        deleteRemoteBranch: false,
        force: true,
      }));
      expect(laneService.delete).toHaveBeenCalledWith(
        {
          laneId: "lane-1",
          deleteBranch: true,
          deleteRemoteBranch: false,
          force: true,
        },
        { teardownEnv: undefined },
      );
      expect(result).toEqual({ ok: true });
    });

    it("lanes.delete runs env teardown and releases the port lease", async () => {
      const lane = {
        id: "lane-1",
        name: "Lane one",
        laneType: "feature",
        worktreePath: "/repo/.ade/worktrees/lane-1",
      };
      const envInitConfig = { dependencies: ["npm install"] };
      const cleanupLaneEnvironment = vi.fn(async () => undefined);
      const release = vi.fn();
      laneService.list.mockResolvedValue([lane]);
      laneService.delete.mockImplementation(async (_args: unknown, opts?: { teardownEnv?: () => Promise<void> }) => {
        await opts?.teardownEnv?.();
      });
      const withRuntimeCleanup = createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        gitService,
        diffService,
        agentChatService,
        conflictService,
        projectConfigService: {
          getEffective: vi.fn(() => ({
            laneEnvInit: null,
            laneOverlayPolicies: [],
          })),
        } as any,
        laneEnvironmentService: {
          resolveEnvInitConfig: vi.fn(() => envInitConfig),
          cleanupLaneEnvironment,
        } as any,
        portAllocationService: {
          getLease: vi.fn(() => null),
          release,
        } as any,
        logger: createLogger() as any,
      });

      await withRuntimeCleanup.execute(makePayload("lanes.delete", {
        laneId: "lane-1",
        force: true,
        deleteBranch: false,
      }));

      expect(laneService.list).toHaveBeenCalledWith({ includeStatus: false, includeArchived: true });
      expect(laneService.delete).toHaveBeenCalledWith(
        { laneId: "lane-1", force: true, deleteBranch: false, deleteRemoteBranch: undefined },
        { teardownEnv: expect.any(Function) },
      );
      expect(cleanupLaneEnvironment).toHaveBeenCalledWith(lane, envInitConfig);
      expect(release).toHaveBeenCalledWith("lane-1");
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

    it("prs.getForLane routes to prService.getForLane", async () => {
      prService.getForLane.mockReturnValue({ id: "pr-1" });
      const result = await service.execute(makePayload("prs.getForLane", { laneId: "lane-1" }));
      expect(prService.getForLane).toHaveBeenCalledWith("lane-1");
      expect(result).toEqual({ id: "pr-1" });
    });

    it("prs.getForLane requires laneId", async () => {
      await expect(service.execute(makePayload("prs.getForLane", {})))
        .rejects.toThrow("prs.getForLane requires laneId.");
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
        closeLinearIssueOnMerge: true,
      }));
      expect(prService.createFromLane).toHaveBeenCalledWith({
        laneId: "lane-1",
        title: "My PR",
        body: "Description",
        draft: true,
        closeLinearIssueOnMerge: true,
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
      }))).rejects.toThrow("prs.requestReviewers requires at least one reviewer or team reviewer.");
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

    it("prs.rerunChecks parses optional action-job and check-run ids", async () => {
      const result = await service.execute(makePayload("prs.rerunChecks", {
        prId: "pr-1",
        actionJobIds: [303],
        checkRunIds: [101, 202],
      }));
      expect(prService.rerunChecks).toHaveBeenCalledWith({
        prId: "pr-1",
        actionJobIds: [303],
        checkRunIds: [101, 202],
      });
      expect(result).toEqual({ ok: true });
    });

    it.each([
      ["actionJobIds", [101, "bad"]],
      ["checkRunIds", [101, "bad"]],
    ] as const)("prs.rerunChecks rejects invalid %s", async (key, value) => {
      await expect(service.execute(makePayload("prs.rerunChecks", {
        prId: "pr-1",
        [key]: value,
      }))).rejects.toThrow(`prs.rerunChecks requires ${key} to be an array of numbers when provided.`);
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

    it("prs.simulateIntegration parses source lanes, base branch, and merge target", async () => {
      const result = await service.execute(makePayload("prs.simulateIntegration", {
        sourceLaneIds: ["lane-a", "lane-b"],
        baseBranch: "main",
        persist: true,
        mergeIntoLaneId: "lane-int",
      }));
      expect(prService.simulateIntegration).toHaveBeenCalledWith({
        sourceLaneIds: ["lane-a", "lane-b"],
        baseBranch: "main",
        persist: true,
        mergeIntoLaneId: "lane-int",
      });
      expect(result).toEqual({ proposalId: "proposal-1", status: "proposed", overallOutcome: "clean" });
    });

    it("prs.commitIntegration parses proposal metadata and options", async () => {
      const result = await service.execute(makePayload("prs.commitIntegration", {
        proposalId: "proposal-1",
        integrationLaneName: "Mobile integration",
        title: "Integration PR",
        body: "Body",
        draft: true,
        pauseOnConflict: true,
        allowDirtyWorktree: false,
        preferredIntegrationLaneId: null,
      }));
      expect(prService.commitIntegration).toHaveBeenCalledWith({
        proposalId: "proposal-1",
        integrationLaneName: "Mobile integration",
        title: "Integration PR",
        body: "Body",
        draft: true,
        pauseOnConflict: true,
        allowDirtyWorktree: false,
        preferredIntegrationLaneId: null,
      });
      expect(result).toEqual({ groupId: "group-1", integrationLaneId: "lane-int", pr: { id: "pr-1" }, mergeResults: [] });
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
  // execute: deeplink commands
  // ---------------------------------------------------------------

  describe("execute — deeplink commands", () => {
    function createServiceWithDeeplinkDispatch(
      dispatchDeeplinkUrl?: (url: string) => Promise<{ ok: boolean; message?: string }>,
    ): ReturnType<typeof createSyncRemoteCommandService> {
      return createSyncRemoteCommandService({
        laneService,
        prService,
        ptyService,
        sessionService,
        fileService,
        gitService,
        diffService,
        agentChatService,
        conflictService,
        logger: createLogger() as any,
        dispatchDeeplinkUrl,
      });
    }

    it("deeplinks.open accepts https://ade.app/open URLs and dispatches the original URL", async () => {
      const dispatchDeeplinkUrl = vi.fn(async () => ({ ok: true }));
      const withDispatch = createServiceWithDeeplinkDispatch(dispatchDeeplinkUrl);
      const url = "https://ade.app/open?type=pr&repo=arul28/ADE&number=383";

      const result = await withDispatch.execute(makePayload("deeplinks.open", { url }));

      expect(dispatchDeeplinkUrl).toHaveBeenCalledWith(url);
      expect(result).toEqual({ ok: true });
    });

    it("deeplinks.open rejects unsupported URLs before dispatching", async () => {
      const dispatchDeeplinkUrl = vi.fn(async () => ({ ok: true }));
      const withDispatch = createServiceWithDeeplinkDispatch(dispatchDeeplinkUrl);

      await expect(withDispatch.execute(makePayload("deeplinks.open", {
        url: "https://example.com/open?type=pr&repo=arul28/ADE&number=383",
      }))).rejects.toThrow("Invalid deeplink: unsupported host 'example.com'");

      await expect(withDispatch.execute(makePayload("deeplinks.open", {
        url: "ftp://ade.app/open?type=pr&repo=arul28/ADE&number=383",
      }))).rejects.toThrow("Invalid deeplink: unsupported scheme 'ftp'");

      expect(dispatchDeeplinkUrl).not.toHaveBeenCalled();
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

    it("git.pull parses optional pull mode", async () => {
      await service.execute(makePayload("git.pull", {
        laneId: "lane-1",
        mode: "rebase",
      }));
      expect(gitService.pull).toHaveBeenCalledWith({
        laneId: "lane-1",
        mode: "rebase",
      });
    });

    it("git.pull rejects unknown pull modes", async () => {
      await expect(service.execute(makePayload("git.pull", {
        laneId: "lane-1",
        mode: "squash",
      }))).rejects.toThrow("git.pull mode must be ff-only, rebase, or merge.");
    });

    it("git undo and redo head-change actions require a lane", async () => {
      await service.execute(makePayload("git.undoLastHeadChange", { laneId: "lane-1" }));
      await service.execute(makePayload("git.redoLastHeadChange", { laneId: "lane-1" }));

      expect(gitService.undoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(gitService.redoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });
      await expect(service.execute(makePayload("git.undoLastHeadChange", {})))
        .rejects.toThrow("git.undoLastHeadChange requires laneId.");
      await expect(service.execute(makePayload("git.redoLastHeadChange", {})))
        .rejects.toThrow("git.redoLastHeadChange requires laneId.");
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

    it("git.isCommitInLaneHistory passes laneId and commitSha", async () => {
      await service.execute(makePayload("git.isCommitInLaneHistory", {
        laneId: "lane-1",
        commitSha: "abc123",
      }));
      expect(gitService.isCommitInLaneHistory).toHaveBeenCalledWith({
        laneId: "lane-1",
        commitSha: "abc123",
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

    it("git.createTag parses commit tag arguments", async () => {
      await service.execute(makePayload("git.createTag", {
        laneId: "lane-1",
        commitSha: "abc123",
        tagName: "v1.2.3",
        message: "release",
      }));
      expect(gitService.createTag).toHaveBeenCalledWith({
        laneId: "lane-1",
        commitSha: "abc123",
        tagName: "v1.2.3",
        message: "release",
      });
    });

    it("git.resetToCommit parses and validates reset modes", async () => {
      await service.execute(makePayload("git.resetToCommit", {
        laneId: "lane-1",
        commitSha: "abc123",
        mode: "mixed",
      }));
      expect(gitService.resetToCommit).toHaveBeenCalledWith({
        laneId: "lane-1",
        commitSha: "abc123",
        mode: "mixed",
      });

      await expect(service.execute(makePayload("git.resetToCommit", {
        laneId: "lane-1",
        commitSha: "abc123",
        mode: "merge",
      }))).rejects.toThrow("git.resetToCommit mode must be soft, mixed, or hard.");
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

    it("git.mergeContinue and git.mergeAbort dispatch to the git service with the lane id", async () => {
      await service.execute(makePayload("git.mergeContinue", { laneId: "lane-1" }));
      expect(gitService.mergeContinue).toHaveBeenCalledWith({ laneId: "lane-1" });

      await service.execute(makePayload("git.mergeAbort", { laneId: "lane-1" }));
      expect(gitService.mergeAbort).toHaveBeenCalledWith({ laneId: "lane-1" });
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

    it("git.checkoutBranch forwards optional mode/startPoint/baseRef/acknowledgeActiveWork", async () => {
      await service.execute(makePayload("git.checkoutBranch", {
        laneId: "lane-1",
        branchName: "feature/new",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      }));
      expect(gitService.checkoutBranch).toHaveBeenCalledWith({
        laneId: "lane-1",
        branchName: "feature/new",
        mode: "create",
        startPoint: "main",
        baseRef: "main",
        acknowledgeActiveWork: true,
      });
    });

    it("git.checkoutBranch omits optional fields when payload provides only required ones", async () => {
      await service.execute(makePayload("git.checkoutBranch", {
        laneId: "lane-1",
        branchName: "feature/clean",
      }));
      const lastCall = gitService.checkoutBranch.mock.calls.at(-1)?.[0];
      expect(lastCall).toEqual({ laneId: "lane-1", branchName: "feature/clean" });
      expect(lastCall).not.toHaveProperty("mode");
      expect(lastCall).not.toHaveProperty("startPoint");
      expect(lastCall).not.toHaveProperty("baseRef");
      expect(lastCall).not.toHaveProperty("acknowledgeActiveWork");
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

    it("chat.launch headlessly creates a chat, preserves kickoff text, and returns a mobile summary", async () => {
      const result = await service.execute(makePayload("chat.launch", {
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        kickoffText: "Start from this Linear issue.",
      }));

      expect(agentChatService.launchHeadless).toHaveBeenCalledWith({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
        kickoffText: "Start from this Linear issue.",
      });
      expect(agentChatService.getSessionSummary).toHaveBeenCalledWith("chat-1");
      expect(result).toEqual(expect.objectContaining({ sessionId: "chat-1", startedAt: "2026-01-01T00:00:00.000Z" }));
    });

    it("chat.launch resolves model from available models before launching", async () => {
      await service.execute(makePayload("chat.launch", {
        laneId: "lane-1",
        provider: "codex",
        model: "",
        kickoffText: "Start from this Linear issue.",
      }));

      expect(agentChatService.getAvailableModels).toHaveBeenCalledWith({ provider: "codex" });
      expect(agentChatService.launchHeadless).toHaveBeenCalledWith(
        expect.objectContaining({ model: "model-1", modelId: "m1", kickoffText: "Start from this Linear issue." }),
      );
    });

    it("chat.send requires sessionId and text", async () => {
      const result = await service.execute(makePayload("chat.send", {
        sessionId: "sess-1",
        text: "hello",
      }));
      expect(agentChatService.sendMessage).toHaveBeenCalledWith({
        sessionId: "sess-1",
        text: "hello",
      }, {
        awaitDispatch: false,
        routeActiveToSteer: true,
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

    it("chat.getCodexGoal routes to agentChatService.getCodexGoal", async () => {
      const result = await service.execute(makePayload("chat.getCodexGoal", {
        sessionId: "sess-1",
      }));

      expect(agentChatService.getCodexGoal).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toEqual({ objective: "Ship it", status: "active", tokenBudget: null });
    });

    it("chat.setCodexGoal trims and forwards the objective without a budget field", async () => {
      await service.execute(makePayload("chat.setCodexGoal", {
        sessionId: "sess-1",
        objective: "  Keep the lane shipping  ",
        tokenBudget: 1000,
      }));

      expect(agentChatService.setCodexGoal).toHaveBeenCalledWith({
        sessionId: "sess-1",
        objective: "Keep the lane shipping",
      });
    });

    it("chat.setCodexGoalStatus routes to agentChatService.setCodexGoalStatus", async () => {
      const result = await service.execute(makePayload("chat.setCodexGoalStatus", {
        sessionId: "sess-1",
        status: "paused",
      }));

      expect(agentChatService.setCodexGoalStatus).toHaveBeenCalledWith({
        sessionId: "sess-1",
        status: "paused",
      });
      expect(result).toEqual({ objective: "Ship it", status: "paused", tokenBudget: null });
    });

    it("chat.setCodexGoalStatus rejects unsupported statuses before calling the chat service", async () => {
      await expect(service.execute(makePayload("chat.setCodexGoalStatus", {
        sessionId: "sess-1",
        status: "unknown",
      }))).rejects.toThrow("chat.setCodexGoalStatus requires status to be active, paused, blocked, or complete.");

      expect(agentChatService.setCodexGoalStatus).not.toHaveBeenCalled();
    });

    it("chat.clearCodexGoal routes to agentChatService.clearCodexGoal", async () => {
      const result = await service.execute(makePayload("chat.clearCodexGoal", {
        sessionId: "sess-1",
      }));

      expect(agentChatService.clearCodexGoal).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toBeNull();
    });

    it("chat.cancelScheduledWork routes durable job cancellation to the chat service", async () => {
      const result = await service.execute(makePayload("chat.cancelScheduledWork", {
        sessionId: "sess-1",
        scheduleId: "wake-1",
      }));

      expect(agentChatService.cancelScheduledWork).toHaveBeenCalledWith({
        sessionId: "sess-1",
        scheduleId: "wake-1",
      });
      expect(result).toEqual(expect.objectContaining({
        providerCancellationRequested: false,
        providerCancellationConfirmed: true,
      }));
      await expect(service.execute(makePayload("chat.cancelScheduledWork", { sessionId: "sess-1" })))
        .rejects.toThrow("chat.cancelScheduledWork requires scheduleId.");
      expect(agentChatService.cancelScheduledWork).toHaveBeenCalledTimes(1);
    });

    it("chat.setCodexGoal throws when objective is missing", async () => {
      await expect(service.execute(makePayload("chat.setCodexGoal", {
        sessionId: "sess-1",
      }))).rejects.toThrow("chat.setCodexGoal requires objective.");
    });

    it("chat.interrupt routes to agentChatService.interrupt", async () => {
      const result = await service.execute(makePayload("chat.interrupt", {
        sessionId: "sess-1",
      }));
      expect(agentChatService.interrupt).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
    });

    it("chat.interruptWithQueueMode preserves the selected stop mode and recovery result", async () => {
      agentChatService.interrupt.mockResolvedValueOnce({
        mode: "stop_and_clear",
        cancelledQueuedCount: 2,
        recoveryId: "recovery-1",
        recoveryExpiresAt: "2026-07-27T12:00:08.000Z",
      });

      const result = await service.execute(makePayload("chat.interruptWithQueueMode", {
        sessionId: "sess-1",
        mode: "stop_and_clear",
      }));

      expect(agentChatService.interrupt).toHaveBeenCalledWith({
        sessionId: "sess-1",
        mode: "stop_and_clear",
      });
      expect(result).toEqual({
        ok: true,
        mode: "stop_and_clear",
        cancelledQueuedCount: 2,
        recoveryId: "recovery-1",
        recoveryExpiresAt: "2026-07-27T12:00:08.000Z",
      });
    });

    it("chat.restoreCancelledQueue validates recovery ids and returns the restore result", async () => {
      agentChatService.restoreCancelledQueue.mockResolvedValueOnce({
        restored: true,
        restoredCount: 2,
      });

      const result = await service.execute(makePayload("chat.restoreCancelledQueue", {
        sessionId: "sess-1",
        recoveryId: "recovery-1",
      }));

      expect(agentChatService.restoreCancelledQueue).toHaveBeenCalledWith({
        sessionId: "sess-1",
        recoveryId: "recovery-1",
      });
      expect(result).toEqual({ ok: true, restored: true, restoredCount: 2 });
      await expect(service.execute(makePayload("chat.restoreCancelledQueue", {
        sessionId: "sess-1",
      }))).rejects.toThrow("chat.restoreCancelledQueue requires recoveryId.");
    });

    it("chat.interrupt throws when sessionId is missing", async () => {
      await expect(service.execute(makePayload("chat.interrupt", {})))
        .rejects.toThrow("chat.interrupt requires sessionId.");
    });

    it("chat.steer routes human input to agentChatService.steerUserMessage", async () => {
      const result = await service.execute(makePayload("chat.steer", {
        sessionId: "sess-1",
        text: "change direction",
      }));
      expect(agentChatService.steerUserMessage).toHaveBeenCalledWith({
        sessionId: "sess-1",
        text: "change direction",
      });
      expect(result).toEqual({ ok: true });
    });

    it("chat.steer returns the backend queued result for mobile clients", async () => {
      agentChatService.steerUserMessage.mockResolvedValueOnce({ steerId: "steer-1", queued: true });
      const result = await service.execute(makePayload("chat.steer", {
        sessionId: "sess-1",
        text: "change direction",
      }));

      expect(result).toEqual({ ok: true, steerId: "steer-1", queued: true });
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
        }, {
          awaitDispatch: false,
          routeActiveToSteer: true,
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
        }, {
          awaitDispatch: false,
          routeActiveToSteer: true,
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
        expect(agentChatService.steerUserMessage).toHaveBeenCalledWith({
          sessionId: "sess-1",
          text: "redirect",
          attachments: [
            { path: "img.png", type: "image" },
            { path: "notes.txt", type: "file" },
          ],
        });
      });

      it("omits attachments when array has no valid entries", async () => {
        agentChatService.steerUserMessage.mockClear();
        await service.execute(makePayload("chat.steer", {
          sessionId: "sess-1",
          text: "redirect",
          attachments: [{ path: "", type: "image" }, { type: "file" }],
        }));
        const sent = agentChatService.steerUserMessage.mock.calls[0][0] as Record<string, unknown>;
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

    it("chat.models returns available models for a provider", async () => {
      await service.execute(makePayload("chat.models", { provider: "codex" }));
      expect(agentChatService.getAvailableModels).toHaveBeenCalledWith({ provider: "codex" });
    });

    it("chat.modelCatalog returns the canonical model catalog", async () => {
      const result = await service.execute(makePayload("chat.modelCatalog", {}));
      expect(agentChatService.getModelCatalog).toHaveBeenCalled();
      expect(result).toEqual({ groups: [], fetchedAt: "2026-01-01T00:00:00.000Z" });
    });

    it("chat.listSessions forwards automation and archived filters", async () => {
      await service.execute(makePayload("chat.listSessions", {
        laneId: "lane-1",
        includeAutomation: true,
        includeArchived: true,
      }));

      expect(agentChatService.listSessions).toHaveBeenCalledWith("lane-1", {
        includeAutomation: true,
        includeArchived: true,
      });
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

    it("work.listSessions forwards pending input item ids for awaiting chat sessions", async () => {
      sessionService.list.mockReturnValueOnce([{
        id: "chat-awaiting",
        laneId: "lane-1",
        laneName: "Primary",
        ptyId: null,
        tracked: true,
        pinned: false,
        manuallyNamed: false,
        goal: null,
        toolType: "codex-chat",
        title: "Needs approval",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        archivedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running",
        resumeCommand: null,
        resumeMetadata: null,
        chatIdleSinceAt: null,
      }]);
      agentChatService.listSessions.mockResolvedValueOnce([{
        sessionId: "chat-awaiting",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        status: "active",
        awaitingInput: true,
        pendingInputItemId: "pending-input-1",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        lastActivityAt: "2026-01-01T00:00:01.000Z",
        lastOutputPreview: null,
        summary: null,
      }]);

      const result = await service.execute(makePayload("work.listSessions", { laneId: "lane-1" }));

      expect(result).toMatchObject([{
        id: "chat-awaiting",
        runtimeState: "waiting-input",
        pendingInputItemId: "pending-input-1",
      }]);
    });

    it("work.runQuickCommand parses laneId + title + startupCommand", async () => {
      await service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "test run",
        startupCommand: "npm test",
        toolType: "shell",
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "test run",
          startupCommand: "npm test",
          tracked: true,
          toolType: "shell",
        }),
      );
    });

    it("work.runQuickCommand preserves startupCommand for visible shell sessions", async () => {
      await service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "Claude login",
        startupCommand: "claude auth login",
        toolType: "shell",
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "Claude login",
          startupCommand: "claude auth login",
          tracked: true,
          toolType: "shell",
        }),
      );
    });

    it("work.runQuickCommand throws when startupCommand is missing and toolType is not shell", async () => {
      await expect(service.execute(makePayload("work.runQuickCommand", {
        laneId: "lane-1",
        title: "test",
        toolType: "codex",
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

    it("work.startCliSession builds allowlisted provider launch commands", async () => {
      sessionService.get.mockReturnValue({
        id: "pty-1",
        laneId: "lane-1",
        laneName: "Lane",
        ptyId: "pty-1",
        tracked: true,
        pinned: false,
        goal: null,
        toolType: "codex",
        title: "Codex",
        status: "running",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: null,
        exitCode: null,
        transcriptPath: "",
        headShaStart: null,
        headShaEnd: null,
        lastOutputPreview: null,
        summary: null,
        runtimeState: "running",
        resumeCommand: null,
      });
      const result = await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "edit",
        initialInput: "fix the tests",
        modelId: "openai/gpt-5.5",
        reasoningEffort: "xhigh",
        fastMode: false,
        cols: 70,
        rows: 24,
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "Fix the tests",
          tracked: true,
          toolType: "codex",
          cols: 70,
          rows: 24,
          command: "codex",
          startupCommand: expect.stringContaining("codex"),
        }),
      );
      const createCall = ptyService.create.mock.calls.at(-1)?.[0];
      expect(createCall?.args).toEqual(expect.arrayContaining(["--model", "gpt-5.5", "-c", "model_reasoning_effort=\"xhigh\"", "-c", "service_tier=\"default\""]));
      expect(createCall?.args).not.toContain(expect.stringContaining("fix the tests"));
      expect(createCall?.initialInput).toContain("fix the tests");
      expect(createCall?.initialInputDelayMs).toBe(750);
      expect(createCall).not.toHaveProperty("awaitInitialInput");
      expect(ptyService.writeBySessionId).not.toHaveBeenCalled();
      expect(sessionService.updateMeta).toHaveBeenCalledWith(expect.objectContaining({
        sessionId: "pty-1",
        goal: "fix the tests",
        title: "Fix the tests",
      }));
      expect(result).toEqual(expect.objectContaining({
        sessionId: "pty-1",
        ptyId: "pty-proc",
        session: expect.objectContaining({ id: "pty-1" }),
      }));
    });

    it("work.startCliSession uses desktop-sized defaults when dimensions are omitted", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "codex",
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cols: 120,
          rows: 36,
        }),
      );
    });

    it("work.startCliSession preserves wide terminal dimensions", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "codex",
        cols: 999,
        rows: 999,
      }));
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          cols: 400,
          rows: 200,
        }),
      );
    });

    it("work.startCliSession opens a shell without accepting arbitrary startup commands", async () => {
      const previousShell = process.env.SHELL;
      process.env.SHELL = "/bin/zsh";
      try {
        await service.execute(makePayload("work.startCliSession", {
          laneId: "lane-1",
          provider: "shell",
          startupCommand: "rm -rf nope",
          initialInput: "rm -rf also-nope",
        }));
      } finally {
        if (previousShell == null) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
      }
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.not.objectContaining({
          startupCommand: "rm -rf nope",
        }),
      );
      expect(ptyService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          laneId: "lane-1",
          title: "Shell",
          toolType: "shell",
        }),
      );
      const call = ptyService.create.mock.calls.at(-1)?.[0];
      expect(call?.command).toBeTruthy();
      expect(call?.args).toEqual(expect.any(Array));
      expect(call?.env).toEqual(expect.objectContaining({
        ZDOTDIR: "/var/empty",
      }));
      expect(call).not.toHaveProperty("startupCommand");
      expect(ptyService.writeBySessionId).not.toHaveBeenCalled();
    });

    it("work.startCliSession rejects unknown providers", async () => {
      await expect(service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "node -e nope",
      }))).rejects.toThrow("work.startCliSession requires provider.");
    });

    it("work.startCliSession rejects unsupported permission/provider combinations", async () => {
      await expect(service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "config-toml",
      }))).rejects.toThrow("config-toml is only supported for Codex");
      expect(ptyService.create).not.toHaveBeenCalled();
    });

    it("work.startCliSession pre-assigns a claude --session-id so resume is reliable", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "default",
      }));
      const call = ptyService.create.mock.calls.at(-1)?.[0];
      expect(call?.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(call?.allowNewSessionId).toBe(true);
      expect(call?.startupCommand).toContain("--session-id");
      expect(call?.startupCommand).toContain(call!.sessionId);
      expect(call?.toolType).toBe("claude");
    });

    it("work.startCliSession preserves Claude auto permission mode from mobile", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "claude",
        permissionMode: "auto",
      }));
      const call = ptyService.create.mock.calls.at(-1)?.[0];
      expect(call?.args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
      expect(call?.startupCommand).toContain("--permission-mode auto");
    });

    it("work.startCliSession passes Claude model and initial input in the launch command", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "claude",
        model: "anthropic/claude-opus-4-8",
        initialInput: "hello?",
      }));

      const call = ptyService.create.mock.calls.at(-1)?.[0];
      expect(call?.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-8"]));
      expect(call?.args?.at(-1)).toContain("hello?");
      expect(call?.startupCommand).toContain("claude-opus-4-8");
      expect(call?.startupCommand).toContain("hello?");
      expect(ptyService.writeBySessionId).not.toHaveBeenCalled();
    });

    it("work.sendToSession sends through the durable session continuation path", async () => {
      const result = await service.execute(makePayload("work.sendToSession", {
        sessionId: "pty-existing",
        text: "continue here",
        cols: 999,
        rows: 999,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      }));
      expect(ptyService.sendToSession).toHaveBeenCalledWith({
        sessionId: "pty-existing",
        text: "continue here",
        cols: 999,
        rows: 999,
        model: "gpt-5.6-sol",
        reasoningEffort: "max",
        fastMode: true,
        permissionMode: "full-auto",
        codexApprovalPolicy: "on-request",
        codexSandbox: "danger-full-access",
        codexConfigSource: "flags",
      });
      expect(result).toMatchObject({
        sessionId: "pty-1",
        ptyId: "pty-proc",
        resumed: true,
      });
    });

    it("work.sendToSession throws when text is missing", async () => {
      await expect(service.execute(makePayload("work.sendToSession", {
        sessionId: "pty-existing",
      }))).rejects.toThrow("work.sendToSession requires text.");
    });

    it("work.startCliSession submits Cursor initial input after the interactive CLI is ready", async () => {
      await service.execute(makePayload("work.startCliSession", {
        laneId: "lane-1",
        provider: "cursor",
        initialInput: "fix the tests",
      }));

      const call = ptyService.create.mock.calls.at(-1)?.[0];
      expect(call?.startupCommand).toContain("cursor-agent");
      expect(call?.startupCommand).not.toContain("fix the tests");
      expect(call?.startupCommand).not.toContain("cursor-agent create-chat");
      expect(call?.startupCommand).not.toContain("--resume");
      expect(call?.initialInput).toContain("ADE session guidance");
      expect(call?.initialInput).toContain("fix the tests");
      expect(call?.initialInputDelayMs).toBe(750);
      expect(call).not.toHaveProperty("awaitInitialInput");
      expect(call?.command).toBe("cursor-agent");
      expect(call?.args).toEqual(expect.arrayContaining(["--model", "auto"]));
      expect(call?.args).not.toContain(expect.stringContaining("fix the tests"));
      expect(ptyService.writeBySessionId).not.toHaveBeenCalled();
      expect(ptyService.dispose).not.toHaveBeenCalled();
    });

    it("work.stopRuntime disposes pty if session has a ptyId", async () => {
      sessionService.get.mockReturnValue({ ptyId: "pty-42" });
      const result = await service.execute(makePayload("work.stopRuntime", {
        sessionId: "sess-1",
      }));
      expect(sessionService.get).toHaveBeenCalledWith("sess-1");
      expect(ptyService.dispose).toHaveBeenCalledWith({ ptyId: "pty-42", sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
    });

    it("work.stopRuntime skips pty disposal when the session has no ptyId", async () => {
      sessionService.get.mockReturnValue(null);
      const result = await service.execute(makePayload("work.stopRuntime", {
        sessionId: "sess-1",
      }));
      expect(sessionService.get).toHaveBeenCalledWith("sess-1");
      expect(ptyService.dispose).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
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
        includeConflictStatus: undefined,
        includeRebaseSuggestions: undefined,
        includeAutoRebaseStatus: undefined,
      });
    });

    it("ignores non-number values for optional number fields", async () => {
      await service.execute(makePayload("work.listSessions", {
        limit: "ten" as any,
      }));
      expect(sessionService.list).toHaveBeenCalledWith({});
    });

    it("handles payload.args being non-object by defaulting to empty record", async () => {
      await service.execute({
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

    it("cto.ensureSession refuses to fall back to lanes[0] when no primary exists", async () => {
      // Only non-primary lanes are available; identity-pinned sessions must
      // not silently land on a foreign lane via the lanes[0] fallback.
      laneService.list.mockResolvedValueOnce([
        { id: "lane-feature", laneType: "feature" },
        { id: "lane-scratch", laneType: "feature" },
      ]);
      await expect(service.execute(makePayload("cto.ensureSession", {})))
        .rejects.toThrow("No primary lane is available to host the CTO chat session.");
      expect(agentChatService.ensureIdentitySession).not.toHaveBeenCalled();
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

    it("cto.getMemory returns the durable memory snapshot for the mobile client", async () => {
      const result = await service.execute(makePayload("cto.getMemory", {}));
      // The shape here is the cross-platform contract the iOS decoder expects.
      expect(result).toEqual(CTO_MEMORY_SNAPSHOT);
    });

    it("cto.getMemory is exposed and viewer-allowed", () => {
      expect(service.getSupportedActions()).toContain("cto.getMemory");
    });

    it("cto exposes Linear quick view, issue picker, search, and comments through mobile sync", async () => {
      const quickView = await service.execute(makePayload("cto.getLinearQuickView", {}));
      expect(linearIssueTracker.getQuickView).toHaveBeenCalledWith(expect.objectContaining({
        connected: true,
        viewerId: "user-1",
      }));
      expect(quickView).toMatchObject({
        assignedIssues: [{ identifier: "ADE-42" }],
        recentIssues: [{ identifier: "ADE-43" }],
      });

      const picker = await service.execute(makePayload("cto.getLinearIssuePickerData", {}));
      expect(picker).toMatchObject({
        projects: [{ id: "project-1" }],
        users: [{ id: "user-1" }],
        states: [{ id: "state-1" }],
      });

      const search = await service.execute(makePayload("cto.searchLinearIssues", {
        projectSlug: "MOB",
        query: "parity",
        stateTypes: ["todo"],
        first: 10,
      }));
      expect(linearIssueTracker.searchIssues).toHaveBeenCalledWith({
        projectSlug: "MOB",
        stateTypes: ["todo"],
        query: "parity",
        first: 10,
      });
      expect(search).toMatchObject({ issues: [{ identifier: "ADE-42" }] });

      const comments = await service.execute(makePayload("cto.getLinearIssueComments", { issueId: "issue-1" }));
      expect(linearIssueTracker.fetchIssueComments).toHaveBeenCalledWith("issue-1");
      expect(comments).toMatchObject([{ id: "comment-1" }]);
    });

    it("cto Linear search surfaces return empty data when Linear is disconnected", async () => {
      linearIssueTracker.getConnectionStatus.mockResolvedValue({
        connected: false,
        viewerId: null,
        viewerName: null,
        message: "Linear credentials need reconnecting.",
      });

      const picker = await service.execute(makePayload("cto.getLinearIssuePickerData", {}));
      expect(picker).toEqual({ projects: [], users: [], states: [] });
      expect(linearIssueTracker.listProjects).not.toHaveBeenCalled();

      const search = await service.execute(makePayload("cto.searchLinearIssues", {
        query: "parity",
      }));
      expect(search).toEqual({ issues: [], pageInfo: { hasNextPage: false, endCursor: null } });
      expect(linearIssueTracker.searchIssues).not.toHaveBeenCalled();

      const comments = await service.execute(makePayload("cto.getLinearIssueComments", { issueId: "issue-1" }));
      expect(comments).toEqual([]);
      expect(linearIssueTracker.fetchIssueComments).not.toHaveBeenCalled();
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
      prService.listAll.mockResolvedValue([{ id: "pr-1" }, { id: "pr-2" }]);
      prService.listSnapshots.mockReturnValue([{ prId: "pr-1" }, { prId: "pr-2" }]);
      const result = await service.execute(makePayload("prs.refresh", { prId: "pr-1" }));
      expect(prService.refresh).toHaveBeenCalledWith({ prId: "pr-1" });
      expect(prService.listSnapshots).toHaveBeenCalledWith({ prId: "pr-1" });
      expect(result).toEqual(expect.objectContaining({
        refreshedCount: 1,
        prs: [{ id: "pr-1" }],
        snapshots: [{ prId: "pr-1" }],
      }));
    });

    it("scopes multi-PR refresh payloads by prIds", async () => {
      prService.listAll.mockResolvedValue([{ id: "pr-1" }, { id: "pr-2" }, { id: "pr-3" }]);
      prService.listSnapshots.mockReturnValue([{ prId: "pr-1" }, { prId: "pr-2" }, { prId: "pr-3" }]);
      const result = await service.execute(makePayload("prs.refresh", { prIds: ["pr-1", "pr-3"] }));
      expect(prService.refresh).toHaveBeenCalledWith({ prIds: ["pr-1", "pr-3"] });
      expect(result).toEqual(expect.objectContaining({
        refreshedCount: 2,
        prs: [{ id: "pr-1" }, { id: "pr-3" }],
        snapshots: [{ prId: "pr-1" }, { prId: "pr-3" }],
      }));
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

    it("lanes.dismissRebaseSuggestion hides the banner without dismissing the rebase need", async () => {
      const result = await service.execute(makePayload("lanes.dismissRebaseSuggestion", {
        laneId: "lane-1",
      }));
      expect(rebaseSuggestionService.dismiss).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(conflictService.dismissRebase).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true });
    });

    it("lanes.deferRebaseSuggestion clamps minutes and snoozes the banner without deferring the rebase need", async () => {
      await service.execute(makePayload("lanes.deferRebaseSuggestion", {
        laneId: "lane-1",
        minutes: 1,
      }));
      expect(rebaseSuggestionService.defer).toHaveBeenCalledWith({ laneId: "lane-1", minutes: 5 });
      expect(conflictService.deferRebase).not.toHaveBeenCalled();

      await service.execute(makePayload("lanes.deferRebaseSuggestion", {
        laneId: "lane-1",
        minutes: 60 * 24 * 30,
      }));
      expect(rebaseSuggestionService.defer).toHaveBeenLastCalledWith({ laneId: "lane-1", minutes: 7 * 24 * 60 });
      expect(conflictService.deferRebase).not.toHaveBeenCalled();
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

    it("git.stashApply passes an optional stashOid", async () => {
      await service.execute(makePayload("git.stashApply", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      }));
      expect(gitService.stashApply).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      });
    });

    it("git.stashApply throws when stashRef is missing", async () => {
      await expect(service.execute(makePayload("git.stashApply", { laneId: "lane-1" })))
        .rejects.toThrow("git.stashApply requires stashRef.");
    });

    it("git.stashPop and git.stashDrop require stashOid", async () => {
      await expect(service.execute(makePayload("git.stashPop", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
      }))).rejects.toThrow("git.stashPop requires stashOid.");
      await expect(service.execute(makePayload("git.stashDrop", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
      }))).rejects.toThrow("git.stashDrop requires stashOid.");

      await service.execute(makePayload("git.stashPop", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      }));
      await service.execute(makePayload("git.stashDrop", {
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      }));

      expect(gitService.stashPop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      });
      expect(gitService.stashDrop).toHaveBeenCalledWith({
        laneId: "lane-1",
        stashRef: "stash@{0}",
        stashOid: "oid-0",
      });
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
