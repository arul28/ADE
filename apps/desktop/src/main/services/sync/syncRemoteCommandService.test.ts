import { describe, expect, it, vi, beforeEach } from "vitest";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";
import type { SyncCommandPayload } from "../../../shared/types";

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
    land: vi.fn().mockResolvedValue({ ok: true }),
    closePr: vi.fn().mockResolvedValue(undefined),
    reopenPr: vi.fn().mockResolvedValue(undefined),
    requestReviewers: vi.fn().mockResolvedValue(undefined),
  } as any;
}

function createMockPtyService() {
  return {
    create: vi.fn().mockResolvedValue({ sessionId: "pty-1" }),
    dispose: vi.fn().mockResolvedValue(undefined),
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
    getSessionSummary: vi.fn().mockResolvedValue({}),
    getChatTranscript: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue({ sessionId: "chat-1" }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    interrupt: vi.fn().mockResolvedValue(undefined),
    steer: vi.fn().mockResolvedValue(undefined),
    approveToolUse: vi.fn().mockResolvedValue(undefined),
    respondToInput: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(undefined),
    updateSession: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    getAvailableModels: vi.fn().mockResolvedValue([{ id: "model-1", modelId: "m1" }]),
  } as any;
}

function createMockConflictService() {
  return {
    getLaneStatus: vi.fn().mockResolvedValue(null),
    listOverlaps: vi.fn().mockResolvedValue([]),
    getBatchAssessment: vi.fn().mockResolvedValue({ lanes: [] }),
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
  let conflictService: ReturnType<typeof createMockConflictService>;
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
    conflictService = createMockConflictService();
    service = createSyncRemoteCommandService({
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
      expect(actions).toContain("prs.list");
      expect(actions).toContain("prs.createFromLane");
      expect(actions).toContain("git.commit");
      expect(actions).toContain("git.push");
      expect(actions).toContain("chat.create");
      expect(actions).toContain("chat.send");
      expect(actions).toContain("files.writeTextAtomic");
      expect(actions).toContain("work.listSessions");
      expect(actions).toContain("conflicts.getLaneStatus");
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
      await service.execute(makePayload("prs.list"));
      expect(prService.listAll).toHaveBeenCalled();
    });

    it("prs.getDetail requires prId", async () => {
      await expect(service.execute(makePayload("prs.getDetail", {})))
        .rejects.toThrow("prs.getDetail requires prId.");
    });

    it("prs.getDetail routes to prService.getDetail", async () => {
      await service.execute(makePayload("prs.getDetail", { prId: "pr-42" }));
      expect(prService.getDetail).toHaveBeenCalledWith("pr-42");
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
    it("chat.create parses laneId + provider + model", async () => {
      await service.execute(makePayload("chat.create", {
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
      }));
      expect(agentChatService.createSession).toHaveBeenCalledWith({
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-4",
      });
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

    it("chat.dispose routes to agentChatService.dispose", async () => {
      const result = await service.execute(makePayload("chat.dispose", {
        sessionId: "sess-1",
      }));
      expect(agentChatService.dispose).toHaveBeenCalledWith({ sessionId: "sess-1" });
      expect(result).toEqual({ ok: true });
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
