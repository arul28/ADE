import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAdeRpcRequestHandler,
  _resetGlobalAskUserRateLimit,
  resolveComputerUseOwners,
} from "./adeRpcServer";
import { JsonRpcError, JsonRpcErrorCode } from "./jsonrpc";

type RuntimeFixture = ReturnType<typeof createRuntime>;
const originalPlatform = process.platform;
const ADE_ENV_KEYS = [
  "ADE_DEFAULT_ROLE",
  "ADE_CHAT_SESSION_ID",
  "ADE_RUN_ID",
  "ADE_STEP_ID",
  "ADE_ATTEMPT_ID",
  "ADE_OWNER_ID",
] as const;
const originalAdeEnv = new Map<string, string | undefined>(
  ADE_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value,
    configurable: true,
  });
}

beforeEach(() => {
  for (const key of ADE_ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  setPlatform(originalPlatform);
  for (const key of ADE_ENV_KEYS) {
    const value = originalAdeEnv.get(key);
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

function createRuntime() {
  const operationStart = vi.fn((args: any) => ({ operationId: `op-${args.kind}-${Date.now()}` }));
  const operationFinish = vi.fn();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-test-"));
  fs.mkdirSync(path.join(projectRoot, ".ade", "orchestrator"), { recursive: true });
  const kv = new Map<string, unknown>();
  const laneRows = [
    {
      id: "lane-1",
      name: "Lane 1",
      laneType: "worktree",
      parentLaneId: null,
      baseRef: "main",
      branchRef: "feature/lane-1",
      worktreePath: path.join(projectRoot, ".ade", "worktrees", "lane-1"),
      archivedAt: null,
      stackDepth: 0,
      status: { dirty: false, ahead: 1, behind: 0 },
      tags: ["auth", "payments"]
    },
    {
      id: "lane-2",
      name: "Lane 2",
      laneType: "worktree",
      parentLaneId: "lane-1",
      baseRef: "feature/lane-1",
      branchRef: "feature/lane-2",
      worktreePath: path.join(projectRoot, ".ade", "worktrees", "lane-2"),
      archivedAt: null,
      stackDepth: 1,
      status: { dirty: true, ahead: 0, behind: 2 },
      tags: ["auth"]
    }
  ];

  const runtime = {
    projectRoot,
    workspaceRoot: projectRoot,
    projectId: "project-1",
    project: { rootPath: projectRoot, displayName: "project", baseRef: "main" },
    paths: {
      adeDir: path.join(projectRoot, ".ade"),
      logsDir: path.join(projectRoot, ".ade", "logs"),
      processLogsDir: path.join(projectRoot, ".ade", "logs", "processes"),
      testLogsDir: path.join(projectRoot, ".ade", "logs", "tests"),
      transcriptsDir: path.join(projectRoot, ".ade", "transcripts"),
      worktreesDir: path.join(projectRoot, ".ade", "worktrees"),
      dbPath: path.join(projectRoot, ".ade", "ade.db")
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    db: {
      getJson: vi.fn((key: string) => (kv.has(key) ? kv.get(key) : null)),
      setJson: vi.fn((key: string, value: unknown) => {
        if (value == null) {
          kv.delete(key);
          return;
        }
        kv.set(key, value);
      }),
      get: vi.fn(() => ({ count: 0 })),
      all: vi.fn(() => []),
      run: vi.fn()
    },
    keybindingsService: {
      get: vi.fn(() => [{ command: "ade.openCommandPalette", binding: "mod+k" }]),
      set: vi.fn((overrides: unknown) => overrides),
    } as any,
    onboardingService: {
      getStatus: vi.fn(() => ({ completedAt: null, dismissedAt: null, freshProject: false })),
      detectDefaults: vi.fn(async () => ({ indicators: [] })),
    } as any,
    automationPlannerService: {
      validateDraft: vi.fn((draft: unknown) => ({ ok: true, draft })),
    } as any,
    githubService: {
      getStatus: vi.fn(async () => ({ tokenStored: false, repo: "owner/repo" })),
      getRepoOrThrow: vi.fn(() => ({ owner: "owner", repo: "repo" })),
      setToken: vi.fn(async () => ({ tokenStored: true })),
      clearToken: vi.fn(async () => ({ tokenStored: false })),
    } as any,
    usageTrackingService: {
      getAdeUsageStats: vi.fn(async () => ({
        generatedAt: "2026-07-09T12:00:00.000Z",
        preset: "7d",
        daily: [],
      })),
      getUsageSnapshot: vi.fn(() => ({ available: true, entries: [] })),
      noteQuotaDemand: vi.fn(() => ({ available: true, entries: [] })),
      forceRefresh: vi.fn(async () => ({ available: true, entries: [] })),
      refreshHistory: vi.fn(async () => ({ available: true, entries: [] })),
      poll: vi.fn(async () => ({ available: true, entries: [] })),
      start: vi.fn(() => {}),
      stop: vi.fn(() => {}),
    } as any,
    autoUpdateService: {
      getSnapshot: vi.fn(() => ({ status: "idle", version: null })),
      checkForUpdates: vi.fn(() => {}),
      dismissInstalledNotice: vi.fn(() => {}),
      quitAndInstall: vi.fn(() => false),
    } as any,
    laneService: {
      list: vi.fn(async () => laneRows),
      ensurePrimaryLane: vi.fn(async () => laneRows[0]),
      listUnregisteredWorktrees: vi.fn(async () => [{ path: "/tmp/untracked-worktree", branch: "feature/untracked" }]),
      getLaneWorktreePath: vi.fn((laneId: string) => {
        const lane = laneRows.find((row) => row.id === laneId) ?? laneRows[0]!;
        return lane.worktreePath;
      }),
      getLaneBaseAndBranch: vi.fn((laneId: string) => {
        const lane = laneRows.find((row) => row.id === laneId) ?? laneRows[0]!;
        return {
          baseRef: lane.baseRef,
          branchRef: lane.branchRef,
          worktreePath: lane.worktreePath,
          laneType: lane.laneType
        };
      }),
      create: vi.fn(async ({ name }: { name: string }) => ({
        ...laneRows[0],
        id: "lane-new",
        name,
        branchRef: "feature/lane-new",
        worktreePath: "/tmp/project/.ade/worktrees/lane-new"
      })),
      importBranch: vi.fn(async ({ branchRef, name }: { branchRef: string; name?: string }) => ({
        ...laneRows[0],
        id: "lane-imported",
        name: name ?? "Imported lane",
        branchRef,
      })),
      linkLinearIssues: vi.fn((args: { laneId: string; issues: unknown[] }) =>
        args.issues.map((issue, index) => ({ id: `link-${index}`, laneId: args.laneId, issue })),
      ),
      unlinkLinearIssues: vi.fn(() => true),
      attachLinearIssueToSession: vi.fn((args: { chatSessionId: string; issues: unknown[] }) =>
        args.issues.map((issue, index) => ({
          id: `session-link-${index}`,
          chatSessionId: args.chatSessionId,
          issue,
        })),
      ),
      detachLinearIssueFromSession: vi.fn(() => true),
      listLinearIssuesForSession: vi.fn((args: { chatSessionId: string }) => [
        { id: "session-link-0", chatSessionId: args.chatSessionId, issue: { id: "issue-1", identifier: "ENG-1" } },
      ]),
      delete: vi.fn(async () => {})
    },
    sessionService: {
      get: vi.fn(),
      updateMeta: vi.fn(),
      readTranscriptTail: vi.fn(() => "")
    },
    sessionDeltaService: {
      getSessionDelta: vi.fn((sessionId: string) => ({ sessionId, filesChanged: 2 })),
    },
    operationService: {
      start: operationStart,
      finish: operationFinish,
      list: vi.fn(() => [{ id: "op-1", kind: "git_push", status: "running" }]),
    },
    projectConfigService: {} as any,
    aiIntegrationService: {
      getStatus: vi.fn(async () => ({
        mode: "subscription",
        availableProviders: {
          claude: {
            binary: { present: true, source: "path", path: "/usr/local/bin/claude" },
            auth: { ready: true, mode: "oauth", detail: null },
          },
          codex: true,
          cursor: false,
          droid: false,
        },
        models: {
          claude: [],
          codex: [],
          cursor: [],
          droid: [],
        },
        detectedAuth: [
          { type: "cli-subscription", cli: "codex", authenticated: true },
        ],
        providerConnections: {},
        runtimeConnections: {},
        availableModelIds: ["openai/gpt-5.5"],
        opencodeBinaryInstalled: true,
        opencodeBinarySource: "bundled",
        opencodeInventoryError: null,
        opencodeProviders: [],
        apiKeyStore: {
          secureStorageAvailable: true,
          legacyPlaintextDetected: false,
          decryptionFailed: false,
        },
      })),
      getDailyUsageBatch: vi.fn(() => new Map()),
      getFeatureFlag: vi.fn(() => true),
      getDailyBudgetLimit: vi.fn(() => null),
    } as any,
    conflictService: {
      runPrediction: vi.fn(async () => ({ lanes: [], matrix: [], overlaps: [] })),
      getLaneStatus: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "merge-ready" })),
      listOverlaps: vi.fn(async () => []),
      rebaseLane: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "clean", conflictedFiles: [] }))
    },
    gitService: {
      getConflictState: vi.fn(async () => ({ laneId: "lane-1", kind: null, inProgress: false, conflictedFiles: [], canContinue: false, canAbort: false })),
      stageFile: vi.fn(async () => ({ success: true })),
      stageAll: vi.fn(async () => ({ success: true })),
      unstageFile: vi.fn(async () => ({ success: true })),
      unstageAll: vi.fn(async () => ({ success: true })),
      discardFile: vi.fn(async () => ({ success: true })),
      restoreStagedFile: vi.fn(async () => ({ success: true })),
      commit: vi.fn(async () => ({ success: true })),
      generateCommitMessage: vi.fn(async () => ({ message: "generated commit message", model: "gpt-5-mini" })),
      listRecentCommits: vi.fn(async () => [{ sha: "abc123", subject: "test" }]),
      getSyncStatus: vi.fn(async () => ({ ahead: 1, behind: 0, tracking: true })),
      fetch: vi.fn(async () => ({ success: true })),
      pull: vi.fn(async () => ({ success: true })),
      push: vi.fn(async () => ({ success: true })),
      undoLastHeadChange: vi.fn(async () => ({ success: true })),
      redoLastHeadChange: vi.fn(async () => ({ success: true })),
      listBranches: vi.fn(async () => [{ name: "main", current: true, ahead: 0, behind: 0, hasUpstream: true, upstream: "origin/main" }]),
      checkoutBranch: vi.fn(async () => ({ success: true })),
      stashPush: vi.fn(async () => ({ success: true })),
      listStashes: vi.fn(async () => [{ oid: "oid-0", ref: "stash@{0}", createdAt: "2026-04-06T00:00:00.000Z", subject: "test stash" }]),
      stashApply: vi.fn(async () => ({ success: true })),
      stashPop: vi.fn(async () => ({ success: true })),
      stashDrop: vi.fn(async () => ({ success: true })),
      stashClear: vi.fn(async () => ({ success: true })),
    },
    diffService: {
      getChanges: vi.fn(async () => ({ unstaged: [], staged: [] }))
    },
    ptyService: {
      create: vi.fn(async () => ({ ptyId: "pty-1", sessionId: "session-1" })),
      sendToSession: vi.fn(async () => ({
        ptyId: "pty-1",
        sessionId: "session-1",
        pid: 123,
        session: null,
        resumed: false,
        reusedExistingRuntime: true,
      })),
      resumeSession: vi.fn(async () => ({
        ptyId: "pty-1",
        sessionId: "session-1",
        pid: 123,
        session: null,
        resumed: true,
        reusedExistingRuntime: false,
      })),
      dispose: vi.fn(() => ({ disposed: true, reason: "disposed" })),
      writeBySessionId: vi.fn((sessionId: string, data: string): boolean => {
        void sessionId;
        void data;
        return true;
      }),
      write: vi.fn(),
      resize: vi.fn(),
      readTranscriptTail: vi.fn(async () => ""),
      list: vi.fn(() => []),
      enrichSessions: vi.fn((sessions: unknown[]) => sessions),
      listTerminals: vi.fn(() => []),
      readTerminal: vi.fn(async () => ({ terminalId: "session-1", data: "", nextSince: 0 })),
      previewTerminal: vi.fn(async () => ({ terminalId: "session-1", session: null, source: "empty", snapshot: null, transcript: null, capturedAt: new Date().toISOString() })),
      writeTerminal: vi.fn(async () => ({ ok: true })),
      resizeTerminal: vi.fn(() => ({ ok: true, cols: 100, rows: 30 })),
      signalTerminal: vi.fn(() => ({ ok: true })),
      activeForChat: vi.fn(() => null),
      reattachChatCli: vi.fn(async () => ({ terminalId: "session-1", ptyId: "pty-1", pid: 123, relaunched: false })),
    },
    testService: {
      run: vi.fn(async () => ({ id: "test-run-1", status: "running" })),
      listRuns: vi.fn(() => [{ id: "test-run-1", status: "running" }]),
      stop: vi.fn(),
      getLogTail: vi.fn(() => "")
    },
    prService: {
      simulateIntegration: vi.fn(async () => ({ steps: [], conflicts: [], clean: true })),
      createQueuePrs: vi.fn(async () => ({ groupId: "group-1", prs: [] })),
      createIntegrationPr: vi.fn(async () => ({ prId: "pr-int-1", url: "https://github.com/pr/1" })),
      draftDescription: vi.fn(async () => ({ title: "Drafted PR", body: "Drafted body" })),
      createFromLane: vi.fn(async () => ({
        id: "pr-new",
        laneId: "lane-1",
        repoOwner: "acme",
        repoName: "ade",
        githubPrNumber: 42,
        githubUrl: "https://github.com/acme/ade/pull/42",
        title: "New PR",
        status: "open",
      })),
      getPrHealth: vi.fn(async (prId: string) => ({ prId, healthy: true, checks: "pass", reviews: "approved" })),
      landQueueNext: vi.fn(async () => ({ landed: true, prId: "pr-1", sha: "def456" })),
      getChecks: vi.fn(async () => [
        {
          name: "ci / unit",
          status: "completed",
          conclusion: "success",
          detailsUrl: "https://example.com/check/1",
          startedAt: null,
          completedAt: null,
        },
      ]),
      getComments: vi.fn(async () => [
        {
          id: "comment-1",
          author: "reviewer",
          authorAvatarUrl: null,
          body: "Please fix the loading state.",
          source: "issue",
          url: "https://example.com/comments/1",
          path: null,
          line: null,
          createdAt: "2026-03-17T19:00:00.000Z",
          updatedAt: "2026-03-17T19:00:00.000Z",
        },
      ]),
      getReviews: vi.fn(async () => [
        {
          reviewer: "reviewer",
          reviewerAvatarUrl: null,
          state: "changes_requested",
          body: "Needs work.",
          submittedAt: "2026-03-17T19:00:00.000Z",
        },
      ]),
      getActionRuns: vi.fn(async () => [
        {
          id: 71,
          name: "CI",
          status: "completed",
          conclusion: "failure",
          headSha: "abc123",
          htmlUrl: "https://example.com/run/71",
          createdAt: "2026-03-17T19:00:00.000Z",
          updatedAt: "2026-03-17T19:10:00.000Z",
          jobs: [
            {
              id: 81,
              name: "test",
              status: "completed",
              conclusion: "failure",
              startedAt: null,
              completedAt: null,
              steps: [
                {
                  name: "vitest",
                  status: "completed",
                  conclusion: "failure",
                  number: 1,
                  startedAt: null,
                  completedAt: null,
                },
              ],
            },
          ],
        },
      ]),
      getReviewThreads: vi.fn(async () => [
        {
          id: "thread-1",
          isResolved: false,
          isOutdated: false,
          path: "src/index.ts",
          line: 12,
          originalLine: 12,
          startLine: null,
          originalStartLine: null,
          diffSide: "RIGHT",
          url: "https://example.com/thread/1",
          createdAt: "2026-03-17T19:00:00.000Z",
          updatedAt: "2026-03-17T19:00:00.000Z",
          comments: [
            {
              id: "thread-comment-1",
              author: "reviewer",
              authorAvatarUrl: null,
              body: "Please handle the loading state.",
              url: "https://example.com/thread-comment/1",
              createdAt: "2026-03-17T19:00:00.000Z",
              updatedAt: "2026-03-17T19:00:00.000Z",
            },
          ],
        },
      ]),
      rerunChecks: vi.fn(async () => undefined),
      replyToReviewThread: vi.fn(async ({ threadId }: { threadId: string }) => ({
        id: "reply-1",
        author: "bot",
        authorAvatarUrl: null,
        body: `Reply to ${threadId}`,
        url: "https://example.com/reply/1",
        createdAt: "2026-03-17T19:00:00.000Z",
        updatedAt: "2026-03-17T19:00:00.000Z",
      })),
      resolveReviewThread: vi.fn(async () => undefined),
      updateTitle: vi.fn(async () => undefined),
      updateBody: vi.fn(async () => undefined),
      addComment: vi.fn(async ({ body }: { body: string }) => ({ id: "comment-new", body })),
    },
    agentChatService: {
      listSessions: vi.fn(async () => [
        {
          sessionId: "chat-1",
          laneId: "lane-1",
          title: "CTO Work Chat",
          provider: "codex",
          model: "gpt-5.4-codex",
          status: "idle",
          lastActivityAt: "2026-03-17T19:00:00.000Z",
          createdAt: "2026-03-17T19:00:00.000Z",
        },
      ]),
      getSessionSummary: vi.fn(async (sessionId: string) => ({
        sessionId,
        laneId: "lane-1",
        title: "CTO Work Chat",
        provider: "codex",
        model: "gpt-5.4-codex",
        status: "idle",
        lastActivityAt: "2026-03-17T19:00:00.000Z",
        createdAt: "2026-03-17T19:00:00.000Z",
      })),
      getChatTranscript: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        sessionId,
        entries: [{ role: "assistant", text: "hello", timestamp: "2026-03-17T19:00:00.000Z" }],
        truncated: false,
        totalEntries: 1,
      })),
      createSession: vi.fn(async ({ laneId, title }: { laneId: string; title?: string }) => ({
        id: "chat-new",
        laneId,
        provider: "codex",
        model: "gpt-5.4-codex",
        title: title ?? "Codex Chat",
        status: "idle",
        createdAt: "2026-03-17T19:10:00.000Z",
        lastActivityAt: "2026-03-17T19:10:00.000Z",
      })),
      updateSession: vi.fn(async ({ sessionId, title }: { sessionId: string; title?: string | null }) => ({
        id: sessionId,
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        title: title ?? "Updated Chat",
        status: "idle",
        createdAt: "2026-03-17T19:10:00.000Z",
        lastActivityAt: "2026-03-17T19:10:00.000Z",
      })),
      requestChatInput: vi.fn(async () => ({
        decision: "accept",
        answers: { answer: ["yes"] },
        responseText: "yes",
      })),
      sendMessage: vi.fn(async () => {}),
      messageSession: vi.fn(async (args: unknown) => ({
        sessionId: (args as { sessionId?: string }).sessionId ?? "chat-unknown",
        kind: (args as { kind?: string }).kind ?? "auto",
        routedAction: "sendMessage",
        statusBefore: "idle",
        awaitingInputBefore: false,
        delivery: "sent",
      })),
      interrupt: vi.fn(async () => {}),
      resumeSession: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        id: sessionId,
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4-codex",
        status: "idle",
        createdAt: "2026-03-17T19:10:00.000Z",
        lastActivityAt: "2026-03-17T19:10:00.000Z",
      })),
      dispose: vi.fn(async () => {}),
      ensureIdentitySession: vi.fn(async ({ laneId }: { laneId: string }) => ({
        id: "cto-session",
        laneId,
        provider: "codex",
        model: "gpt-5.4-codex",
        status: "idle",
        createdAt: "2026-03-17T19:10:00.000Z",
        lastActivityAt: "2026-03-17T19:10:00.000Z",
      })),
    } as any,
    fileService: null,
    ctoMemoryService: {
      appendMemoryFact: vi.fn((fact: string) => ({ saved: true, fact })),
      searchMemory: vi.fn(() => [{ file: "MEMORY.md", date: null, line: 1, snippet: "a fact" }]),
      getSnapshot: vi.fn(() => ({
        memory: "# CTO Durable Memory\n\n## Facts\n\n- a fact",
        threadState: "# CTO Thread State\n\nrolling summary",
        dailyLog: "",
        dailyLogDate: "2026-07-04",
        updatedAt: "2026-07-04T09:00:00.000Z",
      })),
    } as any,
    ctoStateService: {
      getIdentity: vi.fn(() => ({
        name: "CTO",
        version: 1,
        persona: "test",
        modelPreferences: { provider: "codex", model: "gpt-5.4-codex", modelId: "openai/gpt-5.4-codex" },
        updatedAt: new Date().toISOString()
      })),
      getSnapshot: vi.fn((recentLimit = 10) => ({
        identity: {
          name: "CTO",
          version: 1,
          persona: "test",
          modelPreferences: { provider: "claude", model: "sonnet" },
          updatedAt: new Date().toISOString()
        },
        recentSessions: Array.from({ length: recentLimit }, (_, index) => ({
          id: `session-${index + 1}`,
          sessionId: `chat-${index + 1}`,
          summary: `summary-${index + 1}`,
          startedAt: "2026-03-17T19:00:00.000Z",
          endedAt: null,
          provider: "codex",
          modelId: "gpt-5.4-codex",
          capabilityMode: "full_tooling",
          createdAt: "2026-03-17T19:00:00.000Z",
          prevHash: null,
        })),
      })),
    } as any,
    linearCredentialService: {
      getStatus: vi.fn(() => ({
        tokenStored: true,
        authMode: "manual",
        tokenExpiresAt: null,
        refreshTokenStored: false,
        oauthConfigured: true,
      })),
    } as any,
    linearIssueTracker: {
      getConnectionStatus: vi.fn(async () => ({
        connected: true,
        viewerId: "user-1",
        viewerName: "Arul",
        message: null,
      })),
      getQuickView: vi.fn(async (connection: unknown) => ({
        connection,
        organization: {
          id: "org-1",
          name: "ADE",
          urlKey: "ade",
          logoUrl: null,
          gitBranchFormat: null,
          createdIssueCount: 12,
          roadmapEnabled: true,
          customersEnabled: false,
          releasesEnabled: false,
        },
        viewer: {
          id: "user-1",
          name: "Arul",
          displayName: "Arul",
          email: "arul@example.com",
          avatarUrl: null,
          admin: true,
          guest: false,
          url: null,
        },
        projects: [],
        teams: [],
        assignedIssues: [],
        recentIssues: [],
        fetchedAt: "2026-03-17T19:11:00.000Z",
        sdk: { packageName: "@linear/sdk", surfaces: ["viewer", "organization"] },
      })),
      fetchIssueById: vi.fn(async (issueId: string) => ({
        id: issueId,
        identifier: "LIN-1",
        title: "Issue",
        description: "Desc",
        url: "https://linear.app/issue/LIN-1",
        projectSlug: "proj",
        stateName: "Todo",
        priorityLabel: "normal",
        labels: [],
        assigneeName: null,
      })),
      runGraphQL: vi.fn(async (args: unknown) => ({ viewer: { id: "user-1" }, _args: args })),
      createComment: vi.fn(async () => ({ id: "comment-1" })),
      fetchWorkflowStates: vi.fn(async () => [{ id: "state-done", name: "Done" }]),
      updateIssueState: vi.fn(async () => {}),
      listProjects: vi.fn(async () => [{ id: "proj-1", name: "ADE", slug: "ade", teamName: "ADE", teamKey: "ADE" }]),
      listUsers: vi.fn(async () => [{ id: "user-1", name: "Arul", displayName: "Arul" }]),
      listWorkflowStates: vi.fn(async () => [{ id: "state-1", name: "Todo", type: "unstarted", teamId: "team-1", teamKey: "ADE" }]),
      searchIssues: vi.fn(async (query: any) => ({
        issues: [{ id: "issue-1", identifier: "ADE-123", title: "Test", _query: query }],
        pageInfo: { hasNextPage: false, endCursor: null },
      })),
      fetchIssueComments: vi.fn(async (issueId: string) => [
        { id: "comment-1", body: "First comment", createdAt: "2026-03-17T19:00:00.000Z", userName: "arul", userDisplayName: "Arul" },
      ]),
    } as any,
    processService: null,
    computerUseArtifactBrokerService: {
      getBackendStatus: vi.fn(() => ({ backends: [] })),
      listArtifacts: vi.fn(() => []),
      ingest: vi.fn(() => ({ artifacts: [] })),
      readArtifactPreview: vi.fn(async () => "data:image/png;base64,AAAA"),
    } as any,
    eventBuffer: {
      push: vi.fn(),
      drain: vi.fn((cursor: number, limit?: number) => ({
        events: [
          { id: cursor + 1, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "test" } }
        ],
        nextCursor: cursor + 1,
        hasMore: false,
        eventEpoch: "test-event-epoch",
      })),
      epoch: vi.fn(() => "test-event-epoch"),
      size: vi.fn(() => 1)
    } as any,
    dispose: vi.fn()
  } as any;

  return {
    runtime,
    operationStart,
    operationFinish
  };
}

async function initialize(
  handler: ReturnType<typeof createAdeRpcRequestHandler>,
  identity?: Record<string, unknown>,
  params: Record<string, unknown> = {},
) {
  const requestedRole = typeof identity?.role === "string" ? identity.role : null;
  const validRole = requestedRole === "cto"
    || requestedRole === "orchestrator"
    || requestedRole === "agent"
    || requestedRole === "external"
    || requestedRole === "evaluator";
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  if (validRole && requestedRole) {
    process.env.ADE_DEFAULT_ROLE = requestedRole;
  }
  try {
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: identity ? { ...params, identity } : params,
    });
  } finally {
    if (validRole) {
      if (previousRole != null) {
        process.env.ADE_DEFAULT_ROLE = previousRole;
      } else {
        delete process.env.ADE_DEFAULT_ROLE;
      }
    }
  }
}

async function callTool(
  handler: ReturnType<typeof createAdeRpcRequestHandler>,
  name: string,
  argumentsPayload: Record<string, unknown>
): Promise<any> {
  const result = await handler({
    jsonrpc: "2.0",
    id: 2,
    method: "ade/actions/call",
    params: {
      name,
      arguments: argumentsPayload
    }
  });
  if (
    result
    && typeof result === "object"
    && !Array.isArray(result)
    && (result as { ok?: unknown }).ok === false
  ) {
    return {
      isError: true,
      structuredContent: result,
      error: (result as { error?: unknown }).error,
    };
  }
  return {
    structuredContent: result,
    ...(result && typeof result === "object" && !Array.isArray(result) ? result : {}),
  };
}

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    previous.set(key, process.env[key]);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createFakePathExecutable(dir: string, name: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const executablePath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  fs.writeFileSync(executablePath, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
  if (process.platform !== "win32") fs.chmodSync(executablePath, 0o755);
  return executablePath;
}

describe("adeRpcServer", () => {
  it("exposes direct PTY RPC methods with enriched create/list responses", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    const session = {
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      status: "running",
      ownerPid: 12_345,
      chatSessionId: null,
    };
    runtime.sessionService.get.mockReturnValue(session);
    runtime.ptyService.list.mockReturnValue([session]);
    await initialize(handler, { role: "agent", chatSessionId: "session-1" });

    const created = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "pty.create",
      params: { args: { laneId: "lane-1", title: "Claude", cols: 120, rows: 40 } },
    });
    expect(created).toEqual({
      ptyId: "pty-1",
      sessionId: "session-1",
      session,
    });
    expect(runtime.ptyService.create).toHaveBeenCalledWith({
      laneId: "lane-1",
      title: "Claude",
      cols: 120,
      rows: 40,
    });

    await expect(handler({
      jsonrpc: "2.0",
      id: 3,
      method: "pty.sendToSession",
      params: { args: { sessionId: "session-1", text: "continue" } },
    })).resolves.toMatchObject({ sessionId: "session-1", reusedExistingRuntime: true });
    expect(runtime.ptyService.sendToSession).toHaveBeenCalledWith({ sessionId: "session-1", text: "continue" });

    await expect(handler({
      jsonrpc: "2.0",
      id: 4,
      method: "pty.resumeSession",
      params: { args: { sessionId: "session-1", cols: 100, rows: 32 } },
    })).resolves.toMatchObject({ sessionId: "session-1", resumed: true, reusedExistingRuntime: false });
    expect(runtime.ptyService.resumeSession).toHaveBeenCalledWith({ sessionId: "session-1", cols: 100, rows: 32 });

    await expect(handler({
      jsonrpc: "2.0",
      id: 5,
      method: "pty.write",
      params: { args: { ptyId: "pty-1", data: "x" } },
    })).resolves.toBeNull();
    expect(runtime.ptyService.write).toHaveBeenCalledWith({ ptyId: "pty-1", data: "x" });

    await expect(handler({
      jsonrpc: "2.0",
      id: 6,
      method: "pty.resize",
      params: { args: { ptyId: "pty-1", cols: 100, rows: 30 } },
    })).resolves.toBeNull();
    expect(runtime.ptyService.resize).toHaveBeenCalledWith({ ptyId: "pty-1", cols: 100, rows: 30 });

    await expect(handler({
      jsonrpc: "2.0",
      id: 7,
      method: "pty.dispose",
      params: { args: { ptyId: "pty-1", sessionId: "session-1" } },
    })).resolves.toEqual({ disposed: true, reason: "disposed" });
    expect(runtime.ptyService.dispose).toHaveBeenCalledWith({ ptyId: "pty-1", sessionId: "session-1" });

    const listed = await handler({
      jsonrpc: "2.0",
      id: 8,
      method: "pty.list",
      params: { args: { laneId: "lane-1", limit: 20 } },
    });
    expect(listed).toEqual({ sessions: [session] });
    expect(runtime.ptyService.list).toHaveBeenCalledWith({ laneId: "lane-1", limit: 20 });
  });

  it("hides direct PTY RPC methods from external sessions", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "external" });

    const blocked = [
      {
        method: "pty.create",
        params: { args: { laneId: "lane-1", title: "Claude", cols: 120, rows: 40 } },
        spy: runtime.ptyService.create,
      },
      {
        method: "pty.sendToSession",
        params: { args: { sessionId: "session-1", text: "continue" } },
        spy: runtime.ptyService.sendToSession,
      },
      {
        method: "pty.resumeSession",
        params: { args: { sessionId: "session-1" } },
        spy: runtime.ptyService.resumeSession,
      },
      { method: "pty.write", params: { args: { ptyId: "pty-1", data: "x" } }, spy: runtime.ptyService.write },
      { method: "pty.resize", params: { args: { ptyId: "pty-1", cols: 100, rows: 30 } }, spy: runtime.ptyService.resize },
      { method: "pty.dispose", params: { args: { ptyId: "pty-1", sessionId: "session-1" } }, spy: runtime.ptyService.dispose },
      { method: "pty.list", params: { args: { laneId: "lane-1", limit: 20 } }, spy: runtime.ptyService.list },
    ] as const;

    for (const [index, rpc] of blocked.entries()) {
      await expect(handler({
        jsonrpc: "2.0",
        id: 2 + index,
        method: rpc.method,
        params: rpc.params,
      })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });
      expect(rpc.spy).not.toHaveBeenCalled();
    }
  });

  it("scopes direct PTY RPC methods to the caller terminal context", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    const owned = {
      id: "owned-session",
      laneId: "lane-1",
      ptyId: "pty-owned",
      status: "running",
      ownerPid: 12_345,
      chatSessionId: null,
    };
    const peer = {
      id: "peer-session",
      laneId: "lane-2",
      ptyId: "pty-peer",
      status: "running",
      ownerPid: 54_321,
      chatSessionId: null,
    };
    runtime.sessionService.get.mockImplementation((sessionId: string) => {
      if (sessionId === owned.id) return owned;
      if (sessionId === peer.id) return peer;
      return null;
    });
    runtime.ptyService.list.mockImplementation((args: { laneId?: string } = {}) =>
      [owned, peer].filter((session) => !args.laneId || session.laneId === args.laneId));
    await initialize(handler, { role: "agent", chatSessionId: owned.id });

    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "pty.list",
      params: { args: {} },
    })).resolves.toEqual({ sessions: [owned] });

    await expect(handler({
      jsonrpc: "2.0",
      id: 3,
      method: "pty.list",
      params: { args: { laneId: peer.laneId } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 4,
      method: "pty.create",
      params: { args: { laneId: peer.laneId, title: "Peer", cols: 120, rows: 40 } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 5,
      method: "pty.sendToSession",
      params: { args: { sessionId: peer.id, text: "continue" } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 6,
      method: "pty.resumeSession",
      params: { args: { sessionId: peer.id } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 7,
      method: "pty.write",
      params: { args: { ptyId: peer.ptyId, data: "x" } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 8,
      method: "pty.resize",
      params: { args: { ptyId: peer.ptyId, cols: 100, rows: 30 } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    await expect(handler({
      jsonrpc: "2.0",
      id: 9,
      method: "pty.dispose",
      params: { args: { ptyId: peer.ptyId, sessionId: owned.id } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.methodNotFound });

    expect(runtime.ptyService.create).not.toHaveBeenCalled();
    expect(runtime.ptyService.sendToSession).not.toHaveBeenCalled();
    expect(runtime.ptyService.resumeSession).not.toHaveBeenCalled();
    expect(runtime.ptyService.write).not.toHaveBeenCalled();
    expect(runtime.ptyService.resize).not.toHaveBeenCalled();
    expect(runtime.ptyService.dispose).not.toHaveBeenCalled();
  });

  it("routes app/navigate through the runtime navigation service", async () => {
    const { runtime } = createRuntime();
    const navigate = vi.fn(async () => ({ ok: true, mode: "desktop", windowId: 7 }));
    runtime.appNavigationService = { navigate };
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "cto" });

    const result = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "app/navigate",
      params: {
        source: "ade-code",
        target: { kind: "lane", sessionId: "chat-1", laneId: "lane-1" },
      },
    });

    expect(result).toEqual({ ok: true, mode: "desktop", windowId: 7 });
    expect(navigate).toHaveBeenCalledWith({
      source: "ade-code",
      target: { kind: "lane", sessionId: "chat-1", laneId: "lane-1" },
    });
  });

  it("reports app/navigate unavailable in headless runtime", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "cto" });

    const result = await handler({
      jsonrpc: "2.0",
      id: 2,
      method: "app/navigate",
      params: {
        source: "ade-code",
        target: { kind: "work" },
      },
    });

    expect(result).toEqual({
      ok: false,
      mode: "unavailable",
      message: "Desktop navigation is unavailable in this runtime.",
    });
  });

  it("rejects malformed app/navigate targets before calling the runtime service", async () => {
    const { runtime } = createRuntime();
    const navigate = vi.fn(async () => ({ ok: true, mode: "desktop", windowId: 7 }));
    runtime.appNavigationService = { navigate };
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "cto" });

    await expect(handler({
      jsonrpc: "2.0",
      id: 2,
      method: "app/navigate",
      params: {
        source: "ade-code",
        target: { kind: "lane" },
      },
    })).rejects.toMatchObject({
      code: JsonRpcErrorCode.invalidParams,
      message: "app/navigate target 'lane' requires laneId.",
    });

    expect(navigate).not.toHaveBeenCalled();
  });

  it("rejects app/navigate file targets that are not repo-relative", async () => {
    const { runtime } = createRuntime();
    const navigate = vi.fn(async () => ({ ok: true, mode: "desktop", windowId: 7 }));
    runtime.appNavigationService = { navigate };
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "cto" });

    // Traversal, absolute paths, and drive letters must never reach the
    // renderer's path composition — the RPC path bypasses parseDeeplink.
    for (const path of ["../../.ssh/config", "/etc/passwd", "C:/windows/system32", "src/../../secret"]) {
      await expect(handler({
        jsonrpc: "2.0",
        id: 3,
        method: "app/navigate",
        params: { source: "ade-code", target: { kind: "file", path } },
      })).rejects.toMatchObject({
        code: JsonRpcErrorCode.invalidParams,
        message: "app/navigate target 'file' requires a repo-relative path.",
      });
    }
    expect(navigate).not.toHaveBeenCalled();

    // A valid repo-relative path still routes through.
    const ok = await handler({
      jsonrpc: "2.0",
      id: 4,
      method: "app/navigate",
      params: { source: "ade-code", target: { kind: "file", path: "src/app.ts", line: 3 } },
    });
    expect(ok).toBeTruthy();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      source: "ade-code",
      target: { kind: "file", path: "src/app.ts", line: 3 },
    });
  });

  it("rejects app/navigate commit targets with malformed shas", async () => {
    const { runtime } = createRuntime();
    const navigate = vi.fn(async () => ({ ok: true, mode: "desktop", windowId: 7 }));
    runtime.appNavigationService = { navigate };
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { role: "cto" });

    await expect(handler({
      jsonrpc: "2.0",
      id: 5,
      method: "app/navigate",
      params: { source: "ade-code", target: { kind: "commit", sha: "not-a-sha" } },
    })).rejects.toMatchObject({ code: JsonRpcErrorCode.invalidParams });
    expect(navigate).not.toHaveBeenCalled();

    const ok = await handler({
      jsonrpc: "2.0",
      id: 6,
      method: "app/navigate",
      params: { source: "ade-code", target: { kind: "commit", sha: "ABC1234" } },
    });
    expect(ok).toBeTruthy();
    expect(navigate).toHaveBeenCalledWith({
      source: "ade-code",
      target: { kind: "commit", sha: "abc1234" },
    });
  });

  it("treats requested privileged roles as external without trusted env identity", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    delete process.env.ADE_DEFAULT_ROLE;
    try {
      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: {
          identity: {
            callerId: "rogue-client",
            role: "orchestrator",
          },
        },
      });
      const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;

      const names = (result.actions ?? []).map((tool: any) => tool.name);
      expect(names).not.toContain("spawn_worker");
      expect(names).not.toContain("get_cto_state");
      expect(names).not.toContain("get_environment_info");
      expect(names).not.toContain("launch_app");
      expect(names).not.toContain("interact_gui");
      expect(names).not.toContain("screenshot_environment");
      expect(names).not.toContain("record_environment");

      const denied = await callTool(handler, "screenshot_environment", {});
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.error ?? denied.structuredContent ?? {})).toContain(
        "Unsupported tool: screenshot_environment",
      );
      const environmentDenied = await callTool(handler, "get_environment_info", {});
      expect(environmentDenied.isError).toBe(true);
      expect(JSON.stringify(environmentDenied.error ?? environmentDenied.structuredContent ?? {})).toContain(
        "Unsupported tool: get_environment_info",
      );
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });

  it("allows trusted runtimes to serve lower-privilege requested roles", async () => {
    await withEnv({ ADE_DEFAULT_ROLE: "cto" }, async () => {
      const { runtime } = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

      await handler({
        jsonrpc: "2.0",
        id: 1,
        method: "ade/initialize",
        params: {
          identity: {
            callerId: "agent-client",
            role: "agent",
          },
        },
      });
      const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;

      const names = (result.actions ?? []).map((tool: any) => tool.name);
      expect(names).toContain("spawn_agent");
      expect(names).not.toContain("get_cto_state");
      expect(names).not.toContain("getLinearSyncDashboard");
    });
  });

  it("lists the orchestration-safe tool surface for orchestrator callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "coord-1", role: "orchestrator" });
    const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;

    const names = (result.actions ?? []).map((tool: any) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "spawn_agent",
        "create_lane",
        "check_conflicts",
        "merge_lane",
        "ask_user",
        "get_environment_info",
        "launch_app",
        "interact_gui",
        "screenshot_environment",
        "record_environment",
        "run_tests",
        "start_cli_session",
        "send_to_session",
        "get_lane_status",
        "list_lanes",
        "commit_changes",
        "stream_events",
      ])
    );
    expect(names).not.toContain("reflection_add");
    expect(names.length).toBeGreaterThan(20);
  });

  it("reflects backend availability changes in the action list", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "worker-1",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1",
    });
    const before = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;
    const beforeNames = (before.actions ?? []).map((tool: any) => tool.name);
    expect(beforeNames).toContain("screenshot_environment");

    fixture.runtime.computerUseArtifactBrokerService.getBackendStatus.mockReturnValue({
      backends: [{ id: "external-proof", available: true }],
    });

    const after = (await handler({ jsonrpc: "2.0", id: 4, method: "ade/actions/list" })) as any;
    const afterNames = (after.actions ?? []).map((tool: any) => tool.name);
    expect(afterNames).not.toContain("screenshot_environment");
    expect(fixture.runtime.computerUseArtifactBrokerService.getBackendStatus).toHaveBeenCalledTimes(2);
  });
  it("hides ADE spawn tools from standalone chat callers", async () => {
    await withEnv({ ADE_DEFAULT_ROLE: "agent", ADE_CHAT_SESSION_ID: "chat-1" }, async () => {
      const { runtime } = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "chat-1", role: "agent" });
      const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;
      const names = (result.actions ?? []).map((tool: any) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "ask_user",
          "create_lane",
          "run_tests",
        ])
      );
      expect(names).not.toContain("spawn_agent");
      expect(names).not.toContain("delegate_to_subagent");
      expect(names).not.toContain("delegate_parallel");
      expect(names).not.toContain("report_status");
      expect(names).not.toContain("report_result");
      expect(names).not.toContain("get_worker_output");
      expect(names).not.toContain("list_workers");
    });
  });

  it("lists CTO operator and Linear sync tools for cto callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;

    const names = (result.actions ?? []).map((tool: any) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_cto_state",
        "saveMemory",
        "searchMemory",
        "readMemory",
        "listChats",
        "spawnChat",
        "getChatStatus",
        "readChatTranscript",
        "get_pr_health",
        "pr_get_checks",
        "pr_get_review_comments",
        "pr_rerun_failed_checks",
        "pr_reply_to_review_thread",
        "pr_resolve_review_thread",
        "getLinearQuickView",
        "getLinearIssuePickerData",
        "searchLinearIssues",
        "getLinearIssueComments",
      ]),
    );
    expect(names).not.toContain("spawn_worker");
    expect(names).not.toContain("listLinearWorkflows");
    expect(names).not.toContain("getLinearSyncDashboard");
  });

  it("dispatches CTO memory tools through ctoMemoryService", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "cto-1", role: "cto" });

    const saved = await callTool(handler, "saveMemory", { fact: "Prefer sentence case." });
    expect((runtime.ctoMemoryService as any).appendMemoryFact).toHaveBeenCalledWith("Prefer sentence case.");
    expect(saved.structuredContent).toEqual(
      expect.objectContaining({ success: true, saved: true, file: "MEMORY.md" }),
    );

    const read = await callTool(handler, "readMemory", {});
    expect((runtime.ctoMemoryService as any).getSnapshot).toHaveBeenCalled();
    expect(read.structuredContent).toEqual(
      expect.objectContaining({ success: true, memory: expect.stringContaining("a fact") }),
    );
  });

  it("creates a work chat for cto callers and returns a work navigation suggestion", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "spawnChat", {
      laneId: "lane-1",
      title: "Fresh work chat",
      openInUi: true,
    });

    expect((runtime.agentChatService as any).createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        sessionProfile: "workflow",
        surface: "work",
        provider: "codex",
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        sessionId: "chat-new",
        navigation: expect.objectContaining({
          surface: "work",
          sessionId: "chat-new",
        }),
      }),
    );
  });

  it("returns the Linear quick view for cto callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "getLinearQuickView", {});

    expect((runtime.linearIssueTracker as any).getConnectionStatus).toHaveBeenCalled();
    expect((runtime.linearIssueTracker as any).getQuickView).toHaveBeenCalledWith(
      expect.objectContaining({
        connected: true,
        tokenStored: true,
        viewerId: "user-1",
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        organization: expect.objectContaining({ name: "ADE" }),
        sdk: expect.objectContaining({ packageName: "@linear/sdk" }),
      }),
    );
  });

  it("returns the Linear issue picker data for cto callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "getLinearIssuePickerData", {});

    expect((runtime.linearIssueTracker as any).listProjects).toHaveBeenCalled();
    expect((runtime.linearIssueTracker as any).listUsers).toHaveBeenCalled();
    expect((runtime.linearIssueTracker as any).listWorkflowStates).toHaveBeenCalled();
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        projects: expect.any(Array),
        users: expect.any(Array),
        states: expect.any(Array),
      }),
    );
  });

  it("forwards search filters when calling searchLinearIssues", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "searchLinearIssues", {
      projectId: "proj-1",
      stateTypes: ["started", "unstarted"],
      query: "auth",
      first: 25,
      includeArchived: true,
    });

    expect((runtime.linearIssueTracker as any).searchIssues).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-1",
        stateTypes: ["started", "unstarted"],
        query: "auth",
        first: 25,
        includeArchived: true,
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        issues: expect.any(Array),
        pageInfo: expect.objectContaining({ hasNextPage: false }),
      }),
    );
  });

  it("fetches Linear issue comments via getLinearIssueComments", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "getLinearIssueComments", {
      issueId: "issue-1",
    });

    expect((runtime.linearIssueTracker as any).fetchIssueComments).toHaveBeenCalledWith("issue-1");
    expect(result.structuredContent).toEqual([
      expect.objectContaining({ id: "comment-1", body: "First comment" }),
    ]);
  });

  it("returns structured local computer-use capability state", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "coord-1", role: "orchestrator" });
    const response = await callTool(handler, "get_environment_info", {});

    expect(response.isError).toBeUndefined();
    expect(response.structuredContent.platform).toBeTypeOf("string");
    expect(response.structuredContent.capabilities).toBeTruthy();
    expect(response.structuredContent.capabilities.proofRequirements).toBeTruthy();
  });

  it("auto-links computer-use ingestion to standalone chat sessions", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "chat-session-1",
      role: "agent",
    });

    await callTool(handler, "ingest_computer_use_artifacts", {
      backendStyle: "external_cli",
      backendName: "agent-browser",
      inputs: [
        {
          kind: "screenshot",
          title: "Chat proof",
          path: "/tmp/chat-proof.png",
        },
      ],
    });

    expect(runtime.computerUseArtifactBrokerService.ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: expect.objectContaining({
          name: "agent-browser",
          style: "external_cli",
        }),
        owners: expect.arrayContaining([
          expect.objectContaining({
            kind: "chat_session",
            id: "chat-session-1",
          }),
        ]),
      }),
    );
  });

  it("rejects computer-use manifests outside the project root", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    const outsideManifest = path.join(path.dirname(fixture.runtime.projectRoot), `ade-artifacts-${Date.now()}.json`);
    fs.writeFileSync(outsideManifest, JSON.stringify([{ kind: "screenshot", path: "/tmp/shot.png" }]), "utf8");

    try {
      await initialize(handler, { callerId: "chat-session-1", role: "agent" });
      const response = await callTool(handler, "ingest_computer_use_artifacts", {
        backendStyle: "external_cli",
        backendName: "agent-browser",
        manifestPath: `../${path.basename(outsideManifest)}`,
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("project root");
      expect(fixture.runtime.computerUseArtifactBrokerService.ingest).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(outsideManifest, { force: true });
    }
  });



  it("rejects standalone chat calls to ADE spawn_agent", async () => {
    await withEnv({ ADE_DEFAULT_ROLE: "agent", ADE_CHAT_SESSION_ID: "chat-1" }, async () => {
      const { runtime } = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "chat-1", role: "agent" });

      const response = await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        prompt: "Handle a child task.",
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("Unsupported tool: spawn_agent");
    });
  });








  it("does not advertise resources to orchestrator callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    process.env.ADE_DEFAULT_ROLE = "orchestrator";
    try {
      const response = await handler({
        jsonrpc: "2.0",
        id: 99,
        method: "ade/initialize",
        params: { identity: { callerId: "coord-1", role: "orchestrator" } }
      }) as any;

      expect(response.capabilities?.actions).toEqual({ listChanged: true });
      expect(response.capabilities?.resources).toBeUndefined();
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });




  it("routes spawn_agent to lane-scoped tracked pty sessions", async () => {
    const fixture = createRuntime();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-bin-"));
    const claudePath = createFakePathExecutable(binDir, "claude");
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SHELL: "/bin/sh" }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        prompt: "Implement API wiring",
        title: "Orchestrator Spawn"
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        cols: 120,
        rows: 36,
        tracked: true,
        toolType: "claude-orchestrated",
        command: claudePath,
        args: expect.arrayContaining(["--model", "claude-sonnet-5", "--permission-mode", "default"]),
        env: expect.objectContaining({
          ADE_DEFAULT_ROLE: "agent",
        }),
      })
    );
    // The final arg concatenates ADE_CLI_INLINE_GUIDANCE with the user prompt; assert
    // it ends with the user prompt and carries the inline guidance preamble.
    const createCall = (fixture.runtime.ptyService.create as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { args: string[] };
    const finalArg = createCall.args[createCall.args.length - 1];
    expect(finalArg).toContain("control plane for ADE state");
    expect(finalArg).toContain("proof & screenshots");
    expect(finalArg).toContain("clean up processes you start");
    expect(finalArg.endsWith("Implement API wiring")).toBe(true);
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("--model");
    expect(response.structuredContent.startupCommand).toContain("--permission-mode");
    expect(response.structuredContent.startupCommand).toContain("control plane for ADE state");
    expect(response.structuredContent.permissionMode).toBe("default");
    expect(response.structuredContent.contextRef?.path).toBeNull();
  });

  it("launches default Codex spawn_agent sessions with supported sandbox flags", async () => {
    const fixture = createRuntime();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-codex-bin-"));
    createFakePathExecutable(binDir, "codex");
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SHELL: "/bin/sh" }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "codex",
        permissionMode: "default",
        prompt: "Check the Codex launch flags",
      });
    });

    expect(response?.isError).toBeUndefined();
    const createCall = fixture.runtime.ptyService.create.mock.calls[0]?.[0] as { args?: string[]; startupCommand?: string };
    expect(createCall.args).toEqual(expect.arrayContaining(["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]));
    expect(createCall.args).not.toContain("--full-auto");
    expect(createCall.startupCommand).toContain("--sandbox workspace-write --ask-for-approval on-request");
    expect(createCall.startupCommand).not.toContain("--full-auto");
  });

  it("routes start_cli_session through shared provider launch helpers", async () => {
    const fixture = createRuntime();
    fixture.runtime.sessionService.get.mockReturnValue({
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      tracked: true,
      toolType: "codex",
      title: "Codex",
      status: "running",
      resumeCommand: null,
      resumeMetadata: null,
    });
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "codex",
      permissionMode: "edit",
      initialInput: "fix failing tests",
      modelId: "openai/gpt-5.5",
      reasoningEffort: "xhigh",
      fastMode: false,
      cols: 90,
      rows: 24,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        title: "Fix failing tests",
        toolType: "codex",
        cols: 90,
        rows: 24,
        command: "codex",
        startupCommand: expect.stringContaining("codex --no-alt-screen"),
        env: expect.objectContaining({
          ADE_AGENT_SKILLS_DIRS: expect.stringContaining(path.join("lane-1", "apps", "desktop", "resources", "agent-skills")),
        }),
      }),
    );
    const createCall = fixture.runtime.ptyService.create.mock.calls.at(-1)?.[0];
    expect(createCall?.args).toEqual(expect.arrayContaining(["--model", "gpt-5.5", "-c", "model_reasoning_effort=\"xhigh\"", "-c", "service_tier=\"default\""]));
    expect(createCall?.args).not.toContain(expect.stringContaining("fix failing tests"));
    expect(createCall?.initialInput).toContain("fix failing tests");
    expect(createCall?.initialInputDelayMs).toBe(750);
    expect(fixture.runtime.ptyService.writeBySessionId).not.toHaveBeenCalled();
    expect(fixture.runtime.sessionService.updateMeta).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      goal: "fix failing tests",
      title: "Fix failing tests",
    }));
    expect(response.structuredContent).toMatchObject({
      provider: "codex",
      laneId: "lane-1",
      ptyId: "pty-1",
      sessionId: "session-1",
      initialInputWritten: true,
    });
  });

  it("preserves wide start_cli_session terminal dimensions", async () => {
    const fixture = createRuntime();
    fixture.runtime.sessionService.get.mockReturnValue({
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      tracked: true,
      toolType: "codex",
      title: "Codex",
      status: "running",
      resumeCommand: null,
      resumeMetadata: null,
    });
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "codex",
      cols: 999,
      rows: 999,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        cols: 400,
        rows: 200,
        startupCommand: expect.stringContaining("codex --no-alt-screen"),
      }),
    );
    const createCall = fixture.runtime.ptyService.create.mock.calls.at(-1)?.[0];
    expect(createCall?.args).toEqual(expect.arrayContaining([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ]));
    expect(response.structuredContent.startupCommand).not.toContain("--full-auto");
  });

  it("starts shell CLI sessions without reading user shell startup files", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ SHELL: "/bin/zsh" }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "start_cli_session", {
        laneId: "lane-1",
        provider: "shell",
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        title: "Shell",
        toolType: "shell",
        command: "/bin/zsh",
        args: ["-f"],
        env: { ZDOTDIR: "/var/empty" },
      }),
    );
  });

  it("starts Codex spawn_agent with current default permission flags", async () => {
    const fixture = createRuntime();
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-bin-"));
    createFakePathExecutable(binDir, "codex");
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SHELL: "/bin/sh" }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "codex",
        prompt: "Check the mobile CLI path",
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.stringMatching(/codex$/),
        args: expect.arrayContaining(["--sandbox", "workspace-write", "--ask-for-approval", "on-request"]),
        startupCommand: expect.stringContaining("codex --sandbox workspace-write --ask-for-approval on-request"),
      }),
    );
    expect(response.structuredContent.startupCommand).not.toContain("--full-auto");
  });

  it("passes selected models to fresh Claude Code terminal launches", async () => {
    const fixture = createRuntime();
    fixture.runtime.sessionService.get.mockReturnValue({
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      tracked: true,
      toolType: "claude",
      title: "Claude Code",
      status: "running",
      resumeCommand: null,
      resumeMetadata: null,
    });
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "claude",
      permissionMode: "default",
      model: "anthropic/claude-opus-4-8",
      cols: 90,
      rows: 24,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        title: "Claude Code",
        toolType: "claude",
        startupCommand: expect.stringContaining("--model"),
      }),
    );
    const createCall = fixture.runtime.ptyService.create.mock.calls[0]?.[0] as { args?: string[]; startupCommand?: string };
    expect(createCall.args).toEqual(expect.arrayContaining(["--model", "claude-opus-4-8"]));
    expect(createCall.startupCommand).toContain("claude-opus-4-8");
    expect(response.structuredContent.model).toBe("anthropic/claude-opus-4-8");
  });

  it("passes Claude auto permission mode to fresh Claude Code terminal launches", async () => {
    const fixture = createRuntime();
    fixture.runtime.sessionService.get.mockReturnValue({
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      tracked: true,
      toolType: "claude",
      title: "Claude Code",
      status: "running",
      resumeCommand: null,
      resumeMetadata: null,
    });
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "claude",
      permissionMode: "auto",
    });

    expect(response?.isError).toBeUndefined();
    const createCall = fixture.runtime.ptyService.create.mock.calls[0]?.[0] as { args?: string[]; startupCommand?: string };
    expect(createCall.args).toEqual(expect.arrayContaining(["--permission-mode", "auto"]));
    expect(createCall.startupCommand).toContain("--permission-mode auto");
    expect(response.structuredContent.permissionMode).toBe("auto");
  });

  it("embeds Claude Code initial input in the launch command", async () => {
    const fixture = createRuntime();
    fixture.runtime.sessionService.get.mockReturnValue({
      id: "session-1",
      laneId: "lane-1",
      ptyId: "pty-1",
      tracked: true,
      toolType: "claude",
      title: "Claude Code",
      status: "running",
      resumeCommand: null,
      resumeMetadata: null,
    });
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "claude",
      permissionMode: "default",
      initialInput: "hello?",
    });

    expect(response?.isError).toBeUndefined();
    const createCall = fixture.runtime.ptyService.create.mock.calls.at(-1)?.[0];
    expect(createCall?.args?.at(-1)).toContain("hello?");
    expect(createCall?.startupCommand).toContain("hello?");
    expect(fixture.runtime.ptyService.writeBySessionId).not.toHaveBeenCalled();
  });

  it("submits Cursor initial input after the interactive CLI is ready", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "cursor",
      initialInput: "fix failing tests",
    });

    expect(response?.isError).toBeUndefined();
    const createCall = fixture.runtime.ptyService.create.mock.calls.at(-1)?.[0];
    expect(createCall?.command).toBe("cursor-agent");
    expect(createCall?.args).toEqual(expect.arrayContaining(["--model", "auto"]));
    expect(createCall?.args).not.toContain(expect.stringContaining("fix failing tests"));
    expect(createCall?.startupCommand).toContain("cursor-agent");
    expect(createCall?.startupCommand).not.toContain("fix failing tests");
    expect(createCall?.startupCommand).not.toContain("create-chat");
    expect(createCall?.startupCommand).not.toContain("--resume");
    expect(createCall?.initialInput).toContain("ADE session guidance");
    expect(createCall?.initialInput).toContain("fix failing tests");
    expect(createCall?.initialInputDelayMs).toBe(750);
    expect(fixture.runtime.ptyService.writeBySessionId).not.toHaveBeenCalled();
    expect(fixture.runtime.ptyService.dispose).not.toHaveBeenCalled();
  });

  it("preassigns Claude session ids for start_cli_session launches", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "claude",
      permissionMode: "default",
    });

    expect(response?.isError).toBeUndefined();
    const createCall = fixture.runtime.ptyService.create.mock.calls.at(-1)?.[0];
    expect(createCall.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(createCall.allowNewSessionId).toBe(true);
    expect(createCall.startupCommand).toContain("--session-id");
    expect(createCall.startupCommand).toContain(createCall.sessionId);
    expect(createCall.toolType).toBe("claude");
  });

  it("sends to an existing CLI session through the durable session continuation path", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "send_to_session", {
      sessionId: "session-existing",
      text: "continue here",
      cols: 999,
      rows: 999,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.sendToSession).toHaveBeenCalledWith({
      sessionId: "session-existing",
      text: "continue here",
      cols: 400,
      rows: 200,
    });
  });

  it("exposes pty.resumeSession through the service-backed action catalog", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "list_ade_actions", { domain: "pty" });

    expect(response?.isError).toBeUndefined();
    const names = (response.actions ?? []).map((action: { name: string }) => action.name);
    expect(names).toContain("pty.resumeSession");
  });

  it("rejects invalid start_cli_session permission modes", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "codex",
      permissionMode: "surprise-me",
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "permissionMode must be one of default, auto, plan, edit, full-auto, or config-toml",
    );
    expect(fixture.runtime.ptyService.create).not.toHaveBeenCalled();
  });

  it("rejects unsupported start_cli_session permission/provider combinations", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "start_cli_session", {
      laneId: "lane-1",
      provider: "claude",
      permissionMode: "config-toml",
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("config-toml is only supported for Codex");
    expect(fixture.runtime.ptyService.create).not.toHaveBeenCalled();
  });

  it("starts spawn_agent without writing an attached ADE server config", async () => {
    const fixture = createRuntime();
    fixture.runtime.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-workspace-"));
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-bin-"));
    const claudePath = createFakePathExecutable(binDir, "claude");
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`, SHELL: "/bin/sh" }, async () => {
      await initialize(handler, { role: "orchestrator", runId: "run-from-identity" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "claude",
        model: "claude-sonnet-5",
        prompt: "Implement API wiring",
        title: "Orchestrator Spawn",
        runId: "run-1",
        attemptId: "attempt-workspace-roots"
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("ADE_RUN_ID=run-1");
    expect(response.structuredContent.startupCommand).toContain("ADE_ATTEMPT_ID=attempt-workspace-roots");
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        command: claudePath,
        env: expect.objectContaining({
          ADE_RUN_ID: "run-1",
          ADE_ATTEMPT_ID: "attempt-workspace-roots",
          ADE_DEFAULT_ROLE: "agent",
        }),
      })
    );
  });

  it("keeps spawn_agent on shell startup when the provider executable cannot be resolved", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-empty-path-")), SHELL: "/bin/sh" }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "claude",
        prompt: "Implement API wiring",
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        command: expect.any(String),
      })
    );
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        startupCommand: expect.stringContaining("claude"),
      })
    );
  });

  it("does not use POSIX env assignment in unresolved Windows spawn_agent startup commands", async () => {
    setPlatform("win32");
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    const response = await withEnv({ PATH: fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-empty-win-path-")) }, async () => {
      await initialize(handler, { role: "orchestrator" });
      return await callTool(handler, "spawn_agent", {
        laneId: "lane-1",
        provider: "claude",
        prompt: "Implement API wiring",
        runId: "run-1",
        attemptId: "attempt-win-fallback",
      });
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).not.toContain("ADE_RUN_ID=run-1");
    expect(response.structuredContent.startupCommand).not.toContain("ADE_ATTEMPT_ID=attempt-win-fallback");
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          ADE_RUN_ID: "run-1",
          ADE_ATTEMPT_ID: "attempt-win-fallback",
          ADE_DEFAULT_ROLE: "agent",
        }),
        startupCommand: response.structuredContent.startupCommand,
      })
    );
  });

  it("rejects config-toml permission mode for Claude spawn_agent sessions", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      permissionMode: "config-toml",
      prompt: "Implement API wiring",
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "config-toml is only supported for Codex",
    );
    expect(fixture.runtime.ptyService.create).not.toHaveBeenCalled();
  });

  it("fails closed when a requested lane does not have an available worktree", async () => {
    const fixture = createRuntime();
    fixture.runtime.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-workspace-"));
    fixture.runtime.laneService.getLaneWorktreePath = vi.fn(() => null);
    fixture.runtime.laneService.getLaneBaseAndBranch = vi.fn(() => null);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-5",
      prompt: "Implement API wiring",
      title: "Orchestrator Spawn",
      runId: "run-1",
      attemptId: "attempt-1",
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "does not have an available worktree",
    );
    expect(fixture.runtime.ptyService.create).not.toHaveBeenCalled();
  });










  it("materializes compact context manifests for spawn_agent to keep prompts lightweight", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "codex",
      permissionMode: "plan",
      runId: "run-123",
      stepId: "step-abc",
      attemptId: "attempt-xyz",
      prompt: "Investigate failing CI and propose a fix plan before editing.",
      context: {
        profile: "orchestrator_deterministic_v1",
        docs: [{ path: "docs/PRD.md", sha256: "abc", bytes: 1024 }],
        handoffDigest: { summarizedCount: 4, byType: { attempt_succeeded: 3, attempt_failed: 1 } }
      }
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.permissionMode).toBe("plan");
    expect(response.structuredContent.startupCommand).toContain("--sandbox");
    expect(response.structuredContent.startupCommand).toContain("read-only");
    expect(response.structuredContent.startupCommand).toContain("control plane for ADE state");
    const contextPath = response.structuredContent.contextRef?.path as string | null;
    expect(contextPath).toBeTruthy();
    expect(contextPath?.includes("/.ade/cache/orchestrator/agent-context/run-123/")).toBe(true);
    if (!contextPath) {
      throw new Error("Expected context manifest path");
    }
    expect(fs.existsSync(contextPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    expect(manifest.schema).toBe("ade.agent.spawnContext.v1");
    expect(manifest.runContext.runId).toBe("run-123");
  });

  it("routes run_tests for suite and ad-hoc command contracts", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });

    const suiteResult = await callTool(handler, "run_tests", {
      laneId: "lane-1",
      suiteId: "unit",
      waitForCompletion: false
    });
    expect(suiteResult?.isError).toBeUndefined();
    expect(suiteResult?.structuredContent?.run?.id).toBe("test-run-1");

    const commandResult = await callTool(handler, "run_tests", {
      laneId: "lane-1",
      command: "npm test",
      waitForCompletion: false
    });
    expect(commandResult?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        cols: 120,
        rows: 36,
        startupCommand: "npm test"
      })
    );
    expect(commandResult.structuredContent.mode).toBe("command");
  });


  it("returns explicit declined semantics for standalone ask_user with structured questions", async () => {
    await withEnv({ ADE_CHAT_SESSION_ID: "chat-session-env" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.agentChatService.requestChatInput = vi.fn(async () => ({
        decision: "decline",
        answers: {},
        responseText: null,
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "chat-session-identity",
        role: "agent",
        chatSessionId: "chat-session-identity",
      });
      const response = await callTool(handler, "ask_user", {
        title: "Pick a flow",
        body: "Which part should we test first? 1. Question flow 2. Plan updates",
        questions: [
          {
            id: "flow",
            header: "Choose one",
            question: "Which part should we test first?",
            options: [
              { label: "Question flow", value: "question_flow" },
              { label: "Plan updates", value: "plan_updates" },
            ],
          },
        ],
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.agentChatService.requestChatInput).toHaveBeenCalledWith(expect.objectContaining({
        chatSessionId: "chat-session-env",
        questions: [
          expect.objectContaining({
            id: "flow",
            question: "Which part should we test first?",
            options: [
              expect.objectContaining({ label: "Question flow", value: "question_flow" }),
              expect.objectContaining({ label: "Plan updates", value: "plan_updates" }),
            ],
          }),
        ],
      }));
      expect(response.structuredContent.outcome).toBe("declined");
      expect(response.structuredContent.answered).toBe(false);
      expect(response.structuredContent.declined).toBe(true);
      expect(response.structuredContent.cancelled).toBe(false);
      expect(response.structuredContent.timedOut).toBe(false);
      expect(response.structuredContent.awaitingUserResponse).toBe(false);
      expect(response.structuredContent.blocking).toBe(false);
      expect(response.structuredContent.responseText).toContain("declined");
    });
  });

  it("uses initialized chat session identity when the server process has no ADE_CHAT_SESSION_ID", async () => {
    await withEnv({ ADE_CHAT_SESSION_ID: undefined, ADE_DEFAULT_ROLE: "agent" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.agentChatService.requestChatInput = vi.fn(async () => ({
        decision: "decline",
        answers: {},
        responseText: null,
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "chat-session-identity",
        role: "agent",
        chatSessionId: "chat-session-identity",
      });
      const response = await callTool(handler, "ask_user", {
        title: "Pick a flow",
        body: "Which part should we test first?",
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.agentChatService.requestChatInput).toHaveBeenCalledWith(expect.objectContaining({
        chatSessionId: "chat-session-identity",
      }));
    });
  });

  it("returns explicit timed_out semantics for standalone ask_user when the user does not answer in time", async () => {
    await withEnv({ ADE_CHAT_SESSION_ID: "chat-session-env" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.agentChatService.requestChatInput = vi.fn(() => new Promise(() => {}));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "chat-session-identity",
        role: "agent",
        chatSessionId: "chat-session-identity",
      });
      const response = await callTool(handler, "ask_user", {
        title: "Pick a flow",
        body: "Which part should we test first? 1. Question flow 2. Plan updates",
        waitForResolutionMs: 10,
      });

      expect(response?.isError).toBeUndefined();
      expect(response.structuredContent.outcome).toBe("timed_out");
      expect(response.structuredContent.decision).toBe("timeout");
      expect(response.structuredContent.answered).toBe(false);
      expect(response.structuredContent.timedOut).toBe(true);
      expect(response.structuredContent.awaitingUserResponse).toBe(true);
      expect(response.structuredContent.blocking).toBe(true);
      expect(response.structuredContent.responseText).toContain("timed out");
    });
  });



  it("allows mutations for any session", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });

    const response = await callTool(handler, "commit_changes", {
      laneId: "lane-1",
      message: "commit message"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.stageAll).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.gitService.commit).toHaveBeenCalledTimes(1);
    expect(fixture.runtime.gitService.generateCommitMessage).not.toHaveBeenCalled();
    expect(response.structuredContent.commit.sha).toBe("abc123");
    expect(response.structuredContent.messageSource).toBe("provided");
  });

  it("generates a commit message when commit_changes message is omitted", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "commit_changes", {
      laneId: "lane-1",
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.generateCommitMessage).toHaveBeenCalledWith({
      laneId: "lane-1",
      amend: false,
    });
    expect(fixture.runtime.gitService.commit).toHaveBeenCalledWith({
      laneId: "lane-1",
      amend: false,
      message: "generated commit message",
    });
    expect(response.structuredContent.messageSource).toBe("generated");
    expect(response.structuredContent.generatedByModel).toBe("gpt-5-mini");
  });

  it("returns generated commit text without creating a commit", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "generate_commit_message", {
      laneId: "lane-1",
      amend: true,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.generateCommitMessage).toHaveBeenCalledWith({
      laneId: "lane-1",
      amend: true,
    });
    expect(fixture.runtime.gitService.commit).not.toHaveBeenCalled();
    expect(response.structuredContent.message).toBe("generated commit message");
  });

  it("lists and imports unregistered lane worktrees", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const listResponse = await callTool(handler, "list_unregistered_lanes", {});
    expect(listResponse?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.listUnregisteredWorktrees).toHaveBeenCalledTimes(1);
    expect(listResponse.structuredContent.worktrees[0].branch).toBe("feature/untracked");

    const importResponse = await callTool(handler, "import_lane", {
      branchRef: "feature/untracked",
      name: "Imported lane",
      baseBranch: "main",
    });
    expect(importResponse?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.importBranch).toHaveBeenCalledWith({
      branchRef: "feature/untracked",
      name: "Imported lane",
      baseBranch: "main",
    });
    expect(importResponse.structuredContent.lane.id).toBe("lane-imported");
  });

  it("supports core git sync operations via ADE RPC", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const syncStatus = await callTool(handler, "git_get_sync_status", { laneId: "lane-1" });
    expect(syncStatus?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.getSyncStatus).toHaveBeenCalledWith({ laneId: "lane-1" });

    const pull = await callTool(handler, "git_pull", { laneId: "lane-1", mode: "merge" });
    expect(pull?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.pull).toHaveBeenCalledWith({ laneId: "lane-1", mode: "merge" });

    const push = await callTool(handler, "git_push", { laneId: "lane-1", force: true, setUpstream: false });
    expect(push?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.push).toHaveBeenCalledWith({ laneId: "lane-1", forceWithLease: true });

    const undo = await callTool(handler, "git_undo_last_head_change", { laneId: "lane-1" });
    expect(undo?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.undoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });

    const redo = await callTool(handler, "git_redo_last_head_change", { laneId: "lane-1" });
    expect(redo?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.redoLastHeadChange).toHaveBeenCalledWith({ laneId: "lane-1" });
  });

  it("supports create/update/comment PR actions via ADE RPC", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const created = await callTool(handler, "create_pr_from_lane", {
      laneId: "lane-1",
      baseBranch: "main",
      title: "My PR",
      body: "Body text",
      draft: true,
      closeLinearIssueOnMerge: true,
    });
    expect(created?.isError).toBeUndefined();
    expect(created?.structuredContent).toMatchObject({
      githubUrl: "https://github.com/acme/ade/pull/42",
      adeUrl: "https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42",
    });
    expect(fixture.runtime.prService.createFromLane).toHaveBeenCalledWith({
      laneId: "lane-1",
      baseBranch: "main",
      title: "My PR",
      body: "Body text",
      draft: true,
      closeLinearIssueOnMerge: true,
    });

    const defaulted = await callTool(handler, "create_pr_from_lane", {
      laneId: "lane-1",
      baseBranch: "main",
    });
    expect(defaulted?.isError).toBeUndefined();
    expect(fixture.runtime.prService.draftDescription).not.toHaveBeenCalled();
    expect(fixture.runtime.prService.createFromLane).toHaveBeenLastCalledWith({
      laneId: "lane-1",
      baseBranch: "main",
      title: "Lane 1 -> main",
      body: "",
      draft: false,
      closeLinearIssueOnMerge: true,
    });

    (fixture.runtime.laneService.list as any).mockResolvedValueOnce([
      {
        id: "primary",
        name: "Primary",
        laneType: "primary",
        parentLaneId: null,
        baseRef: "main",
        branchRef: "main",
        archivedAt: null,
      },
      {
        id: "parent-lane",
        name: "Parent",
        laneType: "worktree",
        parentLaneId: null,
        baseRef: "main",
        branchRef: "feature/parent",
        archivedAt: null,
      },
      {
        id: "child-lane",
        name: "Child",
        laneType: "worktree",
        parentLaneId: "parent-lane",
        baseRef: "main",
        branchRef: "feature/child",
        archivedAt: null,
      },
    ]);
    const stackedDefaulted = await callTool(handler, "create_pr_from_lane", {
      laneId: "child-lane",
    });
    expect(stackedDefaulted?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createFromLane).toHaveBeenLastCalledWith({
      laneId: "child-lane",
      title: "Child -> Parent",
      body: "",
      draft: false,
      closeLinearIssueOnMerge: true,
    });

    const updateTitle = await callTool(handler, "pr_update_title", { prId: "pr-1", title: "Renamed" });
    expect(updateTitle?.isError).toBeUndefined();
    expect(fixture.runtime.prService.updateTitle).toHaveBeenCalledWith({ prId: "pr-1", title: "Renamed" });

    const comment = await callTool(handler, "pr_add_comment", { prId: "pr-1", body: "Looks good" });
    expect(comment?.isError).toBeUndefined();
    expect(fixture.runtime.prService.addComment).toHaveBeenCalledWith({ prId: "pr-1", body: "Looks good" });
  });

  it("synthesizes PR browser links from repo metadata when RPC PR creation omits githubUrl", async () => {
    const fixture = createRuntime();
    fixture.runtime.prService.createFromLane = vi.fn(async () => ({
      id: "pr-new",
      laneId: "lane-1",
      repoOwner: "acme",
      repoName: "ade",
      githubPrNumber: 42,
      title: "New PR",
      status: "open",
    })) as any;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const created = await callTool(handler, "create_pr_from_lane", {
      laneId: "lane-1",
      baseBranch: "main",
      title: "My PR",
      body: "Body text",
      draft: true,
      closeLinearIssueOnMerge: true,
    });

    expect(created?.isError).toBeUndefined();
    expect(created?.structuredContent).toMatchObject({
      githubUrl: "https://github.com/acme/ade/pull/42",
      adeUrl: "https://ade-app.dev/open?type=pr&repo=acme%2Fade&number=42",
    });
  });

  it("lists ADE actions across runtime domains", async () => {
    const fixture = createRuntime();
    const crossMachineActions = [
      "prepareCrossMachineHandoff",
      "validateCrossMachineSource",
      "preflightCrossMachineDestination",
      "acceptCrossMachineHandoff",
      "markCrossMachineHandoff",
    ] as const;
    for (const action of crossMachineActions) {
      (fixture.runtime.agentChatService as any)[action] = vi.fn(async (args: unknown) => ({ action, args }));
    }
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "list_ade_actions", { domain: "git" });
    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.actions.some((entry: { action: string }) => entry.action === "push")).toBe(true);
    expect(response.structuredContent.actions.some((entry: { action: string }) => entry.action === "commit")).toBe(true);
    expect(response.structuredContent.actions.some((entry: { action: string }) => entry.action === "stageFile")).toBe(true);
    expect(response.structuredContent.actions.every((entry: { name?: string; usage?: string }) => entry.name && entry.usage)).toBe(true);

    const chatActions = await callTool(handler, "list_ade_actions", { domain: "chat" });
    expect(chatActions?.isError).toBeUndefined();
    const createSession = chatActions.structuredContent.actions.find((entry: { action: string }) => entry.action === "createSession");
    expect(createSession).toMatchObject({
      input: expect.stringContaining("reasoningEffort"),
      example: expect.stringContaining("chat.createSession"),
    });
    const getSessionSummary = chatActions.structuredContent.actions.find((entry: { action: string }) => entry.action === "getSessionSummary");
    expect(getSessionSummary).toMatchObject({
      input: expect.stringContaining("scalar sessionId"),
    });
    const listedChatActionNames = chatActions.structuredContent.actions.map((entry: { name: string }) => entry.name);
    expect(listedChatActionNames).toEqual(expect.arrayContaining(
      crossMachineActions.map((action) => `chat.${action}`),
    ));

    const prepared = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "prepareCrossMachineHandoff",
      args: {
        sourceSessionId: "chat-1",
        handoffId: "handoff-1",
        targetModelId: "openai/gpt-5.5",
      },
    });
    expect(prepared?.isError).toBeUndefined();
    expect(prepared.structuredContent.result).toEqual({
      action: "prepareCrossMachineHandoff",
      args: {
        sourceSessionId: "chat-1",
        handoffId: "handoff-1",
        targetModelId: "openai/gpt-5.5",
      },
    });

    const usageActions = await callTool(handler, "list_ade_actions", { domain: "usage" });
    expect(usageActions?.isError).toBeUndefined();
    expect(usageActions.structuredContent.actions).toContainEqual(
      expect.objectContaining({ domain: "usage", action: "getAdeUsageStats", name: "usage.getAdeUsageStats" }),
    );
    expect(usageActions.structuredContent.actions).toContainEqual(
      expect.objectContaining({ domain: "usage", action: "noteQuotaDemand", name: "usage.noteQuotaDemand" }),
    );
    expect(usageActions.structuredContent.actions).not.toContainEqual(
      expect.objectContaining({ domain: "usage", action: "refreshHistory" }),
    );

    const allDomains = await callTool(handler, "list_ade_actions", { domain: "all" });
    expect(allDomains?.isError).toBeUndefined();
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "ai")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "orchestrator")).toBe(false);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "orchestrator_core")).toBe(false);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "cto_state")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "worker_agent")).toBe(false);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "computer_use_artifacts")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "operation")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "keybindings")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "onboarding")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "automation_planner")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "github")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "usage")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "update")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "layout")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "tiling_tree")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "graph_state")).toBe(true);
  });

  it("invokes ADE actions dynamically and returns status hints", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "git",
      action: "push",
      args: { laneId: "lane-1", force: true, setUpstream: false },
    });
    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.push).toHaveBeenCalledWith({ laneId: "lane-1", force: true, setUpstream: false });
    expect(response.structuredContent.domain).toBe("git");
    expect(response.structuredContent.action).toBe("push");

    const variadic = await callTool(handler, "run_ade_action", {
      domain: "operation",
      action: "list",
      argsList: [{ limit: 10 }],
    });
    expect(variadic?.isError).toBeUndefined();
    expect(fixture.runtime.operationService.list).toHaveBeenCalledWith({ limit: 10 });

    const keybindings = await callTool(handler, "run_ade_action", {
      domain: "keybindings",
      action: "get",
      args: {},
    });
    expect(keybindings?.isError).toBeUndefined();
    expect(fixture.runtime.keybindingsService.get).toHaveBeenCalled();

    (fixture.runtime.agentChatService as any).getAvailableModels = vi.fn(async ({ provider }: { provider?: string }) => [
      { id: provider ?? "all" },
    ]);
    const availableModels = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "getAvailableModels",
      args: {},
    });
    expect(availableModels?.isError).toBeUndefined();
    expect((fixture.runtime.agentChatService as any).getAvailableModels).toHaveBeenCalledWith({});

    const chatSummary = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "getSessionSummary",
      args: { sessionId: " chat-1 " },
    });
    expect(chatSummary?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.getSessionSummary).toHaveBeenCalledWith("chat-1");

    const aiStatus = await callTool(handler, "run_ade_action", {
      domain: "ai",
      action: "getStatus",
      args: { refreshOpenCodeInventory: true },
    });
    expect(aiStatus?.isError).toBeUndefined();
    expect(fixture.runtime.aiIntegrationService.getStatus).toHaveBeenCalledWith({
      force: false,
      refreshOpenCodeInventory: true,
    });
    expect(aiStatus.structuredContent.result.availableModelIds).toContain("openai/gpt-5.5");

    const layoutSet = await callTool(handler, "run_ade_action", {
      domain: "layout",
      action: "set",
      args: { layoutId: "main", layout: { left: 120, right: -5, ignored: "wide" } },
    });
    expect(layoutSet?.isError).toBeUndefined();
    expect(fixture.runtime.db.setJson).toHaveBeenCalledWith("dock_layout:main", { left: 100, right: 0 });

    const layoutGet = await callTool(handler, "run_ade_action", {
      domain: "layout",
      action: "get",
      args: { layoutId: "main" },
    });
    expect(layoutGet?.isError).toBeUndefined();
    expect(layoutGet.structuredContent.result).toEqual({ left: 100, right: 0 });

    const delta = await callTool(handler, "run_ade_action", {
      domain: "session",
      action: "getDelta",
      args: { sessionId: "session-1" },
    });
    expect(delta?.isError).toBeUndefined();
    expect(fixture.runtime.sessionDeltaService.getSessionDelta).toHaveBeenCalledWith("session-1");
    expect(delta.structuredContent.result).toEqual({ sessionId: "session-1", filesChanged: 2 });

    const preview = await callTool(handler, "run_ade_action", {
      domain: "computer_use_artifacts",
      action: "readArtifactPreview",
      args: { uri: ".ade/artifacts/proof.png" },
    });
    expect(preview?.isError).toBeUndefined();
    expect(fixture.runtime.computerUseArtifactBrokerService.readArtifactPreview).toHaveBeenCalledWith({
      uri: ".ade/artifacts/proof.png",
    });
    expect(preview.structuredContent.result).toBe("data:image/png;base64,AAAA");

    const usageStats = await callTool(handler, "run_ade_action", {
      domain: "usage",
      action: "getAdeUsageStats",
      args: { preset: "7d" },
    });
    expect(usageStats?.isError).toBeUndefined();
    expect(fixture.runtime.usageTrackingService.getAdeUsageStats).toHaveBeenCalledWith({ preset: "7d" });
    expect(usageStats.structuredContent.result).toMatchObject({ preset: "7d", daily: [] });

    const quotaDemand = await callTool(handler, "run_ade_action", {
      domain: "usage",
      action: "noteQuotaDemand",
      args: {},
    });
    expect(quotaDemand?.isError).toBeUndefined();
    expect(fixture.runtime.usageTrackingService.noteQuotaDemand).toHaveBeenCalledWith(undefined);
    expect(quotaDemand.structuredContent.result).toEqual({ available: true, entries: [] });

  });

  it("records normalized ADE Code actions without recording terminal keystrokes", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(
      handler,
      { callerId: "ade-code:test", role: "cto" },
      { clientName: "ade-code" },
    );

    await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "delete",
      args: { laneId: "lane-1" },
    });
    await callTool(handler, "run_ade_action", {
      domain: "terminal",
      action: "write",
      args: { terminalId: "session-1", data: "y\n" },
    });

    const usageEventCalls = (fixture.runtime.db.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("insert into usage_events"),
    );
    expect(usageEventCalls).toHaveLength(1);
    expect(usageEventCalls[0]?.[1]).toEqual(expect.arrayContaining(["tui", "lanes.delete", "lane"]));
    expect(fixture.runtime.ptyService.writeTerminal).toHaveBeenCalledWith({
      terminalId: "session-1",
      data: "y\n",
    });
  });

  it("routes Linear attach/detach/list and the issue write-bridge through run_ade_action", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    // Session-scoped attach: issues array keyed by chatSessionId.
    const attach = await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "attachLinearIssueToSession",
      args: { chatSessionId: "session-9", issues: [{ id: "issue-1", identifier: "ENG-431" }] },
    });
    expect(attach?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.attachLinearIssueToSession).toHaveBeenCalledWith({
      chatSessionId: "session-9",
      issues: [{ id: "issue-1", identifier: "ENG-431" }],
    });

    // Detach: chatSessionId + optional issueId.
    const detach = await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "detachLinearIssueFromSession",
      args: { chatSessionId: "session-9", issueId: "ENG-431" },
    });
    expect(detach?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.detachLinearIssueFromSession).toHaveBeenCalledWith({
      chatSessionId: "session-9",
      issueId: "ENG-431",
    });

    // List: object arg.
    const list = await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "listLinearIssuesForSession",
      args: { chatSessionId: "session-9" },
    });
    expect(list?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.listLinearIssuesForSession).toHaveBeenCalledWith({
      chatSessionId: "session-9",
    });
    expect(list.structuredContent.result).toHaveLength(1);

    // Lane-scoped unlink (issueId omitted = remove all non-primary links).
    const unlink = await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "unlinkLinearIssues",
      args: { laneId: "lane-1" },
    });
    expect(unlink?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.unlinkLinearIssues).toHaveBeenCalledWith({ laneId: "lane-1" });

    // Write-bridge: createComment + updateIssueState (positional).
    const comment = await callTool(handler, "run_ade_action", {
      domain: "linear_issue_tracker",
      action: "createComment",
      argsList: ["ENG-431", "All green"],
    });
    expect(comment?.isError).toBeUndefined();
    expect(fixture.runtime.linearIssueTracker.createComment).toHaveBeenCalledWith("ENG-431", "All green");

    const setState = await callTool(handler, "run_ade_action", {
      domain: "linear_issue_tracker",
      action: "updateIssueState",
      argsList: ["ENG-431", "state-done"],
    });
    expect(setState?.isError).toBeUndefined();
    expect(fixture.runtime.linearIssueTracker.updateIssueState).toHaveBeenCalledWith("ENG-431", "state-done");

    const graphql = await callTool(handler, "run_ade_action", {
      domain: "linear_issue_tracker",
      action: "graphql",
      args: { query: "query Viewer { viewer { id } }", variables: { first: 1 } },
    });
    expect(graphql?.isError).toBeUndefined();
    expect(fixture.runtime.linearIssueTracker.runGraphQL).toHaveBeenCalledWith({
      query: "query Viewer { viewer { id } }",
      variables: { first: 1 },
    });
    expect(graphql.structuredContent.result).toMatchObject({ viewer: { id: "user-1" } });
  });

  it("scopes PTY and terminal ADE actions to the caller's lane or chat", async () => {
    const fixture = createRuntime();
    const ownChat = { id: "chat-1", laneId: "lane-1", chatSessionId: "chat-1" };
    const ownTerminal = { id: "terminal-1", laneId: "lane-1", ptyId: "pty-1", chatSessionId: "chat-1" };
    const otherTerminal = { id: "terminal-2", laneId: "lane-2", ptyId: "pty-2", chatSessionId: "chat-2" };
    fixture.runtime.sessionService.get.mockImplementation((sessionId: string) => {
      if (sessionId === "chat-1") return ownChat;
      if (sessionId === "terminal-1") return ownTerminal;
      if (sessionId === "terminal-2") return otherTerminal;
      return null;
    });
    fixture.runtime.ptyService.list.mockReturnValue([ownTerminal, otherTerminal]);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent", chatSessionId: "chat-1" });

    const listed = await callTool(handler, "run_ade_action", {
      domain: "pty",
      action: "list",
      args: {},
    });
    expect(listed?.isError).toBeUndefined();
    expect(listed.structuredContent.result).toEqual([ownTerminal]);

    const deniedPtyWrite = await callTool(handler, "run_ade_action", {
      domain: "pty",
      action: "write",
      args: { ptyId: "pty-2", data: "stop\n" },
    });
    expect(deniedPtyWrite.isError).toBe(true);
    expect(fixture.runtime.ptyService.write).not.toHaveBeenCalled();

    const deniedTerminalWrite = await callTool(handler, "run_ade_action", {
      domain: "terminal",
      action: "write",
      args: { chatSessionId: "chat-2", data: "stop\n" },
    });
    expect(deniedTerminalWrite.isError).toBe(true);
    expect(fixture.runtime.ptyService.writeTerminal).not.toHaveBeenCalled();

    const ownTerminalWrite = await callTool(handler, "run_ade_action", {
      domain: "terminal",
      action: "write",
      args: { data: "continue\n" },
    });
    expect(ownTerminalWrite?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.writeTerminal).toHaveBeenCalledWith({
      data: "continue\n",
      chatSessionId: "chat-1",
    });

    const deniedChatRead = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "readTranscript",
      args: { sessionId: "chat-2", limit: 10 },
    });
    expect(deniedChatRead.isError).toBe(true);
    expect(fixture.runtime.agentChatService.getChatTranscript).not.toHaveBeenCalled();

    const deniedChatSend = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "sendMessage",
      args: { sessionId: "chat-2", text: "cross-chat write" },
    });
    expect(deniedChatSend.isError).toBe(true);
    expect(fixture.runtime.agentChatService.sendMessage).not.toHaveBeenCalled();

    const ownChatRead = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "readTranscript",
      args: { limit: 10 },
    });
    expect(ownChatRead?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.getChatTranscript).toHaveBeenCalledWith({
      sessionId: "chat-1",
      limit: 10,
    });

    const ownChatSend = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "sendMessage",
      args: { text: "own-chat write" },
    });
    expect(ownChatSend?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.sendMessage).toHaveBeenCalledWith({
      sessionId: "chat-1",
      text: "own-chat write",
    });

    const peerMessage = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "messageSession",
      args: { sessionId: "chat-2", kind: "auto", text: "peer context" },
    });
    expect(peerMessage?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.messageSession).toHaveBeenCalledWith({
      sessionId: "chat-2",
      kind: "auto",
      text: "peer context",
    });
  });

  it("scopes external-sessions ADE actions to the caller's lane", async () => {
    const fixture = createRuntime();
    const ownChat = { id: "chat-1", laneId: "lane-1", chatSessionId: "chat-1" };
    fixture.runtime.sessionService.get.mockImplementation((sessionId: string) => {
      if (sessionId === "chat-1") return ownChat;
      return null;
    });
    const lane1Cwd = path.resolve(fixture.runtime.laneService.getLaneWorktreePath("lane-1"));
    const lane2Cwd = path.resolve(fixture.runtime.laneService.getLaneWorktreePath("lane-2"));
    const outsideCwd = path.resolve(fixture.runtime.projectRoot, "..", "outside-project");
    const isInside = (parent: string, candidate: string): boolean => {
      const relative = path.relative(parent, candidate);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    };
    const externalRows = [
      { provider: "claude", id: "own-session", cwd: lane1Cwd, title: "Own", preview: "own" },
      { provider: "codex", id: "own-codex", cwd: lane1Cwd, title: "Own Codex", preview: "own codex" },
      { provider: "claude", id: "other-lane-session", cwd: lane2Cwd, title: "Other lane", preview: "other" },
      { provider: "claude", id: "outside-session", cwd: outsideCwd, title: "Outside", preview: "outside" },
      { provider: "codex", id: "outside-codex", cwd: outsideCwd, title: "Outside Codex", preview: "outside codex" },
    ];
    const list = vi.fn(async (args?: { providers?: string[]; scope?: string }) => {
      let rows = externalRows;
      if (args?.providers?.length) {
        rows = rows.filter((row) => args.providers!.includes(row.provider));
      }
      if (args?.scope === "project") {
        rows = rows.filter((row) => isInside(lane1Cwd, row.cwd));
      }
      return rows;
    });
    const importExternalSession = vi.fn(async (args: {
      provider: string;
      sessionId: string;
      laneId: string;
      target?: string;
      enforceLaneScopeCwd?: string;
    }) => {
      const source = externalRows.find((row) => row.provider === args.provider && row.id === args.sessionId);
      if (args.enforceLaneScopeCwd && (!source || !isInside(args.enforceLaneScopeCwd, source.cwd))) {
        throw new Error("External session import is not permitted for this lane.");
      }
      return args.target === "chat"
        ? { kind: "chat", chatSessionId: "chat-import", laneId: args.laneId }
        : {
            kind: "cli",
            sessionId: "terminal-import",
            ptyId: "pty-import",
            laneId: args.laneId,
          };
    });
    (fixture.runtime as any).externalSessionsService = { list, importExternalSession };
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent", chatSessionId: "chat-1" });

    const listed = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "list",
      args: { scope: "all" },
    });

    expect(listed?.isError).toBeUndefined();
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      scope: "project",
      laneId: "lane-1",
      cwd: lane1Cwd,
    }));
    expect(listed.structuredContent.result).toEqual([
      { provider: "claude", id: "own-session", cwd: lane1Cwd, title: "Own", preview: "own" },
      { provider: "codex", id: "own-codex", cwd: lane1Cwd, title: "Own Codex", preview: "own codex" },
    ]);

    const deniedOutsideCliResume = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "codex",
        sessionId: "outside-codex",
        laneId: "lane-1",
        target: "cli",
        mode: "resume",
      },
    });
    expect(deniedOutsideCliResume.isError).toBe(true);
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "codex",
      sessionId: "outside-codex",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      enforceLaneScopeCwd: lane1Cwd,
    });

    const deniedOutsideCliFork = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "outside-session",
        laneId: "lane-1",
        target: "cli",
        mode: "fork",
      },
    });
    expect(deniedOutsideCliFork.isError).toBe(true);
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "claude",
      sessionId: "outside-session",
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
      enforceLaneScopeCwd: lane1Cwd,
    });

    const deniedOutsideChatImport = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "outside-session",
        laneId: "lane-1",
        target: "chat",
        mode: "resume",
      },
    });
    expect(deniedOutsideChatImport.isError).toBe(true);
    expect(deniedOutsideChatImport.error?.code).toBe(JsonRpcErrorCode.methodNotFound);
    expect(importExternalSession).toHaveBeenCalledTimes(2);

    const importedOwnCliResume = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "codex",
        sessionId: "own-codex",
        laneId: "lane-1",
        target: "cli",
        mode: "resume",
      },
    });
    expect(importedOwnCliResume?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "codex",
      sessionId: "own-codex",
      laneId: "lane-1",
      target: "cli",
      mode: "resume",
      enforceLaneScopeCwd: lane1Cwd,
    });

    const importedOwnCliFork = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "own-session",
        laneId: "lane-1",
        target: "cli",
        mode: "fork",
      },
    });
    expect(importedOwnCliFork?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "claude",
      sessionId: "own-session",
      laneId: "lane-1",
      target: "cli",
      mode: "fork",
      enforceLaneScopeCwd: lane1Cwd,
    });

    const importedOwnChat = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "own-session",
        laneId: "lane-1",
        target: "chat",
        mode: "resume",
      },
    });
    expect(importedOwnChat?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "claude",
      sessionId: "own-session",
      laneId: "lane-1",
      target: "chat",
      mode: "resume",
      enforceLaneScopeCwd: lane1Cwd,
    });

    const deniedOtherLaneImport = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "codex",
        sessionId: "own-session",
        laneId: "lane-2",
        target: "cli",
        mode: "resume",
      },
    });
    expect(deniedOtherLaneImport.isError).toBe(true);
    expect(importExternalSession).toHaveBeenCalledTimes(5);
  });

  it("allows CTO callers to use unscoped external-sessions ADE actions", async () => {
    const fixture = createRuntime();
    const list = vi.fn(async () => [
      { provider: "claude", id: "outside-session", cwd: "/tmp/outside", title: "Outside", preview: "outside" },
    ]);
    const importExternalSession = vi.fn(async (args: { laneId: string }) => ({
      kind: "cli",
      sessionId: "terminal-import",
      ptyId: "pty-import",
      laneId: args.laneId,
    }));
    (fixture.runtime as any).externalSessionsService = { list, importExternalSession };
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "cto-1", role: "cto" });

    const listed = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "list",
      args: { scope: "all", limit: 10 },
    });
    expect(listed?.isError).toBeUndefined();
    expect(list).toHaveBeenCalledWith({ scope: "all", limit: 10 });
    expect(listed.structuredContent.result).toEqual([
      { provider: "claude", id: "outside-session", cwd: "/tmp/outside", title: "Outside", preview: "outside" },
    ]);

    const imported = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "outside-session",
        laneId: "lane-2",
        target: "cli",
        mode: "resume",
      },
    });
    expect(imported?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "claude",
      sessionId: "outside-session",
      laneId: "lane-2",
      target: "cli",
      mode: "resume",
    });

    const importedChat = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "claude",
        sessionId: "outside-session",
        laneId: "lane-2",
        target: "chat",
        mode: "resume",
      },
    });
    expect(importedChat?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenLastCalledWith({
      provider: "claude",
      sessionId: "outside-session",
      laneId: "lane-2",
      target: "chat",
      mode: "resume",
    });
  });

  it("allows the unbound ade CLI to use explicit-lane external-session actions", async () => {
    const fixture = createRuntime();
    const persistedSession = {
      id: "terminal-import",
      ptyId: "pty-import",
      laneId: "lane-2",
      title: "Imported Codex session",
    };
    const list = vi.fn(async () => [
      { provider: "codex", id: "outside-session", cwd: "/tmp/outside", title: "Outside", preview: "outside" },
    ]);
    const importExternalSession = vi.fn(async (args: { laneId: string }) => ({
      kind: "cli" as const,
      sessionId: persistedSession.id,
      ptyId: persistedSession.ptyId,
      laneId: args.laneId,
      session: persistedSession,
    }));
    (fixture.runtime as any).externalSessionsService = { list, importExternalSession };
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "ade-cli:4242", role: "agent" });

    const listed = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "list",
      args: { scope: "all", limit: 10 },
    });
    expect(listed?.isError).toBeUndefined();
    expect(list).toHaveBeenCalledWith({ scope: "all", limit: 10 });

    const imported = await callTool(handler, "run_ade_action", {
      domain: "external-sessions",
      action: "import",
      args: {
        provider: "codex",
        sessionId: "outside-session",
        laneId: "lane-2",
        target: "cli",
        mode: "resume",
      },
    });
    expect(imported?.isError).toBeUndefined();
    expect(importExternalSession).toHaveBeenCalledWith({
      provider: "codex",
      sessionId: "outside-session",
      laneId: "lane-2",
      target: "cli",
      mode: "resume",
    });
    expect(imported.structuredContent.result).toEqual({
      kind: "cli",
      sessionId: "terminal-import",
      ptyId: "pty-import",
      laneId: "lane-2",
      session: persistedSession,
    });
  });

  it("keeps explicit chat ADE actions available to unbound external CLI callers", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "external-cli", role: "external" });

    const read = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "readTranscript",
      args: { sessionId: "chat-2", limit: 10 },
    });
    expect(read?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.getChatTranscript).toHaveBeenCalledWith({
      sessionId: "chat-2",
      limit: 10,
    });

    const send = await callTool(handler, "run_ade_action", {
      domain: "chat",
      action: "sendMessage",
      args: { sessionId: "chat-2", text: "external write" },
    });
    expect(send?.isError).toBeUndefined();
    expect(fixture.runtime.agentChatService.sendMessage).toHaveBeenCalledWith({
      sessionId: "chat-2",
      text: "external write",
    });
  });

  it("invokes review.startRun through ADE actions without dropping unlimited budgets", async () => {
    const fixture = createRuntime();
    const startArgs = {
      target: { mode: "lane_diff", laneId: "lane-1" },
      config: {
        compareAgainst: { kind: "default_branch" },
        selectionMode: "full_diff",
        dirtyOnly: false,
        modelId: "openai/gpt-5.4",
        reasoningEffort: "medium",
        budgets: {
          unlimited: true,
          maxFiles: Number.MAX_SAFE_INTEGER,
          maxDiffChars: Number.MAX_SAFE_INTEGER,
          maxPromptChars: Number.MAX_SAFE_INTEGER,
          maxFindings: Number.MAX_SAFE_INTEGER,
          maxFindingsPerPass: Number.MAX_SAFE_INTEGER,
          maxPublishedFindings: Number.MAX_SAFE_INTEGER,
        },
        publishBehavior: "local_only",
      },
    };
    const startRun = vi.fn(async (args: typeof startArgs) => ({
      id: "review-run-1",
      laneId: args.target.laneId,
      config: args.config,
      status: "queued",
    }));
    (fixture.runtime as any).reviewService = { startRun };
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "review",
      action: "startRun",
      args: startArgs,
    });

    expect(response?.isError).toBeUndefined();
    expect(startRun).toHaveBeenCalledWith(startArgs);
    expect(startRun.mock.calls[0][0].config.budgets).toEqual(startArgs.config.budgets);
    expect(response.structuredContent.result.config.budgets).toEqual(startArgs.config.budgets);
    expect(response.structuredContent.result.config.budgets.unlimited).toBe(true);
  });



  it("rejects run_ade_action when the action is not a callable on the domain service", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "git",
      action: "nonexistent_action",
      args: { laneId: "lane-1" },
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "Action 'git.nonexistent_action' is not callable.",
    );
  });

  it("reads ADE action status snapshots across operation/test/chat/pr", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "get_ade_action_status", {
      operationId: "op-1",
      testRunId: "test-run-1",
      chatSessionId: "chat-1",
      prId: "pr-1",
    });
    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.operation.id).toBe("op-1");
    expect(response.structuredContent.testRun.id).toBe("test-run-1");
    expect(response.structuredContent.chatSession.sessionId).toBe("chat-1");
    expect(response.structuredContent.pr.health.prId).toBe("pr-1");
    expect(typeof response.structuredContent.hash).toBe("string");
    expect(response.structuredContent.changed).toBe(true);

    const unchanged = await callTool(handler, "get_ade_action_status", {
      operationId: "op-1",
      testRunId: "test-run-1",
      chatSessionId: "chat-1",
      prId: "pr-1",
      previousHash: response.structuredContent.hash,
      waitForMs: 0,
    });
    expect(unchanged?.isError).toBeUndefined();
    expect(unchanged.structuredContent.changed).toBe(false);
  });

  it("lets agent callers stash lane changes", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "stash_push", {
      laneId: "lane-1",
      message: "pre-rebase",
      includeUntracked: true,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.stashPush).toHaveBeenCalledWith({
      laneId: "lane-1",
      message: "pre-rebase",
      includeUntracked: true,
    });
    expect(fixture.runtime.gitService.listStashes).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(response.structuredContent.latest.ref).toBe("stash@{0}");
  });

  it("lists lane stashes for agent callers", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "list_stashes", {
      laneId: "lane-1",
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.listStashes).toHaveBeenCalledWith({ laneId: "lane-1" });
    expect(response.structuredContent.count).toBe(1);
  });

  it("passes stash oid through destructive stash tools", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const pop = await callTool(handler, "stash_pop", {
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
    const drop = await callTool(handler, "stash_drop", {
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });

    expect(pop?.isError).toBeUndefined();
    expect(drop?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.stashPop).toHaveBeenCalledWith({
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
    expect(fixture.runtime.gitService.stashDrop).toHaveBeenCalledWith({
      laneId: "lane-1",
      stashRef: "stash@{0}",
      stashOid: "oid-0",
    });
  });

  it("returns resources for lane status/conflicts", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const result = (await handler({ jsonrpc: "2.0", id: 4, method: "ade/resources/list", params: {} })) as any;
    const uris = (result.resources ?? []).map((entry: any) => entry.uri);

    expect(uris).toContain("ade://lane/lane-1/status");
    expect(uris).toContain("ade://lane/lane-1/conflicts");
    expect(uris.some((u: string) => u.startsWith("ade://pack/"))).toBe(false);
  });

  it("reads lane/status resource with the correct URI parser semantics", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const result = (await handler({
      jsonrpc: "2.0",
      id: 5,
      method: "ade/resources/read",
      params: { uri: "ade://lane/lane-1/status" }
    })) as any;

    const payload = JSON.parse(result.contents[0].text);
    expect(payload.lane.id).toBe("lane-1");
    expect(payload.rebaseStatus).toBe("idle");
  });

  it("does not record operation metadata for read-only action calls", async () => {
    const { runtime, operationStart, operationFinish } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "list_lanes", {});

    expect(response.isError).toBeUndefined();
    expect(operationStart).not.toHaveBeenCalled();
    expect(operationFinish).not.toHaveBeenCalled();
  });

  // ---------- Rate limit tests ----------

  afterEach(() => {
    _resetGlobalAskUserRateLimit();
  });

  it("enforces global ask_user rate limit across sessions", async () => {
    _resetGlobalAskUserRateLimit();

    // Create two independent sessions (simulating session recycling)
    const fixture1 = createRuntime();
    const handler1 = createAdeRpcRequestHandler({ runtime: fixture1.runtime, serverVersion: "test" });
    await initialize(handler1, { callerId: "chat-1", role: "agent", chatSessionId: "chat-1" });

    const fixture2 = createRuntime();
    const handler2 = createAdeRpcRequestHandler({ runtime: fixture2.runtime, serverVersion: "test" });
    await initialize(handler2, { callerId: "chat-2", role: "agent", chatSessionId: "chat-2" });

    // Fire 6 calls from session 1 (per-session limit)
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler1, "ask_user", {
        title: `Question ${i}`,
        body: `Body ${i}`
      });
      expect(r?.isError).toBeUndefined();
    }

    // Session 1 should be rate-limited (per-session: 6/min)
    const overLimit = await callTool(handler1, "ask_user", {
      title: "Over limit",
      body: "Should fail"
    });
    expect(overLimit.isError).toBe(true);
    expect(JSON.stringify(overLimit.structuredContent ?? {})).toContain("rate limit");

    // Session 2 can still fire up to its per-session limit (6)
    // but global limit is 20, so with 6 from session 1, session 2 can do 6 more
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler2, "ask_user", {
        title: `S2 Question ${i}`,
        body: `S2 Body ${i}`
      });
      expect(r?.isError).toBeUndefined();
    }
  });

  // ---------- Issue 3: Coverage for previously untested tools ----------

  it("routes get_lane_status and returns lane/diff/conflict info", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_lane_status", { laneId: "lane-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.lane.id).toBe("lane-1");
    expect(response.structuredContent.diff).toBeDefined();
    expect(response.structuredContent.rebaseStatus).toBe("idle");
    expect(fixture.runtime.diffService.getChanges).toHaveBeenCalledWith("lane-1");
    expect(fixture.runtime.conflictService.getLaneStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
  });

  it("projects projectless Linear lane issues and link rows instead of dropping them", async () => {
    const fixture = createRuntime();
    const projectlessIssue = {
      id: "issue-69",
      identifier: "ADE-69",
      title: "Projectless issue linked to a lane",
      description: null,
      url: "https://linear.app/ade-linear/issue/ADE-69/projectless",
      projectId: "",
      projectSlug: "",
      projectName: null,
      teamId: "team-ade",
      teamKey: "ADE",
      teamName: "ADE",
      stateId: "state-backlog",
      stateName: "Backlog",
      stateType: "backlog",
      priority: 2,
      priorityLabel: "high",
      labels: ["bug"],
      assigneeId: null,
      assigneeName: null,
      creatorId: null,
      creatorName: null,
      dueDate: null,
      estimate: null,
      branchName: "ade-69-projectless",
      createdAt: "2026-05-31T08:32:17.115Z",
      updatedAt: "2026-05-31T08:32:17.115Z",
    };
    (fixture.runtime.laneService.list as any).mockResolvedValueOnce([
      {
        id: "lane-1",
        name: "ADE-69 Projectless issue linked to a lane",
        laneType: "worktree",
        parentLaneId: null,
        baseRef: "main",
        branchRef: "ade-69-projectless",
        worktreePath: "/tmp/project/.ade/worktrees/ade-69",
        archivedAt: null,
        stackDepth: 0,
        linearIssue: projectlessIssue,
        linearIssueLinks: [
          {
            id: "link-69",
            laneId: "lane-1",
            issue: projectlessIssue,
            role: "primary",
            source: "lane_create",
            includeInPr: true,
            closeOnMerge: false,
            evidence: null,
            createdAt: "2026-05-31T08:32:17.115Z",
            updatedAt: "2026-05-31T08:32:17.115Z",
          },
        ],
        status: { dirty: false, ahead: 0, behind: 0 },
      },
    ]);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_lane_status", { laneId: "lane-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.lane.linearIssue).toMatchObject({
      id: "issue-69",
      identifier: "ADE-69",
      projectId: "",
      projectSlug: "",
    });
    expect(response.structuredContent.lane.linearIssueLinks).toEqual([
      expect.objectContaining({
        id: "link-69",
        role: "primary",
        source: "lane_create",
        issue: expect.objectContaining({ identifier: "ADE-69", projectId: "" }),
      }),
    ]);
  });

  it("routes check_conflicts with a single laneId", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "check_conflicts", { laneId: "lane-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.assessment).toBeDefined();
    expect(fixture.runtime.conflictService.runPrediction).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1" })
    );
  });

  it("routes create_lane with authorization and returns lane summary", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_lane", { name: "new-feature" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.lane.id).toBe("lane-new");
    expect(response.structuredContent.lane.name).toBe("new-feature");
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-feature" })
    );
  });

  it("defaults a base-less create_lane to the fetched remote-tracking ref", async () => {
    const fixture = createRuntime();
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-primary", laneType: "primary", baseRef: "main", branchRef: "main" },
    ]) as any;
    fixture.runtime.gitService.listBranches = vi.fn(async () => [
      { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
      { name: "origin/main", isCurrent: false, isRemote: true, upstream: null },
    ]) as any;
    fixture.runtime.projectConfigService = {
      getEffective: vi.fn(() => ({ git: { newLaneBaseSource: "remote" } })),
    } as any;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_lane", { name: "new-feature" });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.fetch).toHaveBeenCalledWith({ laneId: "lane-primary" });
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "new-feature", baseBranch: "origin/main" })
    );
  });

  it("defaults a base-less run_ade_action lane.create to the remote-tracking ref", async () => {
    const fixture = createRuntime();
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-primary", laneType: "primary", baseRef: "main", branchRef: "main" },
    ]) as any;
    fixture.runtime.gitService.listBranches = vi.fn(async () => [
      { name: "main", isCurrent: true, isRemote: false, upstream: "origin/main" },
      { name: "origin/main", isCurrent: false, isRemote: true, upstream: null },
    ]) as any;
    fixture.runtime.projectConfigService = {
      getEffective: vi.fn(() => ({ git: { newLaneBaseSource: "remote" } })),
    } as any;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "run_ade_action", {
      domain: "lane",
      action: "create",
      args: { name: "action-lane" },
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "action-lane", baseBranch: "origin/main" })
    );
    expect(fixture.runtime.db.run).toHaveBeenCalledWith(
      expect.stringContaining("insert into usage_events"),
      expect.arrayContaining(["lanes.create"]),
    );
  });

  it("skips the remote default when create_lane has an explicit base or parent", async () => {
    const fixture = createRuntime();
    fixture.runtime.laneService.list = vi.fn(async () => [
      { id: "lane-primary", laneType: "primary", baseRef: "main", branchRef: "main" },
    ]) as any;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    await callTool(handler, "create_lane", { name: "explicit-base", baseBranch: "develop" });
    await callTool(handler, "create_lane", { name: "child", parentLaneId: "lane-primary" });

    expect(fixture.runtime.gitService.fetch).not.toHaveBeenCalled();
    expect((fixture.runtime.laneService.create as any).mock.calls[0][0].baseBranch).toBe("develop");
    expect((fixture.runtime.laneService.create as any).mock.calls[1][0].baseBranch).toBeUndefined();
  });

  it("passes branch and Linear issue data through create_lane", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    const linearIssue = {
      id: "issue-1",
      identifier: "ADE-123",
      title: "Create linked lane",
      description: null,
      url: "https://linear.app/ade/issue/ADE-123/create-linked-lane",
      projectId: "project-1",
      projectSlug: "ade",
      projectName: "ADE",
      teamId: "team-1",
      teamKey: "ADE",
      teamName: "ADE",
      stateId: "state-1",
      stateName: "Todo",
      stateType: "unstarted",
      priority: 2,
      priorityLabel: "high",
      labels: ["desktop"],
      assigneeId: null,
      assigneeName: null,
      creatorId: null,
      creatorName: null,
      dueDate: null,
      estimate: null,
      branchName: "ade-123-create-linked-lane",
      createdAt: "2026-05-08T00:00:00.000Z",
      updatedAt: "2026-05-08T00:00:00.000Z",
      secretToken: "do-not-forward",
    };

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_lane", {
      name: "new-feature",
      baseBranch: "main",
      branchName: "ade-123-create-linked-lane",
      linearIssue,
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "new-feature",
        baseBranch: "main",
        branchName: "ade-123-create-linked-lane",
        linearIssue: expect.objectContaining({
          id: "issue-1",
          identifier: "ADE-123",
          title: "Create linked lane",
          projectId: "project-1",
          priorityLabel: "high",
        }),
      })
    );
    expect((fixture.runtime.laneService.create as any).mock.calls[0][0].linearIssue).not.toHaveProperty("secretToken");
  });

  it("accepts projectless Linear issue data when creating a linked lane", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_lane", {
      name: "projectless-linear-lane",
      linearIssue: {
        id: "issue-projectless",
        identifier: "ADE-69",
        title: "Projectless Linear issue",
        description: null,
        url: null,
        projectId: "",
        projectSlug: "",
        projectName: null,
        teamId: "team-ade",
        teamKey: "ADE",
        teamName: "ADE",
        stateId: "state-backlog",
        stateName: "Backlog",
        stateType: "backlog",
        priority: 2,
        priorityLabel: "high",
        labels: [],
        assigneeId: null,
        assigneeName: null,
        creatorId: null,
        creatorName: null,
        dueDate: null,
        estimate: null,
        createdAt: "2026-05-31T08:32:17.115Z",
        updatedAt: "2026-05-31T08:32:17.115Z",
      },
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.laneService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        linearIssue: expect.objectContaining({
          identifier: "ADE-69",
          projectId: "",
          projectSlug: "",
        }),
      }),
    );
  });

  it("routes simulate_integration as a read-only dry-merge", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "simulate_integration", {
      sourceLaneIds: ["lane-1", "lane-2"],
      baseBranch: "main"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.simulateIntegration).toHaveBeenCalledWith({
      sourceLaneIds: ["lane-1", "lane-2"],
      baseBranch: "main"
    });
  });

  it("routes create_queue with authorization", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_queue", {
      laneIds: ["lane-1", "lane-2"],
      targetBranch: "main"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createQueuePrs).toHaveBeenCalledWith(
      expect.objectContaining({
        laneIds: ["lane-1", "lane-2"],
        targetBranch: "main"
      })
    );
  });

  it("routes create_integration with authorization", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "create_integration", {
      sourceLaneIds: ["lane-1"],
      integrationLaneName: "integration-branch",
      baseBranch: "main",
      title: "Integration PR"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createIntegrationPr).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceLaneIds: ["lane-1"],
        integrationLaneName: "integration-branch",
        baseBranch: "main",
        title: "Integration PR"
      })
    );
  });

  it("routes rebase_lane with authorization", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "rebase_lane", {
      laneId: "lane-1",
      aiAssisted: true
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.conflictService.rebaseLane).toHaveBeenCalledWith(
      expect.objectContaining({ laneId: "lane-1", aiAssisted: true })
    );
  });

  it("suggests stash or commit tools when rebase_lane is blocked by a dirty worktree", async () => {
    const fixture = createRuntime();
    fixture.runtime.conflictService.rebaseLane = vi.fn(async () => ({
      laneId: "lane-1",
      success: false,
      conflictingFiles: [],
      error: "Worktree has uncommitted changes. Commit or stash before rebasing.",
    }));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "rebase_lane", {
      laneId: "lane-1",
      aiAssisted: true,
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent).toMatchObject({
      success: false,
      suggestedNextAction: "stash_or_commit_dirty_worktree",
      suggestedTools: ["stash_push", "commit_changes"],
    });
  });

  it("routes get_pr_health as a read-only tool", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_pr_health", { prId: "pr-123" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.prId).toBe("pr-123");
    expect(fixture.runtime.prService.getPrHealth).toHaveBeenCalledWith("pr-123");
  });

  it("routes pr_get_checks as a read-only tool", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "pr_get_checks", { prId: "pr-123" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        prId: "pr-123",
      }),
    );
    expect(response.structuredContent.checks[0]).toEqual(
      expect.objectContaining({
        name: "ci / unit",
        status: "completed",
        conclusion: "success",
      }),
    );
    expect(fixture.runtime.prService.getChecks).toHaveBeenCalledWith("pr-123");
  });

  it("routes pr_get_review_comments with actionable review context", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "pr_get_review_comments", { prId: "pr-123" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.summary).toEqual(
      expect.objectContaining({
        totalComments: 1,
        actionableComments: 2,
        actionableReviewThreadCount: 1,
        reviewsRequiringChanges: 1,
        checksStatus: "passing",
      }),
    );
    expect(response.structuredContent.comments[0]).toEqual(
      expect.objectContaining({
        author: "reviewer",
        body: "Please fix the loading state.",
      }),
    );
    expect(response.structuredContent.reviewThreads[0]).toEqual(
      expect.objectContaining({
        id: "thread-1",
        path: "src/index.ts",
        line: 12,
      }),
    );
    expect(fixture.runtime.prService.getComments).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getReviews).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getChecks).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getReviewThreads).toHaveBeenCalledWith("pr-123");
  });

  it("routes pr_rerun_failed_checks, pr_reply_to_review_thread, and pr_resolve_review_thread", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);

    const rerunResponse = await callTool(handler, "pr_rerun_failed_checks", { prId: "pr-123" });
    expect(rerunResponse?.isError).toBeUndefined();
    expect(fixture.runtime.prService.rerunChecks).toHaveBeenCalledWith({ prId: "pr-123" });

    const replyResponse = await callTool(handler, "pr_reply_to_review_thread", {
      prId: "pr-123",
      threadId: "thread-1",
      body: "Fixed.",
    });
    expect(replyResponse?.isError).toBeUndefined();
    expect(replyResponse.structuredContent.comment).toEqual(
      expect.objectContaining({
        body: "Reply to thread-1",
      }),
    );
    expect(fixture.runtime.prService.replyToReviewThread).toHaveBeenCalledWith({
      prId: "pr-123",
      threadId: "thread-1",
      body: "Fixed.",
    });

    const resolveResponse = await callTool(handler, "pr_resolve_review_thread", {
      prId: "pr-123",
      threadId: "thread-1",
    });
    expect(resolveResponse?.isError).toBeUndefined();
    expect(resolveResponse.structuredContent).toEqual(
      expect.objectContaining({
        success: true,
        prId: "pr-123",
        threadId: "thread-1",
      }),
    );
    expect(fixture.runtime.prService.resolveReviewThread).toHaveBeenCalledWith({
      prId: "pr-123",
      threadId: "thread-1",
    });
  });

  it("routes land_queue_next with authorization", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "land_queue_next", {
      groupId: "group-1",
      method: "squash"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.prService.landQueueNext).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "group-1", method: "squash" })
    );
  });

  it("get_lane_status returns error for unknown lane", async () => {
    const fixture = createRuntime();
    fixture.runtime.laneService.list = vi.fn(async () => []);
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "get_lane_status", { laneId: "nonexistent" });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Lane not found");
  });

  it("run_tests requires either suiteId or command", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "orchestrator", role: "orchestrator" });
    const response = await callTool(handler, "run_tests", { laneId: "lane-1" });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("suiteId or command");
  });

  // ---------- Observation Tools ----------



  it("routes stream_events to eventBuffer.drain", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 0, limit: 50 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(1);
    expect(response.structuredContent.nextCursor).toBe(1);
    expect(response.structuredContent.hasMore).toBe(false);
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(0, 50);
  });








  // ---------- Evaluation Tools ----------






  // ---------- Event Streaming Tests ----------

  it("stream_events returns events after cursor", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 5, limit: 100 });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(5, 100);
    // The drain mock returns cursor + 1 as the event id
    expect(response.structuredContent.events[0].id).toBe(6);
    expect(response.structuredContent.nextCursor).toBe(6);
  });

  it("stream_events with empty drain returns same cursor", async () => {
    const fixture = createRuntime();
    // Override drain to return empty events
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [],
      nextCursor: cursor,
      hasMore: false
    }));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", { cursor: 10 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(0);
    expect(response.structuredContent.nextCursor).toBe(10);
    expect(response.structuredContent.hasMore).toBe(false);
  });

  it("stream_events respects category filter", async () => {
    const fixture = createRuntime();
    // Return events with different categories
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [
        { id: cursor + 1, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "step_started" } },
        { id: cursor + 2, timestamp: new Date().toISOString(), category: "runtime", payload: { type: "terminal_session_changed" } },
        { id: cursor + 3, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "step_completed" } }
      ],
      nextCursor: cursor + 3,
      hasMore: false
    }));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {
      cursor: 0,
      limit: 100,
      category: "orchestrator"
    });

    expect(response?.isError).toBeUndefined();
    // Should only return orchestrator events (2 out of 3)
    expect(response.structuredContent.events).toHaveLength(2);
    expect(response.structuredContent.events.every((e: any) => e.category === "orchestrator")).toBe(true);
  });

  it("stream_events supports the PTY category", async () => {
    const fixture = createRuntime();
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [
        { id: cursor + 1, timestamp: new Date().toISOString(), category: "runtime", payload: { type: "terminal_session_changed" } },
        { id: cursor + 2, timestamp: new Date().toISOString(), category: "pty", payload: { type: "pty_data", event: { sessionId: "session-1", data: "hi" } } },
        { id: cursor + 3, timestamp: new Date().toISOString(), category: "pty", payload: { type: "pty_exit", event: { sessionId: "session-1", exitCode: 0 } } },
      ],
      nextCursor: cursor + 3,
      hasMore: false,
    }));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {
      cursor: 0,
      limit: 100,
      category: "pty",
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(2);
    expect(response.structuredContent.events.every((event: any) => event.category === "pty")).toBe(true);
    expect(response.structuredContent.nextCursor).toBe(3);
  });

  it("stream_events returns runtime validation contract events when requested", async () => {
    const fixture = createRuntime();
    fixture.runtime.eventBuffer.drain = vi.fn((cursor: number) => ({
      events: [
        {
          id: cursor + 1,
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: "validation_contract_unfulfilled",
            runId: "run-1",
            stepId: "step-1"
          }
        },
        {
          id: cursor + 2,
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: "validation_self_check_reminder",
            runId: "run-1",
            stepId: "step-2"
          }
        },
        {
          id: cursor + 3,
          timestamp: new Date().toISOString(),
          category: "runtime",
          payload: {
            type: "validation_gate_blocked",
            runId: "run-1",
            stepId: null
          }
        },
        {
          id: cursor + 4,
          timestamp: new Date().toISOString(),
          category: "pty",
          payload: { type: "pty_exit" }
        }
      ],
      nextCursor: cursor + 4,
      hasMore: false
    }));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {
      cursor: 0,
      limit: 100,
      category: "runtime"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.events).toHaveLength(3);
    expect(response.structuredContent.events.every((e: any) => e.category === "runtime")).toBe(true);
    const eventTypes = response.structuredContent.events.map((event: any) => event.payload?.type);
    expect(eventTypes).toContain("validation_contract_unfulfilled");
    expect(eventTypes).toContain("validation_self_check_reminder");
    expect(eventTypes).toContain("validation_gate_blocked");
  });

  it("stream_events defaults cursor to 0 and limit to 100", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "stream_events", {});

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.eventBuffer.drain).toHaveBeenCalledWith(0, 100);
  });

  describe("resolveComputerUseOwners explicit ownerKind/ownerId", () => {
    function makeSession(): any {
      return {
        initialized: true,
        protocolVersion: "2025-06-18",
        identity: {
          callerId: "caller-1",
          role: "external",
          chatSessionId: null,
          standaloneChatSession: false,
          runId: null,
          stepId: null,
          attemptId: null,
          ownerId: null,
        },
        askUserEvents: [],
        askUserRateLimit: { maxCalls: 1, windowMs: 1000 },
      };
    }

    it("includes an explicit lane owner", () => {
      const owners = resolveComputerUseOwners(makeSession(), { ownerKind: "lane", ownerId: "lane-1" });
      expect(owners).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "lane", id: "lane-1", relation: "attached_to" }),
        ]),
      );
      // Explicit owner is prepended.
      expect(owners[0]).toEqual(expect.objectContaining({ kind: "lane", id: "lane-1" }));
    });

    it("normalizes alias 'chat' to 'chat_session'", () => {
      const owners = resolveComputerUseOwners(makeSession(), { ownerKind: "chat", ownerId: "c1" });
      expect(owners[0]).toEqual(expect.objectContaining({ kind: "chat_session", id: "c1" }));
      expect(owners.some((o) => (o as any).kind === "chat")).toBe(false);
    });

    it("normalizes alias 'pr' to 'github_pr'", () => {
      const owners = resolveComputerUseOwners(makeSession(), { ownerKind: "pr", ownerId: "p1" });
      expect(owners[0]).toEqual(expect.objectContaining({ kind: "github_pr", id: "p1" }));
    });

    it("throws JsonRpcError with invalidParams for an unsupported ownerKind", () => {
      let caught: unknown = null;
      try {
        resolveComputerUseOwners(makeSession(), { ownerKind: "bogus", ownerId: "x" });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(JsonRpcError);
      expect((caught as JsonRpcError).code).toBe(JsonRpcErrorCode.invalidParams);
    });

    it("rejects when ownerKind is provided without ownerId", () => {
      let caught: unknown = null;
      try {
        resolveComputerUseOwners(makeSession(), { ownerKind: "lane" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(JsonRpcError);
      expect((caught as JsonRpcError).code).toBe(JsonRpcErrorCode.invalidParams);
    });

    it("rejects when ownerId is provided without ownerKind", () => {
      let caught: unknown = null;
      try {
        resolveComputerUseOwners(makeSession(), { ownerId: "lane-123" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(JsonRpcError);
      expect((caught as JsonRpcError).code).toBe(JsonRpcErrorCode.invalidParams);
    });
  });
});

describe("run_ade_action search scoping", () => {
  const searchServiceMock = () => ({
    query: vi.fn(async (args: unknown) => ({ results: [], totalByKind: {}, nextCursor: null, receivedArgs: args })),
    indexStatus: vi.fn(() => ({ ready: true })),
    rebuildIndex: vi.fn(() => ({ started: true })),
  });

  it("injects the caller's own session scope for a session-bound agent", async () => {
    const fixture = createRuntime();
    const search = searchServiceMock();
    (fixture.runtime as Record<string, unknown>).searchService = search;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent", chatSessionId: "session-1" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "search",
      action: "query",
      args: { query: "kind:chat secrets", callerScope: { chatSessionId: "someone-else" } },
    });
    expect(response?.isError).toBeUndefined();
    expect(search.query).toHaveBeenCalledTimes(1);
    const args = search.query.mock.calls[0]![0] as { query: string; callerScope?: Record<string, unknown> };
    expect(args.query).toBe("kind:chat secrets");
    // The gate overwrites any caller-supplied scope with the bound session.
    expect(args.callerScope).toEqual({ chatSessionId: "session-1" });
  });

  it("keeps an unbound agent-role caller unscoped (plain `ade` CLI defaults to role agent)", async () => {
    const fixture = createRuntime();
    const search = searchServiceMock();
    (fixture.runtime as Record<string, unknown>).searchService = search;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-2", role: "agent" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "search",
      action: "query",
      args: { query: "aws secret" },
    });
    expect(response?.isError).toBeUndefined();
    const args = search.query.mock.calls[0]![0] as { callerScope?: Record<string, unknown> };
    expect(args.callerScope).toBeUndefined();
  });

  it("leaves an unbound external caller unscoped", async () => {
    const fixture = createRuntime();
    const search = searchServiceMock();
    (fixture.runtime as Record<string, unknown>).searchService = search;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "human-cli", role: "external" });

    const response = await callTool(handler, "run_ade_action", {
      domain: "search",
      action: "query",
      args: { query: "whole project" },
    });
    expect(response?.isError).toBeUndefined();
    const args = search.query.mock.calls[0]![0] as { query: string; callerScope?: Record<string, unknown> };
    expect(args.query).toBe("whole project");
    expect(args.callerScope).toBeUndefined();
  });

  it("gates rebuildIndex to CTO role while allowing indexStatus for agents", async () => {
    const fixture = createRuntime();
    const search = searchServiceMock();
    (fixture.runtime as Record<string, unknown>).searchService = search;
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-3", role: "agent" });

    const denied = await callTool(handler, "run_ade_action", {
      domain: "search",
      action: "rebuildIndex",
      args: {},
    });
    expect(denied?.isError).toBe(true);
    expect(search.rebuildIndex).not.toHaveBeenCalled();

    const status = await callTool(handler, "run_ade_action", {
      domain: "search",
      action: "indexStatus",
      args: {},
    });
    expect(status?.isError).toBeUndefined();
    expect(search.indexStatus).toHaveBeenCalledTimes(1);
  });
});
