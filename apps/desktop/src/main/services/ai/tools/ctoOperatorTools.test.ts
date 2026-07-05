import { describe, expect, it, vi, beforeEach } from "vitest";
import { createCtoOperatorTools, type CtoOperatorToolDeps } from "./ctoOperatorTools";

// Mock only execFileSync on node:child_process so searchCodebase can exercise it deterministically.
// Preserve the rest of the module (e.g. spawn, exec) for unrelated tests.
const execFileSyncMock = vi.fn();
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => execFileSyncMock(...args),
  };
});

const baseSession = {
  id: "chat-1",
  laneId: "lane-1",
  provider: "codex",
  model: "gpt-5",
  modelId: "openai/gpt-5-chat-latest",
  status: "idle",
  createdAt: "2026-03-16T00:00:00.000Z",
  lastActivityAt: "2026-03-16T00:00:00.000Z",
} as const;

const issueFixture = {
  id: "issue-1",
  identifier: "ADE-42",
  title: "Fix workflow regression",
  description: "Regression details",
  url: "https://linear.app/acme/issue/ADE-42",
  projectSlug: "ade",
  stateName: "Todo",
  priorityLabel: "high",
  labels: ["bug"],
  assigneeName: "CTO",
  teamKey: "ADE",
};

function buildDeps(overrides: Partial<CtoOperatorToolDeps> = {}): CtoOperatorToolDeps {
  return {
    currentSessionId: "cto-current",
    defaultLaneId: "lane-1",
    defaultModelId: "openai/gpt-5-chat-latest",
    defaultReasoningEffort: "medium",
    resolveExecutionLane: vi.fn().mockResolvedValue("lane-1"),
    laneService: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
    } as any,
    prService: null,
    fileService: null,
    processService: null,
    sessionService: {
      updateMeta: vi.fn(),
    } as any,
    issueTracker: null,
    listChats: vi.fn().mockResolvedValue([]),
    getChatStatus: vi.fn().mockResolvedValue(null),
    getChatTranscript: vi.fn().mockResolvedValue({
      sessionId: "chat-1",
      entries: [{ role: "user", text: "status?", timestamp: "2026-03-16T00:00:00.000Z" }],
      truncated: false,
      totalEntries: 1,
    }),
    createChat: vi.fn().mockResolvedValue(baseSession),
    updateChatSession: vi.fn().mockResolvedValue(baseSession),
    previewSessionToolNames: vi.fn(() => [
      "prRefreshIssueInventory",
      "prGetReviewComments",
      "prRerunFailedChecks",
      "prReplyToReviewThread",
      "prResolveReviewThread",
    ]),
    sendChatMessage: vi.fn().mockResolvedValue(undefined),
    interruptChat: vi.fn().mockResolvedValue(undefined),
    ensureCtoSession: vi.fn().mockResolvedValue({ ...baseSession, id: "cto-session" }),
    ...overrides,
  };
}

describe("createCtoOperatorTools", () => {
  // ── Tool set structure ──────────────────────────────────────────

  it("returns all expected operator tool keys", () => {
    const deps = buildDeps();
    const tools = createCtoOperatorTools(deps);
    const toolKeys = Object.keys(tools);

    // Core chat tools
    expect(toolKeys).toContain("listChats");
    expect(toolKeys).toContain("spawnChat");
    expect(toolKeys).toContain("sendChatMessage");
    expect(toolKeys).toContain("interruptChat");
    expect(toolKeys).toContain("getChatStatus");
    expect(toolKeys).toContain("getChatTranscript");

    // Lane tools
    expect(toolKeys).toContain("listLanes");
    expect(toolKeys).toContain("inspectLane");
    expect(toolKeys).toContain("createLane");

    // PR tools
    expect(toolKeys).toContain("listPullRequests");
    expect(toolKeys).toContain("getPullRequestStatus");
    expect(toolKeys).toContain("commentOnPullRequest");
    expect(toolKeys).toContain("updatePullRequestTitle");
    expect(toolKeys).toContain("updatePullRequestBody");

    // Linear issue tools
    expect(toolKeys).toContain("commentOnLinearIssue");
    expect(toolKeys).toContain("updateLinearIssueState");

    // Process tools
    expect(toolKeys).toContain("listManagedProcesses");
    expect(toolKeys).toContain("startManagedProcess");
    expect(toolKeys).toContain("stopManagedProcess");
    expect(toolKeys).toContain("getManagedProcessLog");

    // File workspace tools
    expect(toolKeys).toContain("listFileWorkspaces");
    expect(toolKeys).toContain("readWorkspaceFile");
    expect(toolKeys).toContain("searchWorkspaceText");

    // PR creation & management tools
    expect(toolKeys).toContain("createPrFromLane");
    expect(toolKeys).toContain("landPullRequest");
    expect(toolKeys).toContain("closePullRequest");
    expect(toolKeys).toContain("requestPrReviewers");

    // Lane management tools
    expect(toolKeys).toContain("deleteLane");

    // Test management tools
    expect(toolKeys).toContain("listTestSuites");
    expect(toolKeys).toContain("runTests");
    expect(toolKeys).toContain("stopTestRun");
    expect(toolKeys).toContain("listTestRuns");
    expect(toolKeys).toContain("getTestLog");

    // Terminal management tools
    expect(toolKeys).toContain("createTerminal");

    // Linear issue discovery tools
    expect(toolKeys).toContain("listLinearIssues");
    expect(toolKeys).toContain("getLinearIssue");
    expect(toolKeys).toContain("updateLinearIssueAssignee");
    expect(toolKeys).toContain("addLinearIssueLabel");

    // Automation management tools
    expect(toolKeys).toContain("listAutomations");
    expect(toolKeys).toContain("triggerAutomation");
    expect(toolKeys).toContain("listAutomationRuns");
  });

  it("resolves the latest branch stash before popping when no stash ref is provided", async () => {
    const gitService = {
      listStashes: vi.fn().mockResolvedValue([
        { oid: "oid-3", ref: "stash@{3}", subject: "feature/lane: latest branch stash", createdAt: "2026-03-16T00:00:00.000Z" },
      ]),
      stashPop: vi.fn().mockResolvedValue({ operationId: "stash-pop" }),
    };
    const deps = buildDeps({ gitService: gitService as any });
    const tools = createCtoOperatorTools(deps);

    const result = await (tools.gitStashPop as any).execute({ laneId: "lane-1" });

    expect(gitService.listStashes).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(gitService.stashPop).toHaveBeenCalledWith({ laneId: "lane-1", stashRef: "stash@{3}", stashOid: "oid-3" });
    expect(result).toMatchObject({ success: true, operationId: "stash-pop" });
  });

  it("throws a lane-specific error when a requested branch stash is missing", async () => {
    const gitService = {
      listStashes: vi.fn().mockResolvedValue([
        { oid: "oid-3", ref: "stash@{3}", subject: "feature/lane: latest branch stash", createdAt: "2026-03-16T00:00:00.000Z" },
      ]),
      stashPop: vi.fn(),
    };
    const deps = buildDeps({ gitService: gitService as any });
    const tools = createCtoOperatorTools(deps);

    await expect((tools.gitStashPop as any).execute({ laneId: "lane-1", stashRef: "stash@{0}" }))
      .resolves.toMatchObject({
        success: false,
        error: "Stash stash@{0} is not saved for this lane branch.",
      });

    expect(gitService.stashPop).not.toHaveBeenCalled();
  });

  // ── Chat tools ──────────────────────────────────────────────────

  describe("chat tools", () => {
    it("returns bounded chat transcript reads through the chat service helper", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatTranscript as any).execute({
        sessionId: "chat-1",
        limit: 5,
        maxChars: 500,
      });

      expect(deps.getChatTranscript).toHaveBeenCalledWith({ sessionId: "chat-1", limit: 5, maxChars: 500 });
      expect(result).toMatchObject({
        success: true,
        sessionId: "chat-1",
        count: 1,
        truncated: false,
      });
    });

    it("persists a requested chat title and returns navigation metadata when spawning chats", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.spawnChat as any).execute({
        title: "Backend follow-up",
        initialPrompt: "Inspect the failing tests.",
        openInUi: true,
      });

      expect(deps.createChat).toHaveBeenCalled();
      expect(deps.resolveExecutionLane).toHaveBeenCalledWith(expect.objectContaining({
        requestedLaneId: undefined,
        purpose: "Backend follow-up",
      }));
      expect(deps.updateChatSession).toHaveBeenCalledWith({
        sessionId: "chat-1",
        title: "Backend follow-up",
      });
      expect(deps.sendChatMessage).toHaveBeenCalledWith({
        sessionId: "chat-1",
        text: "Inspect the failing tests.",
      });
      expect(result).toMatchObject({
        success: true,
        sessionId: "chat-1",
        navigation: {
          surface: "work",
          laneId: "lane-1",
          sessionId: "chat-1",
          href: "/work?laneId=lane-1&sessionId=chat-1",
          label: "Open in Work",
        },
        navigationSuggestions: [{
          surface: "work",
          laneId: "lane-1",
          sessionId: "chat-1",
          href: "/work?laneId=lane-1&sessionId=chat-1",
          label: "Open in Work",
        }],
        requestedTitle: "Backend follow-up",
      });
    });

    it("spawns a chat without title or initial prompt", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.spawnChat as any).execute({
        openInUi: false,
      });

      expect(result.success).toBe(true);
      expect(deps.updateChatSession).not.toHaveBeenCalled();
      expect(deps.sendChatMessage).not.toHaveBeenCalled();
      expect(result.requestedTitle).toBeNull();
    });

    it("lists chats with default options", async () => {
      const chatList = [{ id: "chat-1", status: "idle" }];
      const deps = buildDeps({
        listChats: vi.fn().mockResolvedValue(chatList),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listChats as any).execute({});

      expect(result).toMatchObject({ success: true, count: 1, chats: chatList });
    });

    it("lists chats filtered by lane", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      await (tools.listChats as any).execute({ laneId: "lane-2", includeIdentity: true });

      expect(deps.listChats).toHaveBeenCalledWith("lane-2", expect.objectContaining({
        includeAutomation: false,
      }));
    });

    it("sends a message to a chat session", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.sendChatMessage as any).execute({
        sessionId: "chat-1",
        text: "Hello from CTO",
      });

      expect(deps.sendChatMessage).toHaveBeenCalledWith({
        sessionId: "chat-1",
        text: "Hello from CTO",
      });
      expect(result).toMatchObject({ success: true, sessionId: "chat-1" });
    });

    it("interrupts a chat session", async () => {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.interruptChat as any).execute({
        sessionId: "chat-1",
      });

      expect(deps.interruptChat).toHaveBeenCalledWith({ sessionId: "chat-1" });
      expect(result).toMatchObject({ success: true, sessionId: "chat-1" });
    });

    it("gets chat status and returns not found for missing sessions", async () => {
      const deps = buildDeps({
        getChatStatus: vi.fn().mockResolvedValue(null),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatStatus as any).execute({
        sessionId: "nonexistent",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Chat not found") });
    });

    it("gets chat status successfully", async () => {
      const session = { id: "chat-1", status: "idle" };
      const deps = buildDeps({
        getChatStatus: vi.fn().mockResolvedValue(session),
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getChatStatus as any).execute({
        sessionId: "chat-1",
      });

      expect(result).toMatchObject({ success: true, session });
    });
  });

  // ── Lane tools ──────────────────────────────────────────────────

  describe("lane tools", () => {
    it("lists lanes", async () => {
      const lane = { id: "lane-1", name: "primary", status: "active" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listLanes as any).execute({ includeArchived: false });

      expect(result).toMatchObject({ success: true, count: 1 });
      expect(result.lanes[0]).toMatchObject({ id: "lane-1", name: "primary" });
    });

    it("inspects a lane by ID and returns not found for missing lanes", async () => {
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.inspectLane as any).execute({ laneId: "nonexistent" });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Lane not found") });
    });

    it("inspects a lane successfully", async () => {
      const lane = { id: "lane-1", name: "primary", branchRef: "refs/heads/primary" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn(),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.inspectLane as any).execute({ laneId: "lane-1" });

      expect(result).toMatchObject({ success: true, lane });
    });

    it("returns lane navigation suggestions for operator-created ADE objects", async () => {
      const lane = { id: "lane-2", name: "ops", branchRef: "refs/heads/ops" };
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([lane]),
          create: vi.fn().mockResolvedValue(lane),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const createdLane = await (tools.createLane as any).execute({
        name: "ops",
      });

      expect(createdLane).toMatchObject({
        success: true,
        navigation: {
          surface: "lanes",
          laneId: "lane-2",
          sessionId: null,
          href: "/lanes?laneId=lane-2",
          label: "Open lane",
        },
      });
    });

    it("handles lane creation errors gracefully", async () => {
      const deps = buildDeps({
        laneService: {
          list: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockRejectedValue(new Error("Branch conflict")),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.createLane as any).execute({ name: "conflict-lane" });

      expect(result).toMatchObject({ success: false, error: "Branch conflict" });
    });
  });

  // ── PR tools ────────────────────────────────────────────────────

  describe("PR tools", () => {
    it("lists pull requests", async () => {
      const prs = [{ id: "pr-1", title: "Fix bug" }];
      const deps = buildDeps({
        prService: {
          refresh: vi.fn().mockResolvedValue(prs),
          listAll: vi.fn().mockReturnValue(prs),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listPullRequests as any).execute({ refresh: true });

      expect(result).toMatchObject({ success: true, count: 1, prs });
    });

    it("returns error when prService is null", async () => {
      const deps = buildDeps({ prService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listPullRequests as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("PR service") });
    });

    it("comments on a pull request", async () => {
      const comment = { id: "comment-1", body: "LGTM" };
      const deps = buildDeps({
        prService: {
          addComment: vi.fn().mockResolvedValue(comment),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnPullRequest as any).execute({
        prId: "pr-1",
        body: "LGTM",
      });

      expect(result).toMatchObject({ success: true, comment });
    });

    it("updates pull request title", async () => {
      const deps = buildDeps({
        prService: {
          updateTitle: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updatePullRequestTitle as any).execute({
        prId: "pr-1",
        title: "New title",
      });

      expect(result).toMatchObject({ success: true, prId: "pr-1", title: "New title" });
    });

    it("updates pull request body", async () => {
      const deps = buildDeps({
        prService: {
          updateDescription: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updatePullRequestBody as any).execute({
        prId: "pr-1",
        body: "New description",
      });

      expect(result).toMatchObject({ success: true, prId: "pr-1" });
    });

  });

  // ── Linear issue tools ──────────────────────────────────────────

  describe("Linear issue tools", () => {
    it("comments on a Linear issue", async () => {
      const comment = { id: "comment-1" };
      const deps = buildDeps({
        issueTracker: {
          createComment: vi.fn().mockResolvedValue(comment),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnLinearIssue as any).execute({
        issueId: "issue-1",
        body: "Working on it.",
      });

      expect(result).toMatchObject({ success: true, comment });
    });

    it("returns error when issue tracker is not available for commenting", async () => {
      const deps = buildDeps({ issueTracker: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.commentOnLinearIssue as any).execute({
        issueId: "issue-1",
        body: "test",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("issue tracker") });
    });

    it("updates a Linear issue state by stateId", async () => {
      const deps = buildDeps({
        issueTracker: {
          updateIssueState: vi.fn().mockResolvedValue(undefined),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updateLinearIssueState as any).execute({
        issueId: "issue-1",
        stateId: "state-done",
      });

      expect(result).toMatchObject({ success: true, issueId: "issue-1", stateId: "state-done" });
    });

    it("returns error when neither stateId nor stateName is provided", async () => {
      const deps = buildDeps({
        issueTracker: {} as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.updateLinearIssueState as any).execute({
        issueId: "issue-1",
      });

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Provide either stateId or stateName") });
    });
  });

  // ── Process tools ───────────────────────────────────────────────

  describe("process tools", () => {
    it("lists managed processes", async () => {
      const defs = [{ id: "proc-1" }];
      const runtime = [{ id: "proc-1", status: "running" }];
      const deps = buildDeps({
        processService: {
          listDefinitions: vi.fn().mockReturnValue(defs),
          listRuntime: vi.fn().mockReturnValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listManagedProcesses as any).execute({});

      expect(result).toMatchObject({ success: true, definitions: defs, runtime });
    });

    it("returns error when processService is null", async () => {
      const deps = buildDeps({ processService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listManagedProcesses as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("Process service") });
    });

    it("starts a managed process", async () => {
      const runtime = { id: "proc-1", status: "running" };
      const deps = buildDeps({
        processService: {
          start: vi.fn().mockResolvedValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.startManagedProcess as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, runtime });
    });

    it("stops a managed process", async () => {
      const runtime = { id: "proc-1", status: "stopped" };
      const deps = buildDeps({
        processService: {
          stop: vi.fn().mockResolvedValue(runtime),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.stopManagedProcess as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, runtime });
    });

    it("reads bounded process log tail", async () => {
      const deps = buildDeps({
        processService: {
          getLogTail: vi.fn().mockReturnValue("line 1\nline 2\n"),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.getManagedProcessLog as any).execute({
        processId: "proc-1",
      });

      expect(result).toMatchObject({ success: true, content: "line 1\nline 2\n" });
    });
  });

  // ── File workspace tools ────────────────────────────────────────

  describe("file workspace tools", () => {
    it("lists file workspaces", async () => {
      const workspaces = [{ id: "ws-1", laneId: "lane-1" }];
      const deps = buildDeps({
        fileService: {
          listWorkspaces: vi.fn().mockReturnValue(workspaces),
        } as any,
      });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listFileWorkspaces as any).execute({});

      expect(result).toMatchObject({ success: true, count: 1, workspaces });
    });

    it("returns error when fileService is null", async () => {
      const deps = buildDeps({ fileService: null });
      const tools = createCtoOperatorTools(deps);

      const result = await (tools.listFileWorkspaces as any).execute({});

      expect(result).toMatchObject({ success: false, error: expect.stringContaining("File service") });
    });
  });

  // ── searchCodebase tool ─────────────────────────────────────────
  describe("searchCodebase tool (execFileSync-backed rg)", () => {
    beforeEach(() => {
      execFileSyncMock.mockReset();
    });

    function getTool() {
      const deps = buildDeps();
      const tools = createCtoOperatorTools(deps);
      const tool = tools.searchCodebase as any;
      expect(tool, "searchCodebase tool must be registered").toBeTruthy();
      return tool;
    }

    it("invokes execFileSync('rg', argv, opts) with the expected argv order and cwd", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();

      await tool.execute({
        pattern: "spawnChat",
        fileGlob: "services/**/*.ts",
        maxResults: 3,
        contextLines: 2,
      });

      expect(execFileSyncMock).toHaveBeenCalledTimes(1);
      const [cmd, argv, opts] = execFileSyncMock.mock.calls[0];
      expect(cmd, "command must be rg, not a shell string").toBe("rg");
      expect(Array.isArray(argv), "argv must be an array (execFileSync form, not shell)").toBe(true);
      expect(argv).toEqual([
        "--no-heading",
        "--line-number",
        "--max-count=3",
        "--context=2",
        "--glob",
        "services/**/*.ts",
        "--",
        "spawnChat",
        ".",
      ]);
      const optsRec = opts as Record<string, unknown>;
      expect(optsRec.encoding).toBe("utf8");
      expect(optsRec.maxBuffer).toBe(512 * 1024);
      expect(optsRec.timeout).toBe(10_000);
      expect(typeof optsRec.cwd, "cwd must be a string path to ADE root").toBe("string");
      expect((optsRec.cwd as string).length, "cwd path must be non-empty").toBeGreaterThan(0);
    });

    it("defaults fileGlob to '*.ts' when not provided (executor-level fallback)", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();

      await tool.execute({ pattern: "foo", contextLines: 2 });

      const argv = execFileSyncMock.mock.calls[0][1] as string[];
      const globIdx = argv.indexOf("--glob");
      expect(globIdx, "--glob must appear").toBeGreaterThanOrEqual(0);
      expect(argv[globIdx + 1]).toBe("*.ts");
    });

    it("empty/whitespace fileGlob falls back to '*.ts'", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();

      await tool.execute({ pattern: "foo", fileGlob: "   ", contextLines: 2 });

      const argv = execFileSyncMock.mock.calls[0][1] as string[];
      const globIdx = argv.indexOf("--glob");
      expect(argv[globIdx + 1]).toBe("*.ts");
    });

    it("dedupes output lines by filename so duplicate-file matches do not exhaust maxResults", async () => {
      // Same file a.ts has 3 matches, then b.ts has 1, then c.ts has 1.
      // With maxResults=2 we should still include a.ts + b.ts (2 unique files) but NOT c.ts.
      const rgOutput = [
        "a.ts:10:first",
        "a.ts:20:second",
        "a.ts:30:third",
        "b.ts:5:first",
        "c.ts:1:first",
      ].join("\n");
      execFileSyncMock.mockReturnValue(rgOutput);
      const tool = getTool();

      const result = await tool.execute({
        pattern: "xyz",
        maxResults: 2,
        contextLines: 0,
      });

      expect(result.success).toBe(true);
      // Output must contain a.ts and b.ts content but NOT c.ts (dedup stops before adding c.ts).
      expect(result.output).toContain("a.ts:10:first");
      expect(result.output).toContain("a.ts:20:second");
      expect(result.output).toContain("a.ts:30:third");
      expect(result.output).toContain("b.ts:5:first");
      expect(result.output, "maxResults=2 should cut c.ts out").not.toContain("c.ts:1:first");
      expect(result.truncated, "hitting maxResults must mark result truncated").toBe(true);
    });

    it("marks truncated=true when unique-file count reaches maxResults", async () => {
      const rgOutput = ["a.ts:1:m", "b.ts:1:m", "c.ts:1:m"].join("\n");
      execFileSyncMock.mockReturnValue(rgOutput);
      const tool = getTool();

      const result = await tool.execute({
        pattern: "m",
        maxResults: 3,
        contextLines: 0,
      });

      expect(result.success).toBe(true);
      expect(result.truncated).toBe(true);
    });

    it("marks truncated=true when output exceeds 200 lines", async () => {
      // 210 matches from distinct files so no dedup cap trips before the 200-line cap.
      const lines: string[] = [];
      for (let i = 0; i < 210; i += 1) {
        lines.push(`file${i}.ts:1:match`);
      }
      execFileSyncMock.mockReturnValue(lines.join("\n"));
      const tool = getTool();

      const result = await tool.execute({
        pattern: "match",
        maxResults: 30,
        contextLines: 0,
      });

      expect(result.success).toBe(true);
      expect(result.truncated, "output over 200 lines must be truncated").toBe(true);
      expect(result.output.split("\n").length).toBeLessThanOrEqual(200);
    });

    it("returns success with matchCount=0 and empty output when rg exits with status 1 (no matches)", async () => {
      const err: any = new Error("rg exit 1");
      err.status = 1;
      execFileSyncMock.mockImplementation(() => {
        throw err;
      });
      const tool = getTool();

      const result = await tool.execute({ pattern: "never-matches", contextLines: 0 });

      expect(result).toMatchObject({
        success: true,
        matchCount: 0,
        truncated: false,
      });
      expect(typeof result.output).toBe("string");
    });

    it("returns success=false with error message for non-1 execution failures", async () => {
      const err: any = new Error("boom");
      err.status = 2;
      execFileSyncMock.mockImplementation(() => {
        throw err;
      });
      const tool = getTool();

      const result = await tool.execute({ pattern: "[bad-regex", contextLines: 0 });

      expect(result.success).toBe(false);
      expect(typeof result.error).toBe("string");
      expect(result.error.length, "error message must not be empty").toBeGreaterThan(0);
    });

    it("truncates pattern to 500 chars before passing to argv", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();
      const longPattern = "x".repeat(700);

      await tool.execute({ pattern: longPattern, contextLines: 0 });

      const argv = execFileSyncMock.mock.calls[0][1] as string[];
      // The pattern sits at the position right after "--" separator.
      const sep = argv.indexOf("--");
      expect(sep, "-- separator must be present").toBeGreaterThan(0);
      const sentPattern = argv[sep + 1];
      expect(sentPattern.length, "pattern must be capped at 500 chars").toBe(500);
      expect(sentPattern).toBe("x".repeat(500));
    });

    it("truncates fileGlob to 200 chars before passing to argv", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();
      const longGlob = "*".repeat(300);

      await tool.execute({ pattern: "p", fileGlob: longGlob, contextLines: 0 });

      const argv = execFileSyncMock.mock.calls[0][1] as string[];
      const globIdx = argv.indexOf("--glob");
      expect(globIdx).toBeGreaterThanOrEqual(0);
      const sentGlob = argv[globIdx + 1];
      expect(sentGlob.length, "fileGlob must be capped at 200 chars").toBe(200);
      expect(sentGlob).toBe("*".repeat(200));
    });

    it("passes dangerous shell characters through argv verbatim (execFileSync avoids shell injection)", async () => {
      execFileSyncMock.mockReturnValue("");
      const tool = getTool();
      const evil = "foo; rm -rf / && echo pwned `whoami` $(id)";

      await tool.execute({ pattern: evil, contextLines: 0 });

      const [cmd, argv] = execFileSyncMock.mock.calls[0];
      expect(cmd, "must call rg directly, not through a shell").toBe("rg");
      expect(Array.isArray(argv), "argv must be an array (no shell string)").toBe(true);
      const sep = (argv as string[]).indexOf("--");
      const sentPattern = (argv as string[])[sep + 1];
      expect(sentPattern, "dangerous chars must be passed through as a literal argv element").toBe(evil);
      // Make sure no arg was concatenated into a shell string.
      for (const a of argv as string[]) {
        expect(typeof a).toBe("string");
      }
    });
  });
});
