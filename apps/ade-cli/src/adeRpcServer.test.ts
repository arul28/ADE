import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAdeRpcRequestHandler, _resetGlobalAskUserRateLimit } from "./adeRpcServer";

type RuntimeFixture = ReturnType<typeof createRuntime>;

function createRuntime() {
  const operationStart = vi.fn((args: any) => ({ operationId: `op-${args.kind}-${Date.now()}` }));
  const operationFinish = vi.fn();
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-test-"));
  fs.mkdirSync(path.join(projectRoot, ".ade", "orchestrator"), { recursive: true });
  const teamMembers: Array<Record<string, unknown>> = [];
  const threadRows: Array<Record<string, unknown>> = [];
  const threadMessages = new Map<string, Array<Record<string, unknown>>>();
  let messageCounter = 0;

  const ensureThread = (input: { missionId: string; attemptId: string; runId?: string | null }): Record<string, unknown> => {
    const existing = threadRows.find(
      (thread) => thread.missionId === input.missionId && thread.attemptId === input.attemptId
    );
    if (existing) return existing;
    const thread = {
      id: `thread-${input.attemptId}`,
      missionId: input.missionId,
      threadType: "worker",
      runId: input.runId ?? "run-1",
      attemptId: input.attemptId
    };
    threadRows.push(thread);
    threadMessages.set(thread.id, []);
    return thread;
  };

  const appendThreadMessage = (threadId: string, entry: Record<string, unknown>): void => {
    const existing = threadMessages.get(threadId) ?? [];
    existing.push(entry);
    threadMessages.set(threadId, existing);
  };

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
      get: vi.fn((sql: string) => {
        if (sql.includes("orchestrator_evaluations") && sql.includes("SELECT")) {
          return {
            id: "eval-1", run_id: "run-1", mission_id: "mission-1", evaluator_id: "evaluator-1",
            scores_json: '{"planQuality":8}', issues_json: '[]', summary: "Good run",
            improvements_json: '[]', metadata_json: '{}', evaluated_at: new Date().toISOString()
          };
        }
        return { count: 0 };
      }),
      all: vi.fn((sql: string) => {
        if (sql.includes("from missions")) return [{ id: "mission-1" }];
        if (sql.includes("orchestrator_evaluations")) return [{
          id: "eval-1", run_id: "run-1", mission_id: "mission-1", evaluator_id: "evaluator-1",
          scores_json: '{"planQuality":8}', issues_json: '[]', summary: "Good run",
          improvements_json: null, metadata_json: null, evaluated_at: new Date().toISOString()
        }];
        return [];
      }),
      run: vi.fn((sql: string, params?: unknown[]) => {
        if (
          sql.toLowerCase().includes("insert into orchestrator_team_members")
          && Array.isArray(params)
          && params.length >= 12
        ) {
          const metadataRaw = params[9];
          const metadata = typeof metadataRaw === "string" && metadataRaw.length > 0
            ? JSON.parse(metadataRaw)
            : {};
          teamMembers.push({
            id: params[0],
            runId: params[1],
            missionId: params[2],
            provider: params[3],
            model: params[4],
            role: params[5],
            sessionId: params[6],
            status: params[7],
            source: typeof metadata.source === "string" ? metadata.source : "claude-native",
            parentWorkerId: typeof metadata.parentWorkerId === "string" ? metadata.parentWorkerId : null,
            metadata
          });
        }
      })
    },
    laneService: {
      list: vi.fn(async () => laneRows),
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
      delete: vi.fn(async () => {})
    },
    sessionService: {
      get: vi.fn(),
      readTranscriptTail: vi.fn(() => "")
    },
    operationService: {
      start: operationStart,
      finish: operationFinish,
      list: vi.fn(() => [{ id: "op-1", kind: "git_push", status: "running" }]),
    },
    projectConfigService: {} as any,
    conflictService: {
      runPrediction: vi.fn(async () => ({ lanes: [], matrix: [], overlaps: [] })),
      getLaneStatus: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "merge-ready" })),
      listOverlaps: vi.fn(async () => []),
      rebaseLane: vi.fn(async ({ laneId }: { laneId: string }) => ({ laneId, status: "clean", conflictedFiles: [] }))
    },
    gitService: {
      getConflictState: vi.fn(async () => ({ laneId: "lane-1", kind: null, inProgress: false, conflictedFiles: [], canContinue: false, canAbort: false })),
      stageAll: vi.fn(async () => ({ success: true })),
      commit: vi.fn(async () => ({ success: true })),
      generateCommitMessage: vi.fn(async () => ({ message: "generated commit message", model: "gpt-5-mini" })),
      listRecentCommits: vi.fn(async () => [{ sha: "abc123", subject: "test" }]),
      getSyncStatus: vi.fn(async () => ({ ahead: 1, behind: 0, tracking: true })),
      fetch: vi.fn(async () => ({ success: true })),
      pull: vi.fn(async () => ({ success: true })),
      push: vi.fn(async () => ({ success: true })),
      listBranches: vi.fn(async () => [{ name: "main", current: true, ahead: 0, behind: 0, hasUpstream: true, upstream: "origin/main" }]),
      checkoutBranch: vi.fn(async () => ({ success: true })),
      stashPush: vi.fn(async () => ({ success: true })),
      listStashes: vi.fn(async () => [{ ref: "stash@{0}", createdAt: "2026-04-06T00:00:00.000Z", subject: "test stash" }]),
      stashApply: vi.fn(async () => ({ success: true })),
      stashPop: vi.fn(async () => ({ success: true })),
      stashDrop: vi.fn(async () => ({ success: true })),
      stashClear: vi.fn(async () => ({ success: true })),
    },
    diffService: {
      getChanges: vi.fn(async () => ({ unstaged: [], staged: [] }))
    },
    missionService: {
      addIntervention: vi.fn(({ missionId, title, body }: { missionId: string; title: string; body: string }) => ({
        id: "intervention-1",
        missionId,
        status: "open",
        title,
        body
      })),
      get: vi.fn((missionId: string) => ({
        id: missionId,
        prompt: "test mission",
        status: "running",
        laneId: "lane-1",
        interventions: []
      })),
      create: vi.fn(({ prompt }: any) => ({ id: "mission-new", prompt, status: "planned" })),
      resolveIntervention: vi.fn(({ missionId, interventionId, status }: any) => ({
        id: interventionId, missionId, status
      }))
    },
    ptyService: {
      create: vi.fn(async () => ({ ptyId: "pty-1", sessionId: "session-1" })),
      dispose: vi.fn()
    },
    testService: {
      run: vi.fn(async () => ({ id: "test-run-1", status: "running" })),
      listRuns: vi.fn(() => [{ id: "test-run-1", status: "running" }]),
      stop: vi.fn(),
      getLogTail: vi.fn(() => "")
    },
    issueInventoryService: (() => {
      const runtimeByPr = new Map<string, Record<string, unknown>>();
      const inventoryByPr = new Map<string, Record<string, unknown>>();
      const pipelineByPr = new Map<string, Record<string, unknown>>();

      const defaultRuntime = (prId: string) => ({
        prId,
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
        createdAt: "2026-03-17T19:00:00.000Z",
        updatedAt: "2026-03-17T19:00:00.000Z",
      });

      const defaultPipeline = () => ({
        autoMerge: false,
        mergeMethod: "repo_default",
        maxRounds: 5,
        onRebaseNeeded: "pause",
      });

      return {
        syncFromPrData: vi.fn((prId: string) => {
          const runtime = { ...defaultRuntime(prId), ...runtimeByPr.get(prId) };
          const existingSnapshot = inventoryByPr.get(prId) ?? null;
          const snapshot = {
            prId,
            items: existingSnapshot?.items ?? [],
            convergence: {
              currentRound: typeof runtime.currentRound === "number" ? runtime.currentRound : 0,
              maxRounds: { ...defaultPipeline(), ...pipelineByPr.get(prId) }.maxRounds,
              issuesPerRound: [],
              totalNew: 0,
              totalFixed: 0,
              totalDismissed: 0,
              totalEscalated: 0,
              totalSentToAgent: 0,
              isConverging: false,
              canAutoAdvance: false,
            },
            runtime,
          };
          inventoryByPr.set(prId, snapshot);
          return snapshot;
        }),
        getConvergenceRuntime: vi.fn((prId: string) => ({
          ...defaultRuntime(prId),
          ...runtimeByPr.get(prId),
        })),
        getPipelineSettings: vi.fn((prId: string) => ({
          ...defaultPipeline(),
          ...pipelineByPr.get(prId),
        })),
        getNewItems: vi.fn((_prId: string) => []),
        markSentToAgent: vi.fn(),
        resetInventory: vi.fn(),
        saveConvergenceRuntime: vi.fn((prId: string, state: Record<string, unknown>) => {
          const existing = runtimeByPr.get(prId) ?? {};
          const merged = { ...defaultRuntime(prId), ...existing, ...state };
          runtimeByPr.set(prId, merged);
          return merged;
        }),
        deletePipelineSettings: vi.fn(),
        savePipelineSettings: vi.fn((prId: string, settings: Record<string, unknown>) => {
          const existing = pipelineByPr.get(prId) ?? {};
          pipelineByPr.set(prId, { ...existing, ...settings });
        }),
      };
    })(),
    prService: {
      simulateIntegration: vi.fn(async () => ({ steps: [], conflicts: [], clean: true })),
      createQueuePrs: vi.fn(async () => ({ groupId: "group-1", prs: [] })),
      createIntegrationPr: vi.fn(async () => ({ prId: "pr-int-1", url: "https://github.com/pr/1" })),
      createFromLane: vi.fn(async () => ({ id: "pr-new", laneId: "lane-1", title: "New PR", status: "open" })),
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
    memoryService: {
      writeMemory: vi.fn(() => ({
        accepted: true,
        memory: {
          id: "memory-1",
          scope: "project",
          status: "candidate",
          tier: 3,
          category: "fact",
          content: "x",
          importance: "medium",
          confidence: 0.6,
          promotedAt: null,
          sourceRunId: null,
          createdAt: new Date().toISOString()
        },
        deduped: false,
        mergedIntoId: null,
        reason: null,
      })),
      addSharedFact: vi.fn(() => ({
        id: "shared-fact-1"
      })),
      pinMemory: vi.fn(() => ({
        id: "memory-1",
        pinned: true,
        tier: 1
      })),
      promoteMemory: vi.fn(),
      searchMemories: vi.fn(() => [])
    } as any,
    ctoStateService: {
      getIdentity: vi.fn(() => ({
        name: "CTO",
        version: 1,
        persona: "test",
        modelPreferences: { provider: "codex", model: "gpt-5.4-codex", modelId: "openai/gpt-5.4-codex" },
        memoryPolicy: {
          autoCompact: true,
          compactionThreshold: 0.7,
          preCompactionFlush: true,
          temporalDecayHalfLifeDays: 30
        },
        updatedAt: new Date().toISOString()
      })),
      getSnapshot: vi.fn((recentLimit = 10) => ({
        identity: {
          name: "CTO",
          version: 1,
          persona: "test",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30
          },
          updatedAt: new Date().toISOString()
        },
        coreMemory: {
          version: 3,
          updatedAt: "2026-03-05T12:00:00.000Z",
          projectSummary: "summary",
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: []
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
        recentSubordinateActivity: [],
      })),
      updateCoreMemory: vi.fn((patch: Record<string, unknown>) => ({
        identity: {
          name: "CTO",
          version: 1,
          persona: "test",
          modelPreferences: { provider: "claude", model: "sonnet" },
          memoryPolicy: {
            autoCompact: true,
            compactionThreshold: 0.7,
            preCompactionFlush: true,
            temporalDecayHalfLifeDays: 30
          },
          updatedAt: new Date().toISOString()
        },
        coreMemory: {
          version: 3,
          updatedAt: "2026-03-05T12:00:00.000Z",
          projectSummary: String((patch as { projectSummary?: unknown }).projectSummary ?? "summary"),
          criticalConventions: [],
          userPreferences: [],
          activeFocus: [],
          notes: []
        },
        recentSessions: []
      }))
    } as any,
    workerAgentService: {
      updateCoreMemory: vi.fn((patch: Record<string, unknown>) => ({
        version: 4,
        updatedAt: "2026-03-05T13:00:00.000Z",
        projectSummary: String((patch as { projectSummary?: unknown }).projectSummary ?? "worker-summary"),
        criticalConventions: [],
        userPreferences: [],
        activeFocus: Array.isArray((patch as { activeFocus?: unknown }).activeFocus)
          ? (patch as { activeFocus: string[] }).activeFocus
          : [],
        notes: []
      }))
    } as any,
    flowPolicyService: {
      getPolicy: vi.fn(() => ({ workflows: [], legacyConfig: { projects: [] } })),
      savePolicy: vi.fn((policy: Record<string, unknown>) => policy),
    } as any,
    linearDispatcherService: {
      listActiveRuns: vi.fn(() => [{ id: "run-active", status: "in_progress" }]),
      listQueue: vi.fn(() => [{ id: "run-queued", status: "queued" }]),
      getRunDetail: vi.fn(async (runId: string) => ({ run: { id: runId, status: "queued" }, issue: { id: "issue-1" } })),
      resolveRunAction: vi.fn(async (runId: string, action: string) => ({ id: runId, status: action })),
      cancelRun: vi.fn(async () => {}),
    } as any,
    linearIssueTracker: {
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
      createComment: vi.fn(async () => ({ id: "comment-1" })),
      fetchWorkflowStates: vi.fn(async () => [{ id: "state-done", name: "Done" }]),
      updateIssueState: vi.fn(async () => {}),
    } as any,
    linearSyncService: {
      getDashboard: vi.fn(() => ({ enabled: true, running: false, ingressMode: "webhook-first", reconciliationIntervalSec: 60, lastPollAt: null, lastSuccessAt: null, lastError: null, queue: { queued: 1, blocked: 0, failed: 0 }, workflowRuns: { active: 1, waiting: 0 }, recentIssues: [] })),
      runSyncNow: vi.fn(async () => ({ enabled: true, running: false, ingressMode: "webhook-first", reconciliationIntervalSec: 60, lastPollAt: "2026-03-17T19:11:00.000Z", lastSuccessAt: "2026-03-17T19:11:00.000Z", lastError: null, queue: { queued: 0, blocked: 0, failed: 0 }, workflowRuns: { active: 1, waiting: 0 }, recentIssues: [] })),
      listQueue: vi.fn(() => [{ id: "run-queued", status: "queued" }]),
      resolveQueueItem: vi.fn(async ({ queueItemId, action, employeeOverride, laneId }: { queueItemId: string; action: string; employeeOverride?: string; laneId?: string }) => ({ id: queueItemId, status: action, employeeOverride: employeeOverride ?? null, laneId: laneId ?? null })),
      getRunDetail: vi.fn(async ({ runId }: { runId: string }) => ({ run: { id: runId, status: "queued" }, issue: { id: "issue-1" } })),
    } as any,
    linearIngressService: {
      getStatus: vi.fn(() => ({ configured: true, relayUrl: "https://example.com/webhook", webhookUrl: "https://example.com/webhook", lastReceivedAt: null, lastError: null })),
      listRecentEvents: vi.fn(() => [{ id: "event-1", source: "webhook", summary: "received", createdAt: "2026-03-17T19:11:00.000Z" }]),
      ensureRelayWebhook: vi.fn(async () => {}),
    } as any,
    linearRoutingService: {
      simulateRoute: vi.fn(({ issue }: { issue: Record<string, unknown> }) => ({ decision: "cto", reason: "test", issue })),
    } as any,
    processService: null,
    computerUseArtifactBrokerService: {
      getBackendStatus: vi.fn(() => ({ backends: [] })),
      listArtifacts: vi.fn(() => []),
      ingest: vi.fn(() => ({ artifacts: [] })),
    } as any,
    orchestratorService: {
      listRuns: vi.fn(() => []),
      pauseRun: vi.fn(({ runId }: any) => ({ id: runId, status: "paused" })),
      resumeRun: vi.fn(({ runId }: any) => ({ id: runId, status: "running" })),
      getRunGraph: vi.fn(({ runId }: any) => ({
        run: { id: runId, missionId: "mission-1", status: "running" },
        steps: [{ id: "step-1", stepKey: "step-a", laneId: "lane-1", status: "completed" }],
        attempts: [{ id: "attempt-1", stepId: "step-1", status: "completed" }],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [{ id: "tl-1", runId, eventType: "step_started", reason: "started" }],
        runtimeEvents: [],
        completionEvaluation: { complete: true }
      })),
      listTimeline: vi.fn(({ runId }: any) => [
        { id: "tl-1", runId, stepId: null, eventType: "run_started", reason: "started" },
        { id: "tl-2", runId, stepId: "step-1", eventType: "step_started", reason: "started" }
      ]),
      listAttempts: vi.fn(() => []),
      addSteps: vi.fn(({ steps }: { steps: Array<Record<string, unknown>> }) =>
        steps.map((step, index) => ({
          id: `step-created-${index + 1}`,
          runId: "run-1",
          missionStepId: null,
          stepKey: String(step.stepKey ?? `step-created-${index + 1}`),
          stepIndex: Number(step.stepIndex ?? index),
          title: String(step.title ?? "Created step"),
          laneId: typeof step.laneId === "string" ? step.laneId : null,
          status: "pending",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: null,
          completedAt: null,
          metadata: step.metadata ?? {}
        }))
      ),
      createHandoff: vi.fn(),
      startReadyAutopilotAttempts: vi.fn(async () => 0),
      skipStep: vi.fn(),
      completeAttempt: vi.fn(),
      updateStepMetadata: vi.fn(),
      supersedeStep: vi.fn(),
      updateStepDependencies: vi.fn(),
      appendRuntimeEvent: vi.fn(),
      appendTimelineEvent: vi.fn(),
      emitRuntimeUpdate: vi.fn(),
      listRetrospectives: vi.fn(() => [
        {
          id: "retro:run-1",
          missionId: "mission-1",
          runId: "run-1",
          generatedAt: new Date().toISOString(),
          schemaVersion: 1,
          finalStatus: "succeeded",
          wins: [],
          failures: [],
          unresolvedRisks: [],
          followUpActions: [],
          topPainPoints: [],
          topImprovements: [],
          patternsToCapture: [],
          estimatedImpact: "n/a",
          changelog: []
        }
      ]),
      listRetrospectiveTrends: vi.fn(() => [
        {
          id: "trend-1",
          projectId: "project-1",
          missionId: "mission-1",
          runId: "run-1",
          retrospectiveId: "retro:run-1",
          sourceMissionId: "mission-0",
          sourceRunId: "run-0",
          sourceRetrospectiveId: "retro:run-0",
          painPointKey: "slow-tests",
          painPointLabel: "Slow tests",
          status: "still_open",
          previousPainScore: 2,
          currentPainScore: 2,
          createdAt: new Date().toISOString()
        }
      ]),
      listRetrospectivePatternStats: vi.fn(() => [
        {
          id: "pattern-stat-1",
          projectId: "project-1",
          patternKey: "slow-tests",
          patternLabel: "Slow tests",
          occurrenceCount: 2,
          firstSeenRetrospectiveId: "retro:run-0",
          firstSeenRunId: "run-0",
          lastSeenRetrospectiveId: "retro:run-1",
          lastSeenRunId: "run-1",
          promotedMemoryId: "memory-candidate-1",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }
      ]),
      addReflection: vi.fn((input: any) => ({
        id: "reflection-1",
        projectId: "project-1",
        missionId: input.missionId,
        runId: input.runId,
        stepId: input.stepId ?? null,
        attemptId: input.attemptId ?? null,
        agentRole: input.agentRole,
        phase: input.phase,
        signalType: input.signalType,
        observation: input.observation,
        recommendation: input.recommendation ?? "",
        context: input.context ?? "",
        occurredAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        schemaVersion: 1
      }))
    } as any,
    aiOrchestratorService: {
      startMissionRun: vi.fn(async ({ missionId }: any) => ({
        started: { run: { id: "run-1", missionId, status: "running" }, steps: [] },
        mission: { id: missionId }
      })),
      finalizeRun: vi.fn(() => ({ finalized: true, blockers: [], finalStatus: "succeeded" })),
      cancelRunGracefully: vi.fn(async ({ runId }: any) => ({ cancelled: true, runId })),
      steerMission: vi.fn(({ missionId }: any) => ({ acknowledged: true, appliedAt: new Date().toISOString() })),
      getWorkerStates: vi.fn(({ runId }: any) => [
        { attemptId: "a-1", stepId: "s-1", runId, state: "running" }
      ]),
      getMissionMetrics: vi.fn(({ missionId }: any) => ({ missionId, samples: [] })),
      getTeamMembers: vi.fn(() => teamMembers),
      listChatThreads: vi.fn(({ missionId }: any) =>
        threadRows.filter((thread) => thread.missionId === missionId)
      ),
      getThreadMessages: vi.fn(({ threadId, limit }: any) => {
        const entries = threadMessages.get(String(threadId)) ?? [];
        const max = typeof limit === "number" ? Math.max(1, Math.floor(limit)) : entries.length;
        return entries.slice(-max);
      }),
      sendAgentMessage: vi.fn(({ missionId, fromAttemptId, toAttemptId, content, metadata }: any) => {
        const sourceThread = ensureThread({ missionId, attemptId: String(fromAttemptId), runId: "run-1" });
        const targetThread = ensureThread({ missionId, attemptId: String(toAttemptId), runId: "run-1" });
        const timestamp = new Date().toISOString();
        const sourceEntry = {
          id: `msg-${++messageCounter}`,
          role: "agent",
          content,
          timestamp,
          threadId: sourceThread.id,
          attemptId: fromAttemptId,
          target: { targetAttemptId: toAttemptId },
          metadata: metadata ?? null
        };
        const deliveryEntry = {
          id: `msg-${++messageCounter}`,
          role: "agent",
          content,
          timestamp,
          threadId: targetThread.id,
          attemptId: fromAttemptId,
          target: { targetAttemptId: toAttemptId },
          metadata: { ...(metadata ?? {}), interAgentDelivery: true }
        };
        appendThreadMessage(String(sourceThread.id), sourceEntry);
        appendThreadMessage(String(targetThread.id), deliveryEntry);
        return sourceEntry;
      }),
      dispose: vi.fn()
    } as any,
    eventBuffer: {
      push: vi.fn(),
      drain: vi.fn((cursor: number, limit?: number) => ({
        events: [
          { id: cursor + 1, timestamp: new Date().toISOString(), category: "orchestrator", payload: { type: "test" } }
        ],
        nextCursor: cursor + 1,
        hasMore: false
      })),
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

async function initialize(handler: ReturnType<typeof createAdeRpcRequestHandler>, identity?: Record<string, unknown>) {
  const requestedRole = typeof identity?.role === "string" ? identity.role : null;
  const validRole = requestedRole === "cto"
    || requestedRole === "orchestrator"
    || requestedRole === "agent"
    || requestedRole === "external"
    || requestedRole === "evaluator";
  const previousRole = process.env.ADE_DEFAULT_ROLE;
  const shouldInjectRole = previousRole == null && validRole;
  if (shouldInjectRole && requestedRole) {
    process.env.ADE_DEFAULT_ROLE = requestedRole;
  }
  try {
    await handler({
      jsonrpc: "2.0",
      id: 1,
      method: "ade/initialize",
      params: identity ? { identity } : {}
    });
  } finally {
    if (shouldInjectRole) {
      delete process.env.ADE_DEFAULT_ROLE;
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

describe("adeRpcServer", () => {
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
      expect(names).not.toContain("read_mission_status");
      expect(names).not.toContain("get_cto_state");
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });

  it("lists the full tool surface including coordinator orchestration tools for orchestrator callers", async () => {
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
        "memory_add",
        "memory_pin",
        "memory_update_core",
        "reflection_add",
        "memory_search",
        "get_environment_info",
        "launch_app",
        "interact_gui",
        "screenshot_environment",
        "record_environment",
        "run_tests",
        "get_lane_status",
        "list_lanes",
        "commit_changes",
        "create_mission",
        "start_mission",
        "pause_mission",
        "resume_mission",
        "cancel_mission",
        "steer_mission",
        "resolve_intervention",
        "get_mission",
        "get_run_graph",
        "stream_events",
        "get_step_output",
        "get_worker_states",
        "get_timeline",
        "list_retrospectives",
        "list_reflection_trends",
        "list_reflection_pattern_stats",
        "get_mission_metrics",
        "get_final_diff",
        "evaluate_run",
        "list_evaluations",
        "get_evaluation_report",
        "spawn_worker",
        "delegate_parallel",
        "read_mission_status",
        "revise_plan",
        "retry_step",
        "skip_step",
        "message_worker",
        "report_status",
        "report_result",
        "report_validation",
        "update_tool_profiles",
        "transfer_lane",
        "request_specialist",
        "read_file",
        "search_files",
        "get_project_context"
      ])
    );
    expect(names.length).toBeGreaterThan(38);
  });

  it("shows agent-safe delegation, reporting, and observation coordinator tools to agent callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "worker-1",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1",
      stepId: "step-1",
      attemptId: "attempt-1"
    });

    const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;
    const names = (result.actions ?? []).map((tool: any) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "commit_changes",
        "rebase_lane",
        "stash_push",
        "list_stashes",
        "stash_apply",
        "stash_pop",
        "stash_drop",
        "stash_clear",
        "report_status",
        "report_result",
        "report_validation",
        "delegate_to_subagent",
        "delegate_parallel",
        "get_worker_output",
        "list_workers",
        "read_mission_status",
        "read_mission_state",
        "list_tasks",
        "get_budget_status",
        "get_project_context",
      ])
    );
    expect(names).not.toEqual(
      expect.arrayContaining([
        "spawn_worker",
        "revise_plan",
        "request_specialist",
        "set_current_phase",
        "message_worker",
        "update_tool_profiles",
      ])
    );
  });

  it("hides ADE spawn and mission-worker tools from standalone chat callers", async () => {
    await withEnv({ ADE_DEFAULT_ROLE: "agent", ADE_CHAT_SESSION_ID: "chat-1" }, async () => {
      const { runtime } = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "chat-1", role: "agent" });
      const result = (await handler({ jsonrpc: "2.0", id: 3, method: "ade/actions/list" })) as any;
      const names = (result.actions ?? []).map((tool: any) => tool.name);

      expect(names).toEqual(
        expect.arrayContaining([
          "ask_user",
          "memory_search",
          "memory_add",
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
      expect(names).not.toContain("read_mission_status");
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
        "listChats",
        "spawnChat",
        "getChatStatus",
        "readChatTranscript",
        "get_pr_health",
        "pr_get_checks",
        "pr_get_review_comments",
        "pr_refresh_issue_inventory",
        "pr_rerun_failed_checks",
        "pr_reply_to_review_thread",
        "pr_resolve_review_thread",
        "listLinearWorkflows",
        "getLinearRunStatus",
        "getLinearSyncDashboard",
        "runLinearSyncNow",
        "listLinearSyncQueue",
        "getLinearIngressStatus",
      ]),
    );
    expect(names).not.toContain("spawn_worker");
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

  it("returns the Linear sync dashboard for cto callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "getLinearSyncDashboard", {});

    expect((runtime.linearSyncService as any).getDashboard).toHaveBeenCalled();
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        enabled: true,
        ingressMode: "webhook-first",
      }),
    );
  });

  it("forwards employeeOverride and laneId when resuming a Linear sync queue item", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const result = await callTool(handler, "resolveLinearSyncQueueItem", {
      queueItemId: "run-queued",
      action: "resume",
      employeeOverride: "agent:worker-1",
      laneId: "lane-2",
    });

    expect((runtime.linearSyncService as any).resolveQueueItem).toHaveBeenCalledWith(
      expect.objectContaining({
        queueItemId: "run-queued",
        action: "resume",
        employeeOverride: "agent:worker-1",
        laneId: "lane-2",
      }),
    );
    expect(result.structuredContent).toEqual(
      expect.objectContaining({
        id: "run-queued",
        status: "resume",
        employeeOverride: "agent:worker-1",
        laneId: "lane-2",
      }),
    );
  });

  it("rejects unsupported Linear sync queue actions", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "cto-1", role: "cto" });
    const response = await callTool(handler, "resolveLinearSyncQueueItem", {
      queueItemId: "run-queued",
      action: "ship-it",
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "action must be one of: approve, reject, retry, complete, resume",
    );
    expect((runtime.linearSyncService as any).resolveQueueItem).not.toHaveBeenCalled();
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

  it("lets agent callers use safe mission observation coordinator tools", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [],
        attempts: [],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false }
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-1",
        attemptId: "attempt-1"
      });

      const response = await callTool(handler, "read_mission_status", {});

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(response.structuredContent.runId).toBe("run-1");
    });
  });

  it("rejects coordinator-only tool calls from agent callers before coordinator dispatch", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const { runtime } = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-1",
        attemptId: "attempt-1"
      });

      const response = await callTool(handler, "spawn_worker", {
        name: "implementation-worker",
        prompt: "Do work"
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("Unsupported tool: spawn_worker");
    });
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

  it("lets agent callers delegate nested work only beneath their own worker", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [{ id: "step-1", stepKey: "step-a", laneId: "lane-1", status: "running", metadata: {} }],
        attempts: [{ id: "attempt-1", stepId: "step-1", status: "running" }],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false }
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-1",
        attemptId: "attempt-1"
      });

      const response = await callTool(handler, "delegate_parallel", {
        tasks: [
          { name: "child-1", prompt: "Handle the first child task.", modelId: "openai/gpt-5.3-codex" },
          { name: "child-2", prompt: "Handle the second child task.", modelId: "openai/gpt-5.3-codex" },
        ]
      });

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(response.structuredContent.parentWorkerId).toBe("step-a");
      expect(response.structuredContent.total).toBe(2);
    });
  });

  it("rejects agent delegation attempts that target another worker", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [
          { id: "step-1", stepKey: "step-a", laneId: "lane-1", status: "running", metadata: {} },
          { id: "step-2", stepKey: "step-b", laneId: "lane-1", status: "running", metadata: {} },
        ],
        attempts: [{ id: "attempt-1", stepId: "step-1", status: "running" }],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false }
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-1",
        attemptId: "attempt-1"
      });

      const response = await callTool(handler, "delegate_to_subagent", {
        parentWorkerId: "step-b",
        name: "rogue-child",
        prompt: "Try to escape the current worker scope."
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
        "may only delegate beneath its own worker 'step-a'"
      );
    });
  });

  it("still routes coordinator-only tool calls for orchestrator callers", async () => {
    const { runtime } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "coord-1", role: "orchestrator" });
    const response = await callTool(handler, "spawn_worker", {
      name: "implementation-worker",
      prompt: "Do work"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("requires run context");
  });

  it("spawns workers for active runs when project and workspace roots differ", async () => {
    await withEnv({ ADE_MISSION_ID: "mission-1", ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-runtime-workspace-"));
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(({ runId }: any) => ({
        run: {
          id: runId,
          missionId: "mission-1",
          status: "running",
          metadata: {
            phaseOverride: [
              {
                id: "phase-planning",
                phaseKey: "planning",
                name: "Planning",
                position: 0,
                instructions: "Plan first.",
                model: { modelId: "anthropic/claude-sonnet-4-6" },
                budget: {},
                askQuestions: { enabled: true, maxQuestions: 3 },
                validationGate: { tier: "none", required: false },
                orderingConstraints: { mustBeFirst: true },
              },
            ],
            phaseRuntime: {
              currentPhaseKey: "planning",
              currentPhaseName: "Planning",
              currentPhaseModel: {
                modelId: "anthropic/claude-sonnet-4-6",
              },
            },
          },
        },
        steps: [],
        attempts: [],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false },
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "coord-1",
        role: "orchestrator",
        missionId: "mission-1",
        runId: "run-from-identity",
      });

      const response = await callTool(handler, "spawn_worker", {
        name: "planning-worker",
        prompt: "Research the codebase and propose a plan.",
        laneId: "lane-1",
      });

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent).toMatchObject({
        ok: true,
        name: "planning-worker",
      });
      expect(fixture.runtime.projectRoot).not.toBe(fixture.runtime.workspaceRoot);
      expect(JSON.stringify(response.structuredContent ?? {})).not.toContain("Run not found");
    });
  });

  it("falls back to env orchestrator role when initialize sends an unknown role", async () => {
    const fixture = createRuntime();
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    const previousMissionId = process.env.ADE_MISSION_ID;
    const previousRunId = process.env.ADE_RUN_ID;
    process.env.ADE_DEFAULT_ROLE = "orchestrator";
    process.env.ADE_MISSION_ID = "mission-1";
    process.env.ADE_RUN_ID = "run-1";
    try {
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [],
        attempts: [],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false }
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "coord-1", role: "assistant" as any });
      const response = await callTool(handler, "read_mission_status", {});

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(response.structuredContent.runId).toBe("run-1");
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
      if (previousMissionId == null) delete process.env.ADE_MISSION_ID;
      else process.env.ADE_MISSION_ID = previousMissionId;
      if (previousRunId == null) delete process.env.ADE_RUN_ID;
      else process.env.ADE_RUN_ID = previousRunId;
    }
  });

  it("keeps env orchestrator role even when initialize requests agent", async () => {
    const fixture = createRuntime();
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    const previousMissionId = process.env.ADE_MISSION_ID;
    const previousRunId = process.env.ADE_RUN_ID;
    process.env.ADE_DEFAULT_ROLE = "orchestrator";
    process.env.ADE_MISSION_ID = "mission-1";
    process.env.ADE_RUN_ID = "run-1";
    try {
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [],
        attempts: [],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false }
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "coord-1", role: "agent" as any });
      const response = await callTool(handler, "read_mission_status", {});

      expect(response.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(response.structuredContent.runId).toBe("run-1");
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
      if (previousMissionId == null) delete process.env.ADE_MISSION_ID;
      else process.env.ADE_MISSION_ID = previousMissionId;
      if (previousRunId == null) delete process.env.ADE_RUN_ID;
      else process.env.ADE_RUN_ID = previousRunId;
    }
  });

  it("does not let env agent sessions escalate to orchestrator tools", async () => {
    const fixture = createRuntime();
    const previousRole = process.env.ADE_DEFAULT_ROLE;
    const previousMissionId = process.env.ADE_MISSION_ID;
    const previousRunId = process.env.ADE_RUN_ID;
    const previousStepId = process.env.ADE_STEP_ID;
    const previousAttemptId = process.env.ADE_ATTEMPT_ID;
    process.env.ADE_DEFAULT_ROLE = "agent";
    process.env.ADE_MISSION_ID = "mission-1";
    process.env.ADE_RUN_ID = "run-1";
    process.env.ADE_STEP_ID = "step-1";
    process.env.ADE_ATTEMPT_ID = "attempt-1";
    try {
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "worker-1", role: "orchestrator" as any });
      const response = await callTool(handler, "spawn_worker", {
        name: "rogue-worker",
        prompt: "Try to escape worker scope",
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("Unsupported tool: spawn_worker");
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
      if (previousMissionId == null) delete process.env.ADE_MISSION_ID;
      else process.env.ADE_MISSION_ID = previousMissionId;
      if (previousRunId == null) delete process.env.ADE_RUN_ID;
      else process.env.ADE_RUN_ID = previousRunId;
      if (previousStepId == null) delete process.env.ADE_STEP_ID;
      else process.env.ADE_STEP_ID = previousStepId;
      if (previousAttemptId == null) delete process.env.ADE_ATTEMPT_ID;
      else process.env.ADE_ATTEMPT_ID = previousAttemptId;
    }
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

      expect(response.capabilities?.actions).toBeTruthy();
      expect(response.capabilities?.resources).toBeUndefined();
    } finally {
      if (previousRole == null) delete process.env.ADE_DEFAULT_ROLE;
      else process.env.ADE_DEFAULT_ROLE = previousRole;
    }
  });

  it("routes reflection_add and uses initialize identity fallback", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-1",
        attemptId: "attempt-1"
      });

      const response = await callTool(handler, "reflection_add", {
        signalType: "frustration",
        agentRole: "implementer",
        phase: "development",
        observation: "Typecheck takes too long for small edits",
        recommendation: "Cache incremental build artifacts",
        context: "Running npm run typecheck repeatedly",
        occurredAt: "2026-03-05T01:23:45.000Z"
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.orchestratorService.addReflection).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: "mission-1",
          runId: "run-1",
          stepId: "step-1",
          attemptId: "attempt-1",
          signalType: "frustration",
        })
      );
      expect(response.structuredContent.reflection.id).toBe("reflection-1");
    });
  });

  it("rejects reflection_add payloads missing strict fields", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
      });

      const response = await callTool(handler, "reflection_add", {
        signalType: "idea",
        agentRole: "implementer",
        phase: "development",
        observation: "Need a faster test target",
        recommendation: "Split unit and integration suites",
        context: "running test command"
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.structuredContent ?? {})).toContain("occurredAt");
    });
  });

  it("lists retrospectives, trends, and pattern stats with caller-context fallback", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
      });

      const retrospectivesResponse = await callTool(handler, "list_retrospectives", {});
      expect(retrospectivesResponse?.isError).toBeUndefined();
      expect(fixture.runtime.orchestratorService.listRetrospectives).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: "mission-1" })
      );
      expect(Array.isArray(retrospectivesResponse.structuredContent.retrospectives)).toBe(true);

      const trendsResponse = await callTool(handler, "list_reflection_trends", {});
      expect(trendsResponse?.isError).toBeUndefined();
      expect(fixture.runtime.orchestratorService.listRetrospectiveTrends).toHaveBeenCalledWith(
        expect.objectContaining({ missionId: "mission-1", runId: "run-1" })
      );
      expect(Array.isArray(trendsResponse.structuredContent.trends)).toBe(true);

      const patternStatsResponse = await callTool(handler, "list_reflection_pattern_stats", {});
      expect(patternStatsResponse?.isError).toBeUndefined();
      expect(fixture.runtime.orchestratorService.listRetrospectivePatternStats).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 })
      );
      expect(Array.isArray(patternStatsResponse.structuredContent.patternStats)).toBe(true);
    });
  });

  it("routes spawn_agent to lane-scoped tracked pty sessions", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      prompt: "Implement API wiring",
      title: "Orchestrator Spawn"
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ptyService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        laneId: "lane-1",
        cols: 120,
        rows: 36,
        tracked: true,
        toolType: "claude-orchestrated"
      })
    );
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("--model");
    expect(response.structuredContent.startupCommand).toContain("--permission-mode");
    expect(response.structuredContent.permissionMode).toBe("edit");
    expect(response.structuredContent.contextRef?.path).toBeNull();
  });

  it("starts spawn_agent without writing an attached ADE server config", async () => {
    const fixture = createRuntime();
    fixture.runtime.workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cli-spawn-workspace-"));
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "orchestrator", runId: "run-from-identity" });
    const response = await callTool(handler, "spawn_agent", {
      laneId: "lane-1",
      provider: "claude",
      model: "claude-sonnet-4-6",
      prompt: "Implement API wiring",
      title: "Orchestrator Spawn",
      runId: "run-1",
      attemptId: "attempt-workspace-roots"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.startupCommand).toContain("claude");
    expect(response.structuredContent.startupCommand).toContain("ADE_RUN_ID=run-1");
    expect(response.structuredContent.startupCommand).toContain("ADE_ATTEMPT_ID=attempt-workspace-roots");
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
      model: "claude-sonnet-4-6",
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

  it("routes coordinator report_status via ADE RPC and mutates run metadata through coordinator tools", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
        steps: [
          {
            id: "step-worker-1",
            runId: "run-1",
            missionStepId: null,
            stepKey: "worker-1",
            stepIndex: 0,
            title: "Worker 1",
            laneId: "lane-1",
            status: "running",
            joinPolicy: "all_success",
            quorumCount: null,
            dependencyStepIds: [],
            retryLimit: 1,
            retryCount: 0,
            lastAttemptId: null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            startedAt: new Date().toISOString(),
            completedAt: null,
            metadata: {}
          }
        ],
        attempts: [],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: null
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "coord-1", role: "orchestrator", missionId: "mission-1", runId: "run-from-identity" });
      const response = await callTool(handler, "report_status", {
        workerId: "worker-1",
        progressPct: 45,
        blockers: [],
        confidence: 0.82,
        nextAction: "continue implementation",
        laneId: "lane-1",
        details: "working through API edge cases"
      });

      expect(response?.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(fixture.runtime.orchestratorService.updateStepMetadata).toHaveBeenCalled();
      expect(fixture.runtime.orchestratorService.appendRuntimeEvent).toHaveBeenCalled();
    });
  });

  it("forwards sub-agent report_status updates to parent and emits worker_status_reported runtime events", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        },
        {
          id: "step-child",
          runId: "run-1",
          missionStepId: null,
          stepKey: "child-worker",
          stepIndex: 1,
          title: "Child Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-child",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {
            isSubAgent: true,
            parentWorkerId: "parent-worker"
          }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() },
        { id: "attempt-child", stepId: "step-child", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "attempt-child",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-child",
        attemptId: "attempt-child"
      });
      const response = await callTool(handler, "report_status", {
        workerId: "child-worker",
        progressPct: 45,
        blockers: [],
        confidence: 0.8,
        nextAction: "Continue implementation",
        laneId: "lane-1"
      });

      expect(response?.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
        expect.objectContaining({
          category: "runtime",
          payload: expect.objectContaining({
            type: "worker_status_reported",
            runId: "run-1",
            reason: "report_status"
          })
        })
      );
      expect(fixture.runtime.aiOrchestratorService.sendAgentMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          missionId: "mission-1",
          fromAttemptId: "attempt-child",
          toAttemptId: "attempt-parent",
          content: expect.stringContaining("[sub-agent:Child Worker]"),
          metadata: expect.objectContaining({
            source: "subagent_status_rollup",
            parentWorkerId: "parent-worker"
          })
        })
      );
    });
  });

  it("auto-registers unknown native callers as claude-native teammates under the parent worker", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: {
        id: "run-1",
        missionId: "mission-1",
        status: "running",
        metadata: { autopilot: { parallelismCap: 6 } }
      },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: { modelId: "anthropic/claude-sonnet-4-6" }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "native-worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });
      const response = await callTool(handler, "report_status", {
        workerId: "parent-worker",
        progressPct: 10,
        blockers: [],
        confidence: 0.7,
        nextAction: "Running native sub-task"
      });

      expect(response?.isError).toBeUndefined();
      expect(response.structuredContent.ok).toBe(true);
      const insertCall = fixture.runtime.db.run.mock.calls.find((call: any[]) =>
        String(call[0] ?? "").toLowerCase().includes("insert into orchestrator_team_members")
      );
      expect(insertCall).toBeTruthy();
      const metadataJson = String(insertCall?.[1]?.[9] ?? "{}");
      const metadata = JSON.parse(metadataJson);
      expect(metadata).toMatchObject({
        source: "claude-native",
        parentWorkerId: "parent-worker",
        parentStepId: "step-parent",
        nativeCallerId: "native-worker-1"
      });
    });
  });

  it("blocks unknown native reports when parent allocation cap is exceeded", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.aiOrchestratorService.getTeamMembers = vi.fn(() => [
      { id: "native-1", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-2", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-3", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } },
      { id: "native-4", source: "claude-native", parentWorkerId: "parent-worker", status: "active", metadata: { source: "claude-native", parentWorkerId: "parent-worker" } }
    ]);
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "native-worker-over-cap",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });
      const response = await callTool(handler, "report_status", {
        workerId: "parent-worker",
        progressPct: 30,
        blockers: [],
        confidence: 0.6,
        nextAction: "Still running"
      });

      expect(response.isError).toBe(true);
      expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain("allocation cap exceeded");
      const insertCalls = fixture.runtime.db.run.mock.calls.filter((call: any[]) =>
        String(call[0] ?? "").toLowerCase().includes("insert into orchestrator_team_members")
      );
      expect(insertCalls).toHaveLength(0);
    });
  });

  it("surfaces forwarded status rollups through get_pending_messages for parent workers", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        },
        {
          id: "step-child",
          runId: "run-1",
          missionStepId: null,
          stepKey: "child-worker",
          stepIndex: 1,
          title: "Child Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-child",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {
            isSubAgent: true,
            parentWorkerId: "parent-worker"
          }
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() },
        { id: "attempt-child", stepId: "step-child", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));

      const childHandler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(childHandler, {
        callerId: "attempt-child",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-child",
        attemptId: "attempt-child"
      });
      const statusResponse = await callTool(childHandler, "report_status", {
        workerId: "child-worker",
        progressPct: 60,
        blockers: [],
        confidence: 0.84,
        nextAction: "Finalize patch set"
      });
      expect(statusResponse?.isError).toBeUndefined();

      const parentHandler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(parentHandler, {
        callerId: "attempt-parent",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });
      const pending = await callTool(parentHandler, "get_pending_messages", {});

      expect(pending?.isError).toBeUndefined();
      expect(pending.structuredContent.workerAttemptId).toBe("attempt-parent");
      expect(pending.structuredContent.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "agent",
            content: expect.stringContaining("[sub-agent:Child Worker]"),
            metadata: expect.objectContaining({
              source: "subagent_status_rollup"
            })
          })
        ])
      );
    });
  });

  it("surfaces native terminal rollups through get_pending_messages after report_result", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));

      const nativeHandler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(nativeHandler, {
        callerId: "native-worker-result",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });
      const resultResponse = await callTool(nativeHandler, "report_result", {
        workerId: "parent-worker",
        outcome: "succeeded",
        summary: "Native child done.",
        artifacts: [],
        filesChanged: [],
        testsRun: null
      });
      expect(resultResponse?.isError).toBeUndefined();

      const parentHandler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(parentHandler, {
        callerId: "attempt-parent",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });
      const pending = await callTool(parentHandler, "get_pending_messages", {});

      expect(pending?.isError).toBeUndefined();
      expect(pending.structuredContent.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "agent",
            content: expect.stringContaining("completed (succeeded): Native child done."),
            metadata: expect.objectContaining({
              source: "subagent_result_rollup"
            })
          })
        ])
      );
    });
  });

  it("infers workerId for report_result from initialized worker identity", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running", metadata: {} },
      steps: [
        {
          id: "step-parent",
          runId: "run-1",
          missionStepId: null,
          stepKey: "parent-worker",
          stepIndex: 0,
          title: "Parent Worker",
          laneId: "lane-1",
          status: "running",
          joinPolicy: "all_success",
          quorumCount: null,
          dependencyStepIds: [],
          retryLimit: 1,
          retryCount: 0,
          lastAttemptId: "attempt-parent",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          startedAt: new Date().toISOString(),
          completedAt: null,
          metadata: {}
        }
      ],
      attempts: [
        { id: "attempt-parent", stepId: "step-parent", status: "running", createdAt: new Date().toISOString() }
      ],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: null
    }));

      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
      await initialize(handler, {
        callerId: "attempt-parent",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-parent",
        attemptId: "attempt-parent"
      });

      const response = await callTool(handler, "report_result", {
        outcome: "succeeded",
        summary: "Finished without explicitly sending workerId.",
        artifacts: [],
        filesChanged: [],
        testsRun: null
      });

      expect(response?.isError).toBeUndefined();
      expect(response.structuredContent).toEqual(expect.objectContaining({
        ok: true,
        report: expect.objectContaining({
          workerId: "parent-worker",
          stepId: "step-parent",
          outcome: "succeeded",
        }),
      }));
    });
  });

  it("uses trusted env run context for shared-fact writes instead of initialize payload runId", async () => {
    await withEnv({ ADE_RUN_ID: "run-from-env" }, async () => {
      const fixture = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-from-identity",
        attemptId: "attempt-from-identity"
      });
      const response = await callTool(handler, "memory_add", {
        content: "Cache layer requires warm-up before benchmark runs.",
        category: "fact",
        importance: "high"
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.memoryService.writeMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: "mission",
          scopeOwnerId: "run-from-env",
          status: "candidate",
          tier: 3,
          confidence: 0.6,
        })
      );
      expect(fixture.runtime.memoryService.addSharedFact).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-from-env",
          stepId: "step-from-identity",
        })
      );
      expect(response.structuredContent.memory).toEqual(
        expect.objectContaining({
          written: true,
          durability: "candidate",
          tier: 3,
        })
      );
      expect(response.structuredContent).toEqual(
        expect.objectContaining({
          saved: true,
          durability: "candidate",
        })
      );
      expect(response.structuredContent.sharedFact.written).toBe(true);
    });
  });

  it("supports memory_search scope/status filters and returns enriched memory rows", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.memoryService.searchMemories = vi.fn(() => ([
      {
        id: "memory-42",
        scope: "mission",
        status: "candidate",
        category: "pattern",
        content: "Service B can lag by ~90s after deploy.",
        importance: "high",
        confidence: 0.82,
        createdAt: "2026-03-01T10:00:00.000Z",
        promotedAt: null,
        sourceRunId: "run-1",
      }
    ]));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "worker-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
      });
      const response = await callTool(handler, "memory_search", {
        query: "deploy lag",
        scope: "mission",
        status: "candidate",
        limit: 7,
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.memoryService.searchMemories).toHaveBeenCalledWith(
        "deploy lag",
        "project-1",
        "mission",
        7,
        "candidate",
        "run-1",
      );
      expect(response.structuredContent.scope).toBe("mission");
      expect(response.structuredContent.status).toBe("candidate");
      expect(response.structuredContent.memories[0]).toEqual(
        expect.objectContaining({
          id: "memory-42",
          scope: "mission",
          status: "candidate",
          confidence: 0.82,
        })
      );
    });
  });

  it("pins memory entries through memory_pin", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "worker-1", role: "agent" });
    const response = await callTool(handler, "memory_pin", { id: "memory-42" });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.memoryService.pinMemory).toHaveBeenCalledWith("memory-42");
    expect(response.structuredContent.pinned).toBe(true);
  });

  it("exposes memory_update_core and writes CTO core memory", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "cto-1",
      role: "agent",
      missionId: "mission-1",
      runId: "run-1"
    });

    const response = await callTool(handler, "memory_update_core", {
      projectSummary: "Stabilize checkout retries and tighten CI gating.",
      activeFocus: ["checkout reliability", "merge safety"]
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.ctoStateService.updateCoreMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        projectSummary: "Stabilize checkout retries and tighten CI gating.",
        activeFocus: ["checkout reliability", "merge safety"]
      })
    );
    expect(response.structuredContent.updated).toBe(true);
    expect(response.structuredContent.version).toBe(3);
    expect(response.structuredContent.updatedAt).toBe("2026-03-05T12:00:00.000Z");
  });

  it("routes memory_update_core to worker core memory when agent ownerId is set", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, {
      callerId: "worker-1",
      role: "agent",
      ownerId: "worker-agent-1",
      missionId: "mission-1",
      runId: "run-1"
    });

    const response = await callTool(handler, "memory_update_core", {
      projectSummary: "Worker-specific checkout strategy",
      activeFocus: ["checkout reliability"]
    });

    expect(response?.isError).toBeUndefined();
    expect(fixture.runtime.workerAgentService.updateCoreMemory).toHaveBeenCalledWith(
      "worker-agent-1",
      expect.objectContaining({
        projectSummary: "Worker-specific checkout strategy",
        activeFocus: ["checkout reliability"]
      })
    );
    expect(fixture.runtime.ctoStateService.updateCoreMemory).not.toHaveBeenCalled();
    expect(response.structuredContent.updated).toBe(true);
    expect(response.structuredContent.version).toBe(4);
    expect(response.structuredContent.updatedAt).toBe("2026-03-05T13:00:00.000Z");
  });

  it("derives worker ownerId from chat session identity when OpenCode launch omits it", async () => {
    await withEnv({ ADE_CHAT_SESSION_ID: "chat-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.agentChatService.getSessionSummary = vi.fn(async (sessionId: string) => ({
        sessionId,
        laneId: "lane-1",
        title: "Worker chat",
        provider: "opencode",
        model: "gpt-5.4-codex",
        status: "idle",
        lastActivityAt: "2026-03-17T19:00:00.000Z",
        createdAt: "2026-03-17T19:00:00.000Z",
        identityKey: "agent:worker-agent-1",
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "chat-from-identity",
        role: "agent",
        chatSessionId: "chat-from-identity",
        missionId: "mission-1",
        runId: "run-1",
      });

      const response = await callTool(handler, "memory_update_core", {
        projectSummary: "Worker-specific checkout strategy",
        activeFocus: ["checkout reliability"],
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.workerAgentService.updateCoreMemory).toHaveBeenCalledWith(
        "worker-agent-1",
        expect.objectContaining({
          projectSummary: "Worker-specific checkout strategy",
          activeFocus: ["checkout reliability"],
        }),
      );
      expect(fixture.runtime.ctoStateService.updateCoreMemory).not.toHaveBeenCalled();
    });
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
    const contextPath = response.structuredContent.contextRef?.path as string | null;
    expect(contextPath).toBeTruthy();
    expect(contextPath?.includes("/.ade/cache/orchestrator/agent-context/run-123/")).toBe(true);
    if (!contextPath) {
      throw new Error("Expected context manifest path");
    }
    expect(fs.existsSync(contextPath)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(contextPath, "utf8"));
    expect(manifest.schema).toBe("ade.agent.spawnContext.v1");
    expect(manifest.mission.runId).toBe("run-123");
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

  it("routes ask_user to mission interventions", async () => {
    await withEnv({ ADE_MISSION_ID: "mission-1", ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, { callerId: "coord-1", role: "orchestrator", missionId: "mission-1", runId: "run-1" });
      const response = await callTool(handler, "ask_user", {
        missionId: "mission-1",
        title: "Need decision",
        body: "Choose the merge order",
        phase: "planning"
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.missionService.addIntervention).toHaveBeenCalledTimes(1);
      expect(fixture.runtime.missionService.addIntervention).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          source: "ask_user",
          runId: "run-1",
          phase: "planning",
          questionOwnerKind: "coordinator",
          questionOwnerLabel: "Coordinator question",
          blocking: true,
          canProceedWithoutAnswer: false,
        }),
      }));
      expect(fixture.runtime.orchestratorService.pauseRun).toHaveBeenCalledWith(expect.objectContaining({
        runId: "run-1",
        metadata: expect.objectContaining({
          interventionSource: "ask_user",
        }),
      }));
      expect(response.structuredContent.awaitingUserResponse).toBe(true);
      expect(response.structuredContent.blocking).toBe(true);
    });
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

  it("stamps worker-owned ask_user provenance and enforces per-step phase policy", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
        run: { id: "run-1", missionId: "mission-1", status: "running" },
        steps: [
          {
            id: "step-plan-1",
            stepKey: "planning-worker",
            laneId: "lane-1",
            status: "running",
            metadata: {
              phaseKey: "planning",
              phaseName: "Planning",
              phaseAskQuestions: { enabled: true, maxQuestions: 2 },
            },
          },
        ],
        attempts: [{ id: "attempt-1", stepId: "step-plan-1", status: "running" }],
        claims: [],
        contextSnapshots: [],
        handoffs: [],
        timeline: [],
        runtimeEvents: [],
        completionEvaluation: { complete: false },
      }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "attempt-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-plan-1",
        attemptId: "attempt-1",
      });
      const response = await callTool(handler, "ask_user", {
        missionId: "mission-1",
        title: "Need product direction",
        body: "Should the planner optimize for a lightweight patch or a more complete refactor?",
      });

      expect(response?.isError).toBeUndefined();
      expect(fixture.runtime.missionService.addIntervention).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          source: "ask_user",
          runId: "run-1",
          phase: "planning",
          phaseName: "Planning",
          stepId: "step-plan-1",
          stepKey: "planning-worker",
          questionOwnerKind: "planner",
          questionOwnerLabel: "Planner question",
        }),
      }));
      expect(response.structuredContent.awaitingUserResponse).toBe(true);
      expect(response.structuredContent.blocking).toBe(true);
    });
  });

  it("denies worker ask_user when the current phase disables questions", async () => {
    await withEnv({ ADE_RUN_ID: "run-1" }, async () => {
      const fixture = createRuntime();
      fixture.runtime.orchestratorService.getRunGraph = vi.fn(() => ({
      run: { id: "run-1", missionId: "mission-1", status: "running" },
      steps: [
        {
          id: "step-dev-1",
          stepKey: "development-worker",
          laneId: "lane-1",
          status: "running",
          metadata: {
            phaseKey: "development",
            phaseName: "Development",
            phaseAskQuestions: { enabled: false },
          },
        },
      ],
      attempts: [{ id: "attempt-1", stepId: "step-dev-1", status: "running" }],
      claims: [],
      contextSnapshots: [],
      handoffs: [],
      timeline: [],
      runtimeEvents: [],
      completionEvaluation: { complete: false },
    }));
      const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

      await initialize(handler, {
        callerId: "attempt-1",
        role: "agent",
        missionId: "mission-1",
        runId: "run-from-identity",
        stepId: "step-dev-1",
        attemptId: "attempt-1",
      });
      const response = await callTool(handler, "ask_user", {
        missionId: "mission-1",
        title: "Need guidance",
        body: "Should I stop and ask a development question?",
      });

      expect(response?.isError).toBe(true);
      expect(JSON.stringify(response?.error ?? response?.structuredContent ?? {})).toContain("Ask Questions is disabled for this phase");
      expect(fixture.runtime.missionService.addIntervention).not.toHaveBeenCalled();
    });
  });

  it("allows mutations for any session", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { callerId: "agent-1", role: "agent" });

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

    const push = await callTool(handler, "git_push", { laneId: "lane-1", force: true, setUpstream: false });
    expect(push?.isError).toBeUndefined();
    expect(fixture.runtime.gitService.push).toHaveBeenCalledWith({ laneId: "lane-1", forceWithLease: true });
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
    });
    expect(created?.isError).toBeUndefined();
    expect(fixture.runtime.prService.createFromLane).toHaveBeenCalledWith({
      laneId: "lane-1",
      baseBranch: "main",
      title: "My PR",
      body: "Body text",
      draft: true,
    });

    const updateTitle = await callTool(handler, "pr_update_title", { prId: "pr-1", title: "Renamed" });
    expect(updateTitle?.isError).toBeUndefined();
    expect(fixture.runtime.prService.updateTitle).toHaveBeenCalledWith({ prId: "pr-1", title: "Renamed" });

    const comment = await callTool(handler, "pr_add_comment", { prId: "pr-1", body: "Looks good" });
    expect(comment?.isError).toBeUndefined();
    expect(fixture.runtime.prService.addComment).toHaveBeenCalledWith({ prId: "pr-1", body: "Looks good" });
  });

  it("lists ADE actions across runtime domains", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const response = await callTool(handler, "list_ade_actions", { domain: "git" });
    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.actions.some((entry: { action: string }) => entry.action === "push")).toBe(true);
    expect(response.structuredContent.actions.some((entry: { action: string }) => entry.action === "commit")).toBe(true);

    const allDomains = await callTool(handler, "list_ade_actions", { domain: "all" });
    expect(allDomains?.isError).toBeUndefined();
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "memory")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "computer_use_artifacts")).toBe(true);
    expect(allDomains.structuredContent.actions.some((entry: { domain: string }) => entry.domain === "operation")).toBe(true);
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
  });

  it("does not expose internal service mutators through dynamic ADE actions", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent" });

    const listed = await callTool(handler, "list_ade_actions", { domain: "issue_inventory" });
    expect(listed?.isError).toBeUndefined();
    const actions = listed.structuredContent.actions.map((entry: { action: string }) => entry.action);
    expect(actions).toContain("getPipelineSettings");
    expect(actions).not.toContain("resetInventory");
    expect(actions).not.toContain("saveConvergenceRuntime");
    expect(actions).not.toContain("deletePipelineSettings");

    const response = await callTool(handler, "run_ade_action", {
      domain: "issue_inventory",
      action: "resetInventory",
      argsList: ["pr-1"],
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.error ?? response.structuredContent ?? {})).toContain(
      "Action 'issue_inventory.resetInventory' is not exposed through ADE actions.",
    );
    expect(fixture.runtime.issueInventoryService.resetInventory).not.toHaveBeenCalled();
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

  it("reads ADE action status snapshots across operation/test/chat/mission/run", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });
    await initialize(handler, { callerId: "agent-1", role: "agent", runId: "run-1", missionId: "mission-1" });

    const response = await callTool(handler, "get_ade_action_status", {
      operationId: "op-1",
      testRunId: "test-run-1",
      chatSessionId: "chat-1",
      runId: "run-1",
      missionId: "mission-1",
      prId: "pr-1",
    });
    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.operation.id).toBe("op-1");
    expect(response.structuredContent.testRun.id).toBe("test-run-1");
    expect(response.structuredContent.chatSession.sessionId).toBe("chat-1");
    expect(response.structuredContent.runGraph.run.id).toBe("run-1");
    expect(response.structuredContent.mission.id).toBe("mission-1");
    expect(response.structuredContent.pr.health.prId).toBe("pr-1");
    expect(typeof response.structuredContent.hash).toBe("string");
    expect(response.structuredContent.changed).toBe(true);

    const unchanged = await callTool(handler, "get_ade_action_status", {
      operationId: "op-1",
      testRunId: "test-run-1",
      chatSessionId: "chat-1",
      runId: "run-1",
      missionId: "mission-1",
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

  it("records succeeded audit metadata for read-only tools", async () => {
    const { runtime, operationStart, operationFinish } = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "list_lanes", {});

    expect(response.isError).toBeUndefined();
    expect(operationStart).toHaveBeenCalledTimes(1);
    expect(operationFinish).toHaveBeenCalledTimes(1);
    const finishArgs = operationFinish.mock.calls[0]?.[0] ?? {};
    expect(finishArgs.status).toBe("succeeded");
    expect(finishArgs.metadataPatch?.resultStatus).toBe("success");
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
    await initialize(handler1);

    const fixture2 = createRuntime();
    const handler2 = createAdeRpcRequestHandler({ runtime: fixture2.runtime, serverVersion: "test" });
    await initialize(handler2);

    // Fire 6 calls from session 1 (per-session limit)
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler1, "ask_user", {
        missionId: "mission-1",
        title: `Question ${i}`,
        body: `Body ${i}`
      });
      expect(r?.isError).toBeUndefined();
    }

    // Session 1 should be rate-limited (per-session: 6/min)
    const overLimit = await callTool(handler1, "ask_user", {
      missionId: "mission-1",
      title: "Over limit",
      body: "Should fail"
    });
    expect(overLimit.isError).toBe(true);
    expect(JSON.stringify(overLimit.structuredContent ?? {})).toContain("rate limit");

    // Session 2 can still fire up to its per-session limit (6)
    // but global limit is 20, so with 6 from session 1, session 2 can do 6 more
    for (let i = 0; i < 6; i++) {
      const r = await callTool(handler2, "ask_user", {
        missionId: "mission-1",
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
        actionableComments: 1,
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
    expect(fixture.runtime.prService.getComments).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getReviews).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getChecks).toHaveBeenCalledWith("pr-123");
  });

  it("routes pr_refresh_issue_inventory with checks, review threads, and issue comments", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler);
    const response = await callTool(handler, "pr_refresh_issue_inventory", { prId: "pr-123" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.summary).toEqual(
      expect.objectContaining({
        failingCheckCount: 0,
        pendingCheckCount: 0,
        actionableReviewThreadCount: 1,
        hasActionableChecks: false,
        hasActionableComments: true,
      }),
    );
    expect(response.structuredContent.failingWorkflowRuns).toHaveLength(1);
    expect(response.structuredContent.reviewThreads[0]).toEqual(
      expect.objectContaining({
        id: "thread-1",
        path: "src/index.ts",
        line: 12,
      }),
    );
    expect(response.structuredContent.issueComments[0]).toEqual(
      expect.objectContaining({
        author: "reviewer",
        body: "Please fix the loading state.",
      }),
    );
    expect(fixture.runtime.prService.getChecks).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getActionRuns).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getReviewThreads).toHaveBeenCalledWith("pr-123");
    expect(fixture.runtime.prService.getComments).toHaveBeenCalledWith("pr-123");
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

  // ---------- Mission Lifecycle Tools ----------

  it("routes create_mission with orchestration authorization", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "create_mission", {
      prompt: "Build the authentication module",
      title: "Auth Module",
      priority: "high"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.mission.id).toBe("mission-new");
    expect(response.structuredContent.mission.prompt).toBe("Build the authentication module");
    expect(response.structuredContent.mission.status).toBe("planned");
    expect(fixture.runtime.missionService.create).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Build the authentication module", title: "Auth Module", priority: "high" })
    );
    expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "mission",
        payload: expect.objectContaining({ type: "mission_created", missionId: "mission-new" })
      })
    );
  });

  it("routes start_mission and returns run info", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "start_mission", {
      missionId: "mission-1",
      runMode: "autopilot"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.started.run.status).toBe("running");
    expect(fixture.runtime.aiOrchestratorService.startMissionRun).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "mission-1", runMode: "autopilot" })
    );
    expect(fixture.runtime.eventBuffer.push).toHaveBeenCalledWith(
      expect.objectContaining({
        category: "mission",
        payload: expect.objectContaining({ type: "mission_started", missionId: "mission-1", runId: "run-1" })
      })
    );
  });

  it("routes pause_mission to orchestratorService.pauseRun", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "pause_mission", {
      runId: "run-1",
      reason: "User requested pause"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.run.id).toBe("run-1");
    expect(response.structuredContent.run.status).toBe("paused");
    expect(fixture.runtime.orchestratorService.pauseRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reason: "User requested pause" })
    );
  });

  it("routes resume_mission to orchestratorService.resumeRun", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "resume_mission", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.run.id).toBe("run-1");
    expect(response.structuredContent.run.status).toBe("running");
    expect(fixture.runtime.orchestratorService.resumeRun).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("routes cancel_mission to aiOrchestratorService.cancelRunGracefully", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "cancel_mission", {
      runId: "run-1",
      reason: "No longer needed"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.cancelled).toBe(true);
    expect(response.structuredContent.runId).toBe("run-1");
    expect(fixture.runtime.aiOrchestratorService.cancelRunGracefully).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", reason: "No longer needed" })
    );
  });

  it("routes steer_mission with directive", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "steer_mission", {
      missionId: "mission-1",
      directive: "Focus on API layer first",
      interventionId: "intervention-1",
      resolutionKind: "answer_provided",
      targetStepKey: "step-a",
      priority: "instruction"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.acknowledged).toBe(true);
    expect(fixture.runtime.aiOrchestratorService.steerMission).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        directive: "Focus on API layer first",
        interventionId: "intervention-1",
        resolutionKind: "answer_provided",
        priority: "instruction",
        targetStepKey: "step-a"
      })
    );
  });

  it("routes resolve_intervention with status", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "resolve_intervention", {
      missionId: "mission-1",
      interventionId: "intervention-1",
      status: "resolved",
      resolutionKind: "skip_question",
      note: "Issue addressed"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.intervention.id).toBe("intervention-1");
    expect(response.structuredContent.intervention.status).toBe("resolved");
    expect(fixture.runtime.missionService.resolveIntervention).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-1",
        interventionId: "intervention-1",
        status: "resolved",
        resolutionKind: "skip_question",
        note: "Issue addressed"
      })
    );
  });

  // ---------- Observation Tools ----------

  it("routes get_mission to missionService.get", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_mission", { missionId: "mission-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.mission.id).toBe("mission-1");
    expect(fixture.runtime.missionService.get).toHaveBeenCalledWith("mission-1");
  });

  it("routes get_run_graph to orchestratorService.getRunGraph", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_run_graph", { runId: "run-1", timelineLimit: 50 });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.graph.run.id).toBe("run-1");
    expect(response.structuredContent.graph.steps).toHaveLength(1);
    expect(response.structuredContent.graph.completionEvaluation.complete).toBe(true);
    expect(fixture.runtime.orchestratorService.getRunGraph).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", timelineLimit: 50 })
    );
  });

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

  it("routes get_step_output and filters attempts by step", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_step_output", {
      runId: "run-1",
      stepKey: "step-a"
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.step.stepKey).toBe("step-a");
    expect(response.structuredContent.attempts).toHaveLength(1);
    expect(response.structuredContent.attempts[0].stepId).toBe("step-1");
    expect(fixture.runtime.orchestratorService.getRunGraph).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", timelineLimit: 0 })
    );
  });

  it("routes get_step_output returns error for unknown step", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_step_output", {
      runId: "run-1",
      stepKey: "nonexistent-step"
    });

    expect(response.isError).toBe(true);
    expect(JSON.stringify(response.structuredContent ?? {})).toContain("Step not found");
  });

  it("routes get_worker_states to aiOrchestratorService.getWorkerStates", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_worker_states", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.workers).toHaveLength(1);
    expect(response.structuredContent.workers[0].state).toBe("running");
    expect(fixture.runtime.aiOrchestratorService.getWorkerStates).toHaveBeenCalledWith({ runId: "run-1" });
  });

  it("routes get_timeline to orchestratorService.listTimeline", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_timeline", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.timeline).toHaveLength(2);
    expect(response.structuredContent.timeline[0].eventType).toBe("run_started");
    expect(fixture.runtime.orchestratorService.listTimeline).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", limit: 300 })
    );
  });

  it("routes get_timeline with stepId filter", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_timeline", { runId: "run-1", stepId: "step-1" });

    expect(response?.isError).toBeUndefined();
    // Only the entry with stepId "step-1" should be returned
    expect(response.structuredContent.timeline).toHaveLength(1);
    expect(response.structuredContent.timeline[0].stepId).toBe("step-1");
  });

  it("routes get_mission_metrics to aiOrchestratorService.getMissionMetrics", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_mission_metrics", { missionId: "mission-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.metrics.missionId).toBe("mission-1");
    expect(response.structuredContent.metrics.samples).toEqual([]);
    expect(fixture.runtime.aiOrchestratorService.getMissionMetrics).toHaveBeenCalledWith({ missionId: "mission-1" });
  });

  it("routes get_final_diff with per-lane diffs", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_final_diff", { runId: "run-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    // The mock graph has one step with laneId "lane-1", so we should get diffs for that lane
    expect(response.structuredContent.diffs["lane-1"]).toBeDefined();
    expect(fixture.runtime.diffService.getChanges).toHaveBeenCalledWith("lane-1");
  });

  // ---------- Evaluation Tools ----------

  it("routes evaluate_run with evaluator authorization and writes to DB", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });
    const response = await callTool(handler, "evaluate_run", {
      runId: "run-1",
      missionId: "mission-1",
      scores: {
        planQuality: 8,
        parallelism: 7,
        coordinatorDecisions: 9,
        resourceEfficiency: 6,
        outcomeQuality: 8
      },
      issues: [
        {
          category: "planning",
          severity: "minor",
          description: "Could have parallelized more",
          recommendation: "Use wider lanes"
        }
      ],
      summary: "Good overall execution with minor planning gaps",
      improvements: ["Increase lane parallelism"],
      metadata: { evaluatorVersion: "1.0" }
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.runId).toBe("run-1");
    expect(response.structuredContent.missionId).toBe("mission-1");
    expect(response.structuredContent.scores.planQuality).toBe(8);
    expect(response.structuredContent.summary).toBe("Good overall execution with minor planning gaps");
    expect(response.structuredContent.id).toBeTruthy();
    expect(response.structuredContent.evaluatedAt).toBeTruthy();
    expect(fixture.runtime.db.run).toHaveBeenCalledTimes(1);
    // Verify the INSERT call has the correct SQL and the run_id parameter
    const runCallArgs = fixture.runtime.db.run.mock.calls[0];
    expect(runCallArgs[0]).toContain("INSERT INTO orchestrator_evaluations");
    expect(runCallArgs[1]).toContain("run-1");
    expect(runCallArgs[1]).toContain("mission-1");
  });

  it("routes list_evaluations and returns summaries", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "list_evaluations", {
      missionId: "mission-1",
      limit: 10
    });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.evaluations).toHaveLength(1);
    expect(response.structuredContent.evaluations[0].id).toBe("eval-1");
    expect(response.structuredContent.evaluations[0].scores.planQuality).toBe(8);
    expect(response.structuredContent.evaluations[0].issueCount).toBe(0);
    expect(response.structuredContent.evaluations[0].summary).toBe("Good run");
    expect(fixture.runtime.db.all).toHaveBeenCalled();
  });

  it("routes get_evaluation_report with run context", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });
    const response = await callTool(handler, "get_evaluation_report", { evaluationId: "eval-1" });

    expect(response?.isError).toBeUndefined();
    expect(response.structuredContent.evaluation.id).toBe("eval-1");
    expect(response.structuredContent.evaluation.runId).toBe("run-1");
    expect(response.structuredContent.evaluation.scores.planQuality).toBe(8);
    expect(response.structuredContent.evaluation.summary).toBe("Good run");
    // run context should be populated from orchestratorService.getRunGraph
    expect(response.structuredContent.runContext).toBeDefined();
    expect(response.structuredContent.runContext.run.id).toBe("run-1");
    expect(response.structuredContent.runContext.stepCount).toBe(1);
    expect(response.structuredContent.runContext.attemptCount).toBe(1);
  });

  it("evaluator gets reads + orchestration + evaluation", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "evaluator" });

    // Read-only observation tool should work
    const readResponse = await callTool(handler, "get_mission", { missionId: "mission-1" });
    expect(readResponse?.isError).toBeUndefined();

    // Orchestration tool should work
    const orchResponse = await callTool(handler, "pause_mission", { runId: "run-1" });
    expect(orchResponse?.isError).toBeUndefined();

    // Evaluation tool should work
    const evalResponse = await callTool(handler, "evaluate_run", {
      runId: "run-1",
      missionId: "mission-1",
      scores: { planQuality: 8, parallelism: 7, coordinatorDecisions: 9, resourceEfficiency: 6, outcomeQuality: 8 },
      issues: [],
      summary: "Test"
    });
    expect(evalResponse?.isError).toBeUndefined();
  });

  it("any session can access observation tools", async () => {
    const fixture = createRuntime();
    const handler = createAdeRpcRequestHandler({ runtime: fixture.runtime, serverVersion: "test" });

    await initialize(handler, { role: "external" });

    // Observation tools should be accessible
    const missionResp = await callTool(handler, "get_mission", { missionId: "mission-1" });
    expect(missionResp?.isError).toBeUndefined();

    const graphResp = await callTool(handler, "get_run_graph", { runId: "run-1" });
    expect(graphResp?.isError).toBeUndefined();

    const timelineResp = await callTool(handler, "get_timeline", { runId: "run-1" });
    expect(timelineResp?.isError).toBeUndefined();

    // Evaluation read tools should also be accessible
    const listResp = await callTool(handler, "list_evaluations", {});
    expect(listResp?.isError).toBeUndefined();

    const reportResp = await callTool(handler, "get_evaluation_report", { evaluationId: "eval-1" });
    expect(reportResp?.isError).toBeUndefined();
  });

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
        { id: cursor + 2, timestamp: new Date().toISOString(), category: "mission", payload: { type: "mission_created" } },
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
          category: "mission",
          payload: { type: "mission_created" }
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
});
