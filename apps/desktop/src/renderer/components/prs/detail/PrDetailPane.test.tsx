// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  GitUpstreamSyncStatus,
  IssueInventoryItem,
  LaneSummary,
  PrActivityEvent,
  PrAiResolutionEventPayload,
  PrActionRun,
  PrCheck,
  PrComment,
  PrConvergenceState,
  PrConvergenceStatePatch,
  PrReview,
  PrReviewThread,
  PrSnapshotHydration,
  PrStatus,
  PrWithConflicts,
  TerminalSessionStatus,
} from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="pr-detail-layout">{children}</div>,
  Panel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { id?: string }) => (
    <div data-testid={props.id} {...props}>
      {children}
    </div>
  ),
  Separator: (props: React.HTMLAttributes<HTMLDivElement>) => <div role="separator" {...props} />,
}));

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => {
    const size = options.estimateSize();
    return {
      getTotalSize: () => options.count * size,
      getVirtualItems: () =>
        Array.from({ length: options.count }, (_, index) => ({
          index,
          key: index,
          start: index * size,
          size,
        })),
      scrollToIndex: () => {},
      measureElement: () => {},
    };
  },
}));

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../shared/PrIssueResolverModal", () => ({
  PrIssueResolverModal: ({
    open,
    onLaunch,
    onCopyPrompt,
  }: {
    open: boolean;
    onLaunch: (args: { scope: "checks" | "comments" | "both"; additionalInstructions: string }) => Promise<void>;
    onCopyPrompt: (args: { scope: "checks" | "comments" | "both"; additionalInstructions: string }) => Promise<void>;
  }) => (open ? (
    <div>
      <button onClick={() => void onLaunch({ scope: "checks", additionalInstructions: "extra context" })}>launch resolver</button>
      <button onClick={() => void onCopyPrompt({ scope: "checks", additionalInstructions: "extra context" })}>copy resolver prompt</button>
    </div>
  ) : null),
}));

vi.mock("../../shared/AdeDiffViewer", () => ({
  AdeDiffViewer: () => <div data-testid="ade-diff-viewer" />,
}));

import { PrDetailPane } from "./PrDetailPane";

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null, ...overrides };
}

function makeActionRun(overrides: Partial<PrActionRun> = {}): PrActionRun {
  return {
    id: 25203344014,
    name: "Path Filtered CI on PR",
    status: "completed",
    conclusion: "success",
    headSha: "a886859",
    htmlUrl: "https://github.com/arul28/Versic/actions/runs/25203344014",
    createdAt: "2026-05-01T05:15:24.000Z",
    updatedAt: "2026-05-01T05:24:41.000Z",
    jobs: [],
    ...overrides,
  };
}

function makeComment(overrides: Partial<PrComment> = {}): PrComment {
  return {
    id: "comment-1",
    author: "reviewer",
    authorAvatarUrl: null,
    body: "Cached comment body",
    source: "issue",
    url: null,
    path: "src/prs.ts",
    line: 18,
    createdAt: "2026-03-23T12:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function makeReview(overrides: Partial<PrReview> = {}): PrReview {
  return {
    reviewer: "reviewer",
    reviewerAvatarUrl: null,
    state: "approved",
    body: "Cached review body",
    submittedAt: "2026-03-23T12:05:00.000Z",
    ...overrides,
  };
}

function makeThread(overrides: Partial<PrReviewThread> = {}): PrReviewThread {
  return {
    id: "thread-1",
    isResolved: false,
    isOutdated: false,
    path: "src/prs.ts",
    line: 18,
    originalLine: 18,
    startLine: null,
    originalStartLine: null,
    diffSide: "RIGHT",
    url: null,
    createdAt: null,
    updatedAt: null,
    comments: [{ id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Please tighten this logic.", url: null, createdAt: null, updatedAt: null }],
    ...overrides,
  };
}

const visibilityCases: Array<{
  name: string;
  checks: PrCheck[];
  reviewThreads: PrReviewThread[];
  statusOverrides?: Partial<PrStatus>;
  visible: boolean;
}> = [
  {
    name: "shows for failed checks only",
    checks: [makeCheck()],
    reviewThreads: [],
    visible: true,
  },
  {
    name: "hides while checks are still running",
    checks: [
      makeCheck(),
      makeCheck({ name: "ci / lint", status: "in_progress", conclusion: null }),
    ],
    reviewThreads: [],
    visible: false,
  },
  {
    name: "shows for unresolved review threads only",
    checks: [makeCheck({ conclusion: "success" })],
    reviewThreads: [makeThread()],
    statusOverrides: { checksStatus: "passing" },
    visible: true,
  },
  {
    name: "hides when nothing actionable remains",
    checks: [makeCheck({ conclusion: "success" })],
    reviewThreads: [makeThread({
      isResolved: true,
      comments: [{ id: "comment-1", author: "reviewer", authorAvatarUrl: null, body: "Looks good now.", url: null, createdAt: null, updatedAt: null }],
    })],
    statusOverrides: { checksStatus: "passing", reviewStatus: "approved" },
    visible: false,
  },
];

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-80",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 80,
    githubUrl: "https://github.com/ade-dev/ade/pull/80",
    githubNodeId: "PR_kwDOExample",
    title: "Stabilize GitHub PR flows",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-80",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    additions: 25,
    deletions: 8,
    lastSyncedAt: "2026-03-23T12:00:00.000Z",
    createdAt: "2026-03-23T11:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    conflictAnalysis: null,
    ...overrides,
  };
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature/pr-80",
    description: "Tighten the GitHub PR lane.",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/pr-80",
    worktreePath: "/tmp/lane-1",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-03-23T10:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

function makeStatus(overrides: Partial<PrStatus> = {}): PrStatus {
  return {
    prId: "pr-80",
    state: "open",
    checksStatus: "failing",
    reviewStatus: "changes_requested",
    isMergeable: false,
    mergeConflicts: false,
    behindBaseBy: 0,
    ...overrides,
  };
}

function makeConvergenceState(overrides: Partial<PrConvergenceState> = {}): PrConvergenceState {
  const now = "2026-03-23T12:30:00.000Z";
  return {
    prId: "pr-80",
    autoConvergeEnabled: false,
    pathToMergeActive: false,
    status: "idle",
    pollerStatus: "idle",
    mergeWaitKind: null,
    currentRound: 0,
    activeSessionId: null,
    activeLaneId: null,
    activeHref: null,
    pauseReason: null,
    errorMessage: null,
    forceFinalizeUsed: false,
    ciRetryAttemptsUsed: 0,
    waitForCiStartedAt: null,
    lastDispatchHeadSha: null,
    lastBotPingHeadSha: null,
    lastBotPingAt: null,
    pauseRepeatCount: 0,
    lastPauseReasonHash: null,
    lastStartedAt: null,
    lastPolledAt: null,
    lastPausedAt: null,
    lastStoppedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeInventoryItem(overrides: Partial<IssueInventoryItem> = {}): IssueInventoryItem {
  return {
    id: "inv-1",
    prId: "pr-80",
    source: "human",
    type: "review_thread",
    externalId: "thread:1",
    state: "new",
    round: 0,
    filePath: "src/prs.ts",
    line: 18,
    severity: "major",
    headline: "Tighten review-thread handling",
    body: "Please verify the thread before replying.",
    author: "reviewer",
    url: "https://example.com/thread/1",
    dismissReason: null,
    agentSessionId: null,
    createdAt: "2026-03-23T12:00:00.000Z",
    updatedAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

function renderPane(args: {
  checks: PrCheck[];
  freshChecks?: PrCheck[];
  actionRuns?: PrActionRun[];
  freshActionRuns?: PrActionRun[];
  reviews?: PrReview[];
  comments?: PrComment[];
  reviewThreads: PrReviewThread[];
  lanes?: LaneSummary[];
  laneStatusOverrides?: Partial<LaneSummary["status"]>;
  prOverrides?: Partial<PrWithConflicts>;
  onNavigate?: (path: string) => void;
  activity?: PrActivityEvent[];
  status?: PrStatus | null;
  statusOverrides?: Partial<PrStatus>;
  mergeMethod?: "merge" | "squash" | "rebase";
  convergenceState?: PrConvergenceState | null;
  sessionStatus?: TerminalSessionStatus;
  syncStatus?: Partial<GitUpstreamSyncStatus>;
  inventorySnapshot?: {
    items: IssueInventoryItem[];
    convergence: { currentRound: number; maxRounds: number; totalNew: number; totalSentToAgent: number; isConverging: boolean };
  };
  listSnapshots?: ReturnType<typeof vi.fn>;
  getDetail?: ReturnType<typeof vi.fn>;
  getFiles?: ReturnType<typeof vi.fn>;
  getCommits?: ReturnType<typeof vi.fn>;
  getActivity?: ReturnType<typeof vi.fn>;
  addComment?: ReturnType<typeof vi.fn>;
  requestReviewers?: ReturnType<typeof vi.fn>;
  getActionRuns?: ReturnType<typeof vi.fn>;
  snapshotHydration?: PrSnapshotHydration | null;
  snapshotHydrationOwnedByContext?: boolean;
  liveDetailReady?: boolean;
}) {
  const laneList = args.lanes ?? [makeLane({
    status: {
      dirty: false,
      ahead: 0,
      behind: 0,
      remoteBehind: -1,
      rebaseInProgress: false,
      ...args.laneStatusOverrides,
    },
  })];
  const issueResolutionStart = vi.fn().mockResolvedValue({
    sessionId: "session-1",
    laneId: "lane-1",
    href: "/work?laneId=lane-1&sessionId=session-1",
  });
  const issueResolutionPreviewPrompt = vi.fn().mockResolvedValue({
    title: "Resolve PR #80 issues",
    prompt: "Prepared issue resolver prompt",
  });
  const aiResolutionStop = vi.fn().mockResolvedValue(undefined);
  const getReviewThreads = vi.fn().mockResolvedValue(args.reviewThreads);
  const getChecks = vi.fn().mockResolvedValue(args.freshChecks ?? args.checks);
  const getActionRuns = args.getActionRuns ?? vi.fn();
  if (!args.getActionRuns) {
    if (args.freshActionRuns) {
      getActionRuns.mockResolvedValueOnce(args.actionRuns ?? []);
      getActionRuns.mockResolvedValue(args.freshActionRuns);
    } else {
      getActionRuns.mockResolvedValue(args.actionRuns ?? []);
    }
  }
  const getStatus = vi.fn().mockResolvedValue(args.statusOverrides ? makeStatus(args.statusOverrides) : makeStatus());
  const issueInventorySync = vi.fn().mockResolvedValue({
    items: args.inventorySnapshot?.items ?? [],
    convergence: args.inventorySnapshot?.convergence ?? { currentRound: 0, maxRounds: 5, totalNew: 0, totalSentToAgent: 0, isConverging: false },
  });
  const issueInventoryReset = vi.fn().mockResolvedValue(undefined);
  const getSyncStatus = vi.fn().mockResolvedValue({
    hasUpstream: true,
    upstreamRef: "origin/feature/pr-80",
    ahead: 0,
    behind: 0,
    diverged: false,
    recommendedAction: "none",
    ...args.syncStatus,
    upstreamState: args.syncStatus?.upstreamState ?? "tracking",
  } satisfies GitUpstreamSyncStatus);
  const persistedSessionId = args.convergenceState?.activeSessionId ?? "session-1";
  const getSession = vi.fn().mockImplementation(async (lookupId?: string) => {
    if (!args.sessionStatus) return null;
    const resolvedId = lookupId ?? persistedSessionId;
    return {
      id: resolvedId,
      laneId: "lane-1",
      laneName: "feature/pr-80",
      ptyId: null,
      tracked: true,
      pinned: false,
      goal: null,
      toolType: "codex-chat",
      title: "Resolve PR #80 issues",
      status: args.sessionStatus,
      startedAt: "2026-03-23T12:00:00.000Z",
      endedAt: args.sessionStatus === "running" ? null : "2026-03-23T12:30:00.000Z",
      exitCode: args.sessionStatus === "completed" ? 0 : 1,
      transcriptPath: "/tmp/transcript.log",
      headShaStart: null,
      headShaEnd: null,
      lastOutputPreview: null,
      summary: null,
      runtimeState: args.sessionStatus === "running" ? "running" : "exited",
      resumeCommand: null,
    };
  });
  let aiResolutionListener: ((event: PrAiResolutionEventPayload) => void) | null = null;
  const onAiResolutionEvent = vi.fn((callback: (event: PrAiResolutionEventPayload) => void) => {
    aiResolutionListener = callback;
    return () => {
      if (aiResolutionListener === callback) aiResolutionListener = null;
    };
  });
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
  const requestReviewers = args.requestReviewers ?? vi.fn().mockResolvedValue(undefined);
  const land = vi.fn().mockResolvedValue({
    prId: "pr-80",
    prNumber: 80,
    success: true,
    mergeCommitSha: "sha-merge",
    branchDeleted: false,
    laneArchived: false,
    error: null,
  });
  const onRefresh = vi.fn().mockResolvedValue(undefined);
  let currentConvergence: PrConvergenceState | null = args.convergenceState ?? null;
  const loadConvergenceState = vi.fn().mockImplementation(async () => currentConvergence);
  const saveConvergenceState = vi.fn().mockImplementation(async (_prId: string, patch: PrConvergenceStatePatch) => {
    currentConvergence = currentConvergence
      ? { ...currentConvergence, ...patch, updatedAt: new Date().toISOString() }
      : makeConvergenceState(patch);
    return currentConvergence;
  });
  const pathToMergeStart = vi.fn().mockImplementation(async ({ prId }: { prId: string }) => {
    currentConvergence = makeConvergenceState({
      prId,
      autoConvergeEnabled: true,
      pathToMergeActive: true,
      status: "launching",
      pollerStatus: "scheduled",
      lastStartedAt: new Date().toISOString(),
    });
    return { prId, scheduled: true, runtime: currentConvergence };
  });
  const pathToMergeStop = vi.fn().mockImplementation(async ({ prId, reason }: { prId: string; reason?: string | null }) => {
    currentConvergence = makeConvergenceState({
      prId,
      autoConvergeEnabled: false,
      status: "stopped",
      pollerStatus: "stopped",
      pauseReason: reason ?? null,
      lastStoppedAt: new Date().toISOString(),
    });
    return { prId, stopped: true, runtime: currentConvergence };
  });
  const resetConvergenceState = vi.fn().mockImplementation(async () => {
    currentConvergence = null;
    return undefined;
  });
  mockUsePrs.mockReturnValue({
    convergenceStatesByPrId: currentConvergence ? { "pr-80": currentConvergence } : {},
    detailReviewThreads: args.reviewThreads,
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    rebaseNeeds: [],
    resolverModel: "openai/gpt-5.4",
    resolverReasoningLevel: "high",
    resolverPermissionMode: "guarded_edit",
    setResolverModel: vi.fn(),
    setResolverReasoningLevel: vi.fn(),
    setResolverPermissionMode: vi.fn(),
    dismissedAiSummaries: {},
    timelineFiltersByPrId: {},
    detailAiSummary: null,
    detailDeployments: [],
    detailLiveDataPrId: null,
    viewerLogin: "octocat",
    setTimelineFilters: vi.fn(),
    setAiSummaryDismissed: vi.fn(),
    regeneratePrAiSummary: vi.fn(),
  });
  Object.assign(window, {
    ade: {
      prs: {
        listSnapshots: args.listSnapshots,
        getDetail: args.getDetail ?? vi.fn().mockResolvedValue({
          prId: "pr-80",
          body: "This PR improves GitHub PR flows.",
          labels: [],
          assignees: [],
          requestedReviewers: [],
          author: { login: "octocat", avatarUrl: null },
          isDraft: false,
          milestone: null,
          linkedIssues: [],
        }),
        getFiles: args.getFiles ?? vi.fn().mockResolvedValue([]),
        getCommits: args.getCommits,
        getActionRuns,
        getActivity: args.getActivity ?? vi.fn().mockResolvedValue(args.activity ?? []),
        addComment: args.addComment ?? vi.fn().mockResolvedValue(undefined),
        requestReviewers,
        getReviewThreads,
        issueInventorySync,
        issueInventoryReset,
        pipelineSettingsGet: vi.fn().mockResolvedValue({
          autoMerge: false,
          mergeMethod: "repo_default",
          maxRounds: 5,
          onRebaseNeeded: "pause",
          conflictStrategy: "pause",
          autoAgentSettings: {
            provider: null,
            model: null,
            reasoningEffort: null,
            permissionMode: null,
            confidenceThreshold: null,
          },
          forceFinalizeMode: "off",
          forceFinalizeRequireNoCiFailures: true,
          atCapPolicy: "stop",
          atCapWaitMinutes: 30,
          atCapCiRetryMax: 3,
          forceMergeRequiresConfirmation: true,
          earlyMergeOnGreen: true,
        }),
        getChecks,
        getStatus,
        onAiResolutionEvent,
        issueResolutionStart,
        issueResolutionPreviewPrompt,
        aiResolutionStop,
        loadConvergenceState,
        saveConvergenceState,
        resetConvergenceState,
        pathToMergeStart,
        pathToMergeStop,
        land,
        openInGitHub: vi.fn().mockResolvedValue(undefined),
      },
      lanes: {
        list: vi.fn().mockResolvedValue(laneList),
      },
      git: {
        getSyncStatus,
      },
      app: {
        openExternal: vi.fn(),
        writeClipboardText,
      },
      sessions: {
        get: getSession,
      },
      ai: {
        getStatus: vi.fn().mockResolvedValue({
          availableModels: [],
        }),
      },
    },
  });

  let currentChecks = args.checks;
  let currentReviews = args.reviews ?? [];
  let currentComments = args.comments ?? [];
  let currentSnapshotHydration = args.snapshotHydration;
  let currentLiveDetailReady = args.liveDetailReady;
  const renderSubject = (prOverrides: Partial<PrWithConflicts> = args.prOverrides ?? {}) => (
    <MemoryRouter>
      <PrDetailPane
        pr={makePr(prOverrides)}
        status={args.status === undefined ? makeStatus(args.statusOverrides) : args.status}
        checks={currentChecks}
        reviews={currentReviews}
        comments={currentComments}
        snapshotHydration={currentSnapshotHydration}
        snapshotHydrationOwnedByContext={args.snapshotHydrationOwnedByContext}
        liveDetailReady={currentLiveDetailReady}
        detailBusy={false}
        lanes={laneList}
        mergeMethod={args.mergeMethod ?? "squash"}
        onRefresh={onRefresh}
        onNavigate={args.onNavigate ?? vi.fn()}
      />
    </MemoryRouter>
  );
  const rendered = render(renderSubject());

  return {
    issueResolutionStart,
    issueResolutionPreviewPrompt,
    aiResolutionStop,
    getReviewThreads,
    getActionRuns,
    getActivity: window.ade.prs.getActivity,
    addComment: window.ade.prs.addComment,
    requestReviewers,
    issueInventorySync,
    issueInventoryReset,
    getChecks,
    getStatus,
    getSyncStatus,
    getSession,
    onAiResolutionEvent,
    emitAiResolutionEvent: (event: PrAiResolutionEventPayload) => {
      aiResolutionListener?.(event);
    },
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    pathToMergeStart,
    pathToMergeStop,
    writeClipboardText,
    land,
    onRefresh,
    rerenderPane: (prOverrides: Partial<PrWithConflicts>, nextDetail?: {
      checks?: PrCheck[];
      reviews?: PrReview[];
      comments?: PrComment[];
      snapshotHydration?: PrSnapshotHydration | null;
      liveDetailReady?: boolean;
    }) => {
      currentChecks = nextDetail?.checks ?? currentChecks;
      currentReviews = nextDetail?.reviews ?? currentReviews;
      currentComments = nextDetail?.comments ?? currentComments;
      if (nextDetail && "snapshotHydration" in nextDetail) {
        currentSnapshotHydration = nextDetail.snapshotHydration;
      }
      if (nextDetail && "liveDetailReady" in nextDetail) {
        currentLiveDetailReady = nextDetail.liveDetailReady;
      }
      rendered.rerender(renderSubject({ ...(args.prOverrides ?? {}), ...prOverrides }));
    },
    ...rendered,
  };
}

describe("PrDetailPane", () => {
  beforeEach(() => {
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = class {
      constructor(private cb: (entries: IntersectionObserverEntry[]) => void) {}
      observe(el: Element) {
        this.cb([{ isIntersecting: true, target: el } as unknown as IntersectionObserverEntry]);
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
      root = null;
      rootMargin = "";
      thresholds = [];
    };
    Element.prototype.scrollTo = function () {};

    mockUsePrs.mockReturnValue({
      convergenceStatesByPrId: {},
      detailReviewThreads: [],
      loadConvergenceState: vi.fn(),
      saveConvergenceState: vi.fn(),
      resetConvergenceState: vi.fn(),
      rebaseNeeds: [],
      resolverModel: "openai/gpt-5.4",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.history.replaceState(null, "", "/");
  });

  it.each(visibilityCases)("$name — Path to Merge tab is always visible", async ({ checks, reviewThreads, statusOverrides }) => {
    renderPane({ checks, reviewThreads, statusOverrides });

    // Path to Merge is now a permanent tab (2nd position), always rendered
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /path to merge/i })).toBeTruthy();
    });
  });

  it("renders live PR detail without waiting for slow action-run hydration", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [],
      reviewThreads: [],
      getFiles: vi.fn().mockResolvedValue([
        {
          filename: "src/pr-detail.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
          patch: null,
          previousFilename: null,
        },
      ]),
      getActionRuns: vi.fn(() => new Promise(() => {})),
    });

    await user.click(screen.getByRole("button", { name: /files/i }));
    await waitFor(() => {
      expect(screen.getByText("src/pr-detail.ts")).toBeTruthy();
    });
  });

  it("shows the resolve action in the checks tab when issues are actionable", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [makeCheck()],
      reviewThreads: [makeThread()],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));

    await waitFor(() => {
      // "Resolve issues with agent" in ChecksTab
      expect(screen.getByRole("button", { name: /resolve issues with agent/i })).toBeTruthy();
    });
  });

  it("keeps the merge readiness checks row in a running state while failed checks are still in flight", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [
        makeCheck({ name: "ci / unit", conclusion: "success" }),
        makeCheck({ name: "ci / e2e", conclusion: "failure" }),
        makeCheck({ name: "ci / lint", status: "in_progress", conclusion: null }),
      ],
      reviewThreads: [],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));

    await waitFor(() => {
      expect(screen.getByText(/1 failing/i)).toBeTruthy();
      expect(screen.getByText(/1 pending/i)).toBeTruthy();
    });
  });

  it("does not count GitHub Actions jobs twice when check-runs mirror workflow jobs", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [
        makeCheck({
          name: "Fast Checks (Lint, Type, Unit)",
          conclusion: "success",
          detailsUrl: "https://github.com/arul28/Versic/actions/runs/25203344014/job/73898654393",
        }),
        makeCheck({
          name: "Coverage Report",
          conclusion: "success",
          detailsUrl: "https://github.com/arul28/Versic/actions/runs/25203344014/job/73898654402",
        }),
        makeCheck({
          name: "Greptile Review",
          conclusion: "success",
          detailsUrl: "https://greptile.com/",
        }),
      ],
      actionRuns: [
        makeActionRun({
          jobs: [
            {
              id: 73898654393,
              name: "Fast Checks (Lint, Type, Unit)",
              status: "completed",
              conclusion: "success",
              startedAt: null,
              completedAt: null,
              steps: [],
            },
            {
              id: 73898654402,
              name: "Coverage Report",
              status: "completed",
              conclusion: "success",
              startedAt: null,
              completedAt: null,
              steps: [],
            },
          ],
        }),
      ],
      reviewThreads: [],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));

    await waitFor(() => {
      expect(screen.getByText("Path Filtered CI on PR / Fast Checks (Lint, Type, Unit)")).toBeTruthy();
      expect(screen.getByText("Path Filtered CI on PR / Coverage Report")).toBeTruthy();
      expect(screen.getByText("Greptile Review")).toBeTruthy();
      expect(screen.getByText("All 3 checks passing")).toBeTruthy();
      expect(screen.queryByText("Fast Checks (Lint, Type, Unit)")).toBeNull();
      expect(screen.queryByText("Coverage Report")).toBeNull();
    });
  });

  it("hydrates checks and timeline data from a cached snapshot", async () => {
    const listSnapshots = vi.fn().mockResolvedValue([{
      prId: "pr-80",
      detail: null,
      status: makeStatus({ checksStatus: "passing", reviewStatus: "approved" }),
      checks: [makeCheck({ name: "Cached snapshot check", conclusion: "success" })],
      reviews: [makeReview({ body: "Cached review body" })],
      comments: [makeComment({ body: "Cached comment body" })],
      files: [],
      commits: [],
      updatedAt: "2026-03-23T12:01:00.000Z",
    }]);
    renderPane({
      status: null,
      checks: [],
      reviewThreads: [],
      listSnapshots,
    });

    await waitFor(() => {
      expect(listSnapshots).toHaveBeenCalledWith({ prId: "pr-80" });
      // Passing checks collapse into the header CI badge (Linear-style); the
      // snapshot's single passing check hydrates as "1/1 passed".
      expect(screen.getByTestId("pr-header-ci-badge").textContent).toContain("passed");
    });

    const rails = await screen.findByTestId("pr-detail-timeline-rails");
    await waitFor(() => {
      expect(screen.getAllByTestId("pr-timeline-review-card").length).toBeGreaterThan(0);
      expect(within(rails).getAllByText("Cached comment body").length).toBeGreaterThan(0);
      expect(within(rails).getAllByText("Cached review body").length).toBeGreaterThan(0);
    });
  });

  it("does not start live detail work from a stale snapshot prefill request", async () => {
    let resolveSnapshots!: (snapshots: PrSnapshotHydration[]) => void;
    const listSnapshots = vi.fn().mockImplementation(() => new Promise<PrSnapshotHydration[]>((resolve) => {
      resolveSnapshots = resolve;
    }));
    const getDetail = vi.fn().mockResolvedValue({
      prId: "pr-80",
      body: "Live detail should not load",
      labels: [],
      assignees: [],
      requestedReviewers: [],
      author: { login: "octocat", avatarUrl: null },
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    });
    const getFiles = vi.fn().mockResolvedValue([]);
    const getCommits = vi.fn().mockResolvedValue([]);
    const getActionRuns = vi.fn().mockResolvedValue([]);
    const { unmount } = renderPane({
      checks: [],
      reviewThreads: [],
      listSnapshots,
      getDetail,
      getFiles,
      getCommits,
      getActionRuns,
    });

    await waitFor(() => {
      expect(listSnapshots).toHaveBeenCalledWith({ prId: "pr-80" });
    });

    unmount();
    await act(async () => {
      resolveSnapshots([]);
      await Promise.resolve();
    });

    expect(getDetail).not.toHaveBeenCalled();
    expect(getFiles).not.toHaveBeenCalled();
    expect(getCommits).not.toHaveBeenCalled();
    expect(getActionRuns).not.toHaveBeenCalled();
  });

  it("updates synthesized activity when selected PR detail inputs refresh", async () => {
    const user = userEvent.setup();
    const { rerenderPane } = renderPane({
      checks: [makeCheck({ name: "Old CI", conclusion: "success" })],
      reviewThreads: [],
      prOverrides: {
        checksStatus: "passing",
        updatedAt: "2026-03-23T12:00:00.000Z",
      },
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await waitFor(() => {
      expect(screen.getByText("Old CI")).toBeTruthy();
    });

    rerenderPane(
      {
        checksStatus: "failing",
        updatedAt: "2026-03-23T12:01:00.000Z",
      },
      { checks: [makeCheck({ name: "New CI", conclusion: "failure" })] },
    );

    await waitFor(() => {
      expect(screen.getByText("New CI")).toBeTruthy();
      expect(screen.queryByText("Old CI")).toBeNull();
    });
  });

  it("refetches activity after posting a PR comment", async () => {
    const user = userEvent.setup();
    const addComment = vi.fn().mockResolvedValue(undefined);
    const getActivity = vi.fn().mockResolvedValue([
      {
        id: "comment-new",
        type: "comment",
        author: "octocat",
        avatarUrl: null,
        body: "Freshly posted comment",
        timestamp: "2026-03-23T12:05:00.000Z",
        metadata: {},
      } satisfies PrActivityEvent,
    ]);
    renderPane({
      checks: [],
      comments: [makeComment({ id: "comment-old", body: "Old cached comment" })],
      reviewThreads: [],
      getActivity,
      addComment,
    });

    await user.type(screen.getByPlaceholderText("Leave a comment…"), "Freshly posted comment");
    await user.click(screen.getByRole("button", { name: /post comment/i }));

    await waitFor(() => {
      expect(addComment).toHaveBeenCalledWith({ prId: "pr-80", body: "Freshly posted comment" });
      expect(getActivity).toHaveBeenCalled();
      expect(screen.getByText("Freshly posted comment")).toBeTruthy();
    });
  });

  it("synthesizes unique activity keys for duplicate review and check identities", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      renderPane({
        checks: [],
        reviews: [
          makeReview({ reviewer: "reviewer", submittedAt: "2026-03-23T12:05:00.000Z", body: "First review" }),
          makeReview({ reviewer: "reviewer", submittedAt: "2026-03-23T12:06:00.000Z", body: "Second review" }),
        ],
        reviewThreads: [],
      });

      await waitFor(() => {
        expect(screen.getByText("First review")).toBeTruthy();
        expect(screen.getByText("Second review")).toBeTruthy();
      });
      expect(consoleErrorSpy.mock.calls.some((call) => String(call[0]).includes("Encountered two children with the same key"))).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("uses context-owned snapshot hydration without a duplicate snapshot IPC", async () => {
    const user = userEvent.setup();
    const snapshot: PrSnapshotHydration = {
      prId: "pr-80",
      detail: null,
      status: makeStatus({ checksStatus: "passing", reviewStatus: "approved" }),
      checks: [makeCheck({ name: "Context snapshot check", conclusion: "success" })],
      reviews: [makeReview({ body: "Context review body" })],
      comments: [makeComment({ body: "Context comment body" })],
      files: [],
      commits: [],
      updatedAt: "2026-03-23T12:01:00.000Z",
    };
    const listSnapshots = vi.fn().mockResolvedValue([snapshot]);
    renderPane({
      status: null,
      checks: [],
      reviewThreads: [],
      listSnapshots,
      snapshotHydration: snapshot,
      snapshotHydrationOwnedByContext: true,
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await waitFor(() => {
      expect(screen.getByText("Context snapshot check")).toBeTruthy();
    });
    expect(listSnapshots).not.toHaveBeenCalled();
  });

  it("does not let late context snapshot hydration overwrite live rich detail", async () => {
    const freshDetail = {
      prId: "pr-80",
      body: "Fresh live body",
      labels: [{ name: "fresh-label", color: "22c55e", description: null }],
      assignees: [],
      requestedReviewers: [],
      author: { login: "octocat", avatarUrl: null },
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    };
    const staleSnapshot: PrSnapshotHydration = {
      prId: "pr-80",
      detail: {
        ...freshDetail,
        body: "Stale cached body",
        labels: [{ name: "stale-label", color: "ef4444", description: null }],
      },
      status: makeStatus({ checksStatus: "passing", reviewStatus: "approved" }),
      checks: [],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      updatedAt: "2026-03-23T12:01:00.000Z",
    };
    const { rerenderPane } = renderPane({
      checks: [],
      reviewThreads: [],
      getDetail: vi.fn().mockResolvedValue(freshDetail),
      snapshotHydration: null,
      snapshotHydrationOwnedByContext: true,
    });

    await waitFor(() => {
      expect(screen.getByText("fresh-label")).toBeTruthy();
    });

    rerenderPane({}, { snapshotHydration: staleSnapshot });

    expect(screen.getByText("fresh-label")).toBeTruthy();
    expect(screen.queryByText("stale-label")).toBeNull();
  });

  it("keeps live rich detail while a force-live refresh is pending", async () => {
    const freshDetail = {
      prId: "pr-80",
      body: "Fresh live body",
      labels: [{ name: "fresh-label", color: "22c55e", description: null }],
      assignees: [],
      requestedReviewers: [],
      author: { login: "octocat", avatarUrl: null },
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    };
    const staleSnapshot: PrSnapshotHydration = {
      prId: "pr-80",
      detail: {
        ...freshDetail,
        body: "Stale cached body",
        labels: [{ name: "stale-label", color: "ef4444", description: null }],
      },
      status: makeStatus({ checksStatus: "passing", reviewStatus: "approved" }),
      checks: [],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      updatedAt: "2026-03-23T12:01:00.000Z",
    };
    let resolveSecondDetail!: (value: typeof freshDetail) => void;
    const secondDetail = new Promise<typeof freshDetail>((resolve) => {
      resolveSecondDetail = resolve;
    });
    const getDetail = vi.fn()
      .mockResolvedValueOnce(freshDetail)
      .mockReturnValueOnce(secondDetail);
    const { rerenderPane } = renderPane({
      checks: [],
      reviewThreads: [],
      getDetail,
      snapshotHydration: null,
      snapshotHydrationOwnedByContext: true,
      prOverrides: {
        checksStatus: "none",
        updatedAt: "2026-03-23T12:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("fresh-label")).toBeTruthy();
    });

    const refreshedPr = {
      checksStatus: "pending" as const,
      updatedAt: "2026-03-23T12:01:00.000Z",
    };
    rerenderPane(refreshedPr);

    await waitFor(() => {
      expect(getDetail).toHaveBeenCalledTimes(2);
    });
    rerenderPane(refreshedPr, { snapshotHydration: staleSnapshot });

    expect(screen.getByText("fresh-label")).toBeTruthy();
    expect(screen.queryByText("stale-label")).toBeNull();

    await act(async () => {
      resolveSecondDetail(freshDetail);
      await secondDetail;
    });
  });

  it("prefers authoritative empty live detail over cached snapshot data", async () => {
    const user = userEvent.setup();
    const listSnapshots = vi.fn().mockResolvedValue([{
      prId: "pr-80",
      detail: null,
      status: makeStatus({ checksStatus: "passing", reviewStatus: "approved" }),
      checks: [makeCheck({ name: "Cached snapshot check", conclusion: "success" })],
      reviews: [makeReview({ body: "Cached review body" })],
      comments: [makeComment({ body: "Cached comment body" })],
      files: [],
      commits: [],
      updatedAt: "2026-03-23T12:01:00.000Z",
    }]);
    renderPane({
      status: null,
      checks: [],
      reviewThreads: [],
      listSnapshots,
      liveDetailReady: true,
    });

    await waitFor(() => {
      expect(listSnapshots).toHaveBeenCalledWith({ prId: "pr-80" });
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    expect(screen.queryByText("Cached snapshot check")).toBeNull();

    await user.click(screen.getByRole("button", { name: /overview/i }));
    expect(screen.queryByText("Cached comment body")).toBeNull();
    expect(screen.queryByText("Cached review body")).toBeNull();
  });

  it("targets the selected PR when refreshing detail manually", async () => {
    const user = userEvent.setup();
    const { onRefresh } = renderPane({
      checks: [],
      reviewThreads: [],
      actionRuns: [],
    });
    onRefresh.mockClear();

    await user.click(screen.getByTitle("Refresh"));

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledWith({ prId: "pr-80" });
    });
  });

  it("refreshes detail-side action runs when the selected PR status changes", async () => {
    const user = userEvent.setup();
    const { getActionRuns, rerenderPane } = renderPane({
      checks: [],
      actionRuns: [],
      freshActionRuns: [
        makeActionRun({
          status: "in_progress",
          conclusion: null,
          jobs: [{
            id: 73898654393,
            name: "build",
            status: "in_progress",
            conclusion: null,
            startedAt: null,
            completedAt: null,
            steps: [],
          }],
        }),
      ],
      reviewThreads: [],
      prOverrides: {
        checksStatus: "none",
        updatedAt: "2026-03-23T12:00:00.000Z",
      },
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await waitFor(() => {
      expect(screen.getByText("No checks found")).toBeTruthy();
      expect(getActionRuns).toHaveBeenCalledTimes(1);
    });

    rerenderPane({
      checksStatus: "pending",
      updatedAt: "2026-03-23T12:01:00.000Z",
    });

    await waitFor(() => {
      expect(getActionRuns).toHaveBeenCalledTimes(2);
      expect(screen.getByText("0 passing, 1 pending")).toBeTruthy();
      expect(screen.getByText("Path Filtered CI on PR / build")).toBeTruthy();
    });
  });

  it("does not reapply stale snapshot detail during same-PR status refreshes", async () => {
    const freshDetail = {
      prId: "pr-80",
      body: "Fresh live body",
      labels: [{ name: "fresh-label", color: "22c55e", description: null }],
      assignees: [],
      requestedReviewers: [],
      author: { login: "octocat", avatarUrl: null },
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    };
    const staleDetail = {
      ...freshDetail,
      body: "Stale cached body",
      labels: [{ name: "stale-label", color: "ef4444", description: null }],
    };
    let resolveSecondDetail!: (value: typeof freshDetail) => void;
    const secondDetail = new Promise<typeof freshDetail>((resolve) => {
      resolveSecondDetail = resolve;
    });
    const getDetail = vi.fn()
      .mockResolvedValueOnce(freshDetail)
      .mockReturnValueOnce(secondDetail);
    const listSnapshots = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        prId: "pr-80",
        detail: staleDetail,
        status: null,
        checks: [],
        reviews: [],
        comments: [],
        files: [],
        commits: [],
        updatedAt: "2026-03-23T12:01:00.000Z",
      }]);
    const { rerenderPane } = renderPane({
      checks: [],
      reviewThreads: [],
      getDetail,
      listSnapshots,
      prOverrides: {
        checksStatus: "none",
        updatedAt: "2026-03-23T12:00:00.000Z",
      },
    });

    await waitFor(() => {
      expect(screen.getByText("fresh-label")).toBeTruthy();
    });

    rerenderPane({
      checksStatus: "pending",
      updatedAt: "2026-03-23T12:01:00.000Z",
    });

    await waitFor(() => {
      expect(getDetail).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(listSnapshots).toHaveBeenCalledTimes(1);
    expect(screen.getByText("fresh-label")).toBeTruthy();
    expect(screen.queryByText("stale-label")).toBeNull();

    await act(async () => {
      resolveSecondDetail(freshDetail);
      await secondDetail;
    });
  });

  it("refreshes Path to Merge action runs during inventory sync", async () => {
    const user = userEvent.setup();
    const { getActionRuns, issueInventorySync } = renderPane({
      checks: [
        makeCheck({
          name: "CI / build-win",
          status: "in_progress",
          conclusion: null,
        }),
      ],
      freshChecks: [
        makeCheck({
          name: "CI / build-win",
          status: "completed",
          conclusion: "success",
        }),
      ],
      actionRuns: [
        makeActionRun({
          name: "CI",
          status: "in_progress",
          conclusion: null,
          jobs: [{
            id: 73898654393,
            name: "build-win",
            status: "in_progress",
            conclusion: null,
            startedAt: null,
            completedAt: null,
            steps: [],
          }],
        }),
      ],
      freshActionRuns: [
        makeActionRun({
          name: "CI",
          status: "completed",
          conclusion: "success",
          jobs: [{
            id: 73898654393,
            name: "build-win",
            status: "completed",
            conclusion: "success",
            startedAt: null,
            completedAt: null,
            steps: [],
          }],
        }),
      ],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));

    await waitFor(() => {
      expect(issueInventorySync).toHaveBeenCalled();
      expect(getActionRuns).toHaveBeenCalledTimes(2);
      expect(screen.getByText("CI / build-win")).toBeTruthy();
      expect(screen.queryByText("1 running")).toBeNull();
    });
  });

  it("refreshes external check statuses during detail polling", async () => {
    const intervalTicks: Array<() => void> = [];
    const setIntervalSpy = vi.spyOn(window, "setInterval").mockImplementation((handler) => {
      if (typeof handler === "function") {
        intervalTicks.push(handler as () => void);
      }
      return 1 as unknown as ReturnType<typeof window.setInterval>;
    });
    const clearIntervalSpy = vi.spyOn(window, "clearInterval").mockImplementation(() => undefined);

    try {
      const user = userEvent.setup();
      const { getChecks } = renderPane({
        checks: [
          makeCheck({
            name: "CodeRabbit",
            status: "in_progress",
            conclusion: null,
          }),
        ],
        reviewThreads: [],
        inventorySnapshot: {
          items: [makeInventoryItem()],
          convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
        },
      });

      await user.click(screen.getByRole("button", { name: /path to merge/i }));

      await waitFor(() => {
        expect(screen.getByText("CodeRabbit")).toBeTruthy();
        expect(screen.getByText("running")).toBeTruthy();
      });

      getChecks.mockResolvedValue([
        makeCheck({
          name: "CodeRabbit",
          status: "completed",
          conclusion: "success",
        }),
      ]);

      await React.act(async () => {
        intervalTicks.forEach((tick) => tick());
        await Promise.resolve();
      });

      await waitFor(() => {
        expect(getChecks).toHaveBeenCalled();
        expect(screen.getByText("success")).toBeTruthy();
        expect(screen.queryByText("running")).toBeNull();
      });
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it("lets the operator attempt a bypass merge and uses the selected merge method", async () => {
    const user = userEvent.setup();
    const { land, onRefresh } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      mergeMethod: "squash",
      statusOverrides: {
        checksStatus: "failing",
        reviewStatus: "changes_requested",
        isMergeable: false,
        mergeConflicts: false,
      },
    });

    const mergeButton = await screen.findByRole("button", { name: /squash and merge/i });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /choose merge method/i }));
    await user.click(screen.getByRole("button", { name: /create merge commit/i }));
    await user.click(screen.getByLabelText(/merge without waiting for requirements/i));

    const bypassButton = screen.getByTestId("pr-merge-primary-button");
    expect((bypassButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(bypassButton);

    await waitFor(() => {
      expect(land).toHaveBeenCalledWith({ prId: "pr-80", method: "merge", bypassRules: true });
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("keeps ADE PR actions available in the default timeline overview", async () => {
    const user = userEvent.setup();
    const { land, onRefresh } = renderPane({
      checks: [makeCheck({ conclusion: "success" })],
      reviewThreads: [],
      statusOverrides: {
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
      },
      prOverrides: {
        checksStatus: "passing",
        reviewStatus: "approved",
      },
    });

    expect(await screen.findByTestId("pr-detail-timeline-rails")).toBeTruthy();
    expect(screen.getByTestId("pr-comment-composer")).toBeTruthy();
    expect(screen.getByTestId("pr-detail-metadata-actions")).toBeTruthy();
    expect(screen.getByRole("button", { name: /ade review/i })).toBeTruthy();

    const mergeButton = screen.getByTestId("pr-merge-primary-button");
    expect((mergeButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(mergeButton);

    await waitFor(() => {
      expect(land).toHaveBeenCalledWith({ prId: "pr-80", method: "squash", bypassRules: false });
      expect(onRefresh).toHaveBeenCalled();
    });
  });

  it("requests user and team reviewers from the metadata rail", async () => {
    const user = userEvent.setup();
    const requestReviewers = vi.fn().mockResolvedValue(undefined);
    renderPane({
      checks: [],
      reviewThreads: [],
      requestReviewers,
    });

    const section = await screen.findByTestId("pr-metadata-section-reviewers");
    await user.click(within(section).getByRole("button", { name: /^request$/i }));
    await user.type(
      within(section).getByPlaceholderText("alice, bob, team:platform"),
      "alice, team:platform, @acme/qa{enter}",
    );

    await waitFor(() => {
      expect(requestReviewers).toHaveBeenCalledWith({
        prId: "pr-80",
        reviewers: ["alice"],
        teamReviewers: ["platform", "qa"],
      });
    });
  });

  it("enables resolved and outdated review thread filters for legacy activity deep links", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/prs?tab=normal&prId=pr-80&detailTab=activity&threadId=thread-1");

    renderPane({
      checks: [makeCheck({ conclusion: "success" })],
      reviewThreads: [
        makeThread({
          isResolved: true,
          isOutdated: true,
          comments: [
            {
              id: "comment-1",
              author: "reviewer",
              authorAvatarUrl: null,
              body: "Resolved thread body",
              url: null,
              createdAt: null,
              updatedAt: null,
            },
          ],
        }),
      ],
    });

    expect(await screen.findByTestId("pr-detail-timeline-rails")).toBeTruthy();
    const collapsedThread = await screen.findByRole("button", { expanded: false });
    await user.click(collapsedThread);
    expect(await screen.findByText("Resolved thread body")).toBeTruthy();
  });

  it("launches the issue resolver chat and navigates to the work session", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const { issueResolutionStart, saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      onNavigate,
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));
    await user.click(screen.getByRole("button", { name: /launch resolver/i }));

    await waitFor(() => {
      expect(issueResolutionStart).toHaveBeenCalledWith(expect.objectContaining({
        prId: "pr-80",
        scope: "checks",
        additionalInstructions: "extra context",
      }));
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        autoConvergeEnabled: false,
        status: "running",
        pollerStatus: "idle",
        activeSessionId: "session-1",
        activeLaneId: "lane-1",
        activeHref: "/work?laneId=lane-1&sessionId=session-1",
      }));
      expect(onNavigate).toHaveBeenCalledWith("/work?laneId=lane-1&sessionId=session-1");
    });
  });

  it("subscribes to modal-launched resolver sessions and refreshes convergence state after cancellation", async () => {
    const user = userEvent.setup();
    const {
      emitAiResolutionEvent,
      getReviewThreads,
      issueInventorySync,
      onAiResolutionEvent,
      onRefresh,
    } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem({ headline: "Fresh inventory after cancellation" })],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));
    await user.click(screen.getByRole("button", { name: /launch resolver/i }));

    await waitFor(() => {
      expect(onAiResolutionEvent).toHaveBeenCalledTimes(1);
    });

    onRefresh.mockClear();
    getReviewThreads.mockClear();
    issueInventorySync.mockClear();

    await React.act(async () => {
      emitAiResolutionEvent({
        sessionId: "session-1",
        status: "cancelled",
        message: "cancelled",
        timestamp: "2026-03-23T12:31:00.000Z",
      });
    });

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(getReviewThreads).toHaveBeenCalledTimes(1);
      expect(issueInventorySync).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps a Path to Merge manual launch in manual mode", async () => {
    const user = userEvent.setup();
    const { issueResolutionStart, saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    await user.click(await screen.findByRole("button", { name: /launch agent/i }));

    await waitFor(() => {
      expect(issueResolutionStart).toHaveBeenCalledWith(expect.objectContaining({
        prId: "pr-80",
      }));
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        autoConvergeEnabled: false,
        status: "running",
        activeSessionId: "session-1",
      }));
    });

    expect(saveConvergenceState).not.toHaveBeenCalledWith("pr-80", expect.objectContaining({
      autoConvergeEnabled: true,
    }));
  });

  it("rolls back the auto-converge toggle when path-to-merge start fails", async () => {
    const user = userEvent.setup();
    const { pathToMergeStart, pathToMergeStop, saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });
    pathToMergeStart.mockRejectedValueOnce(new Error("orchestrator unavailable"));

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    await user.click(await screen.findByRole("button", { name: /auto-converge/i }));
    expect(pathToMergeStart).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: /start path to merge/i }));

    await waitFor(() => {
      expect(pathToMergeStart).toHaveBeenCalledWith({
        prId: "pr-80",
        scope: "checks",
        modelId: "openai/gpt-5.4",
        reasoning: "high",
        permissionMode: "guarded_edit",
      });
      expect(pathToMergeStop).toHaveBeenCalledWith({
        prId: "pr-80",
        reason: "start failed: orchestrator unavailable",
      });
      expect(saveConvergenceState).not.toHaveBeenCalledWith("pr-80", { autoConvergeEnabled: false });
      expect(screen.getByText(/failed to start auto-converge: orchestrator unavailable/i)).toBeTruthy();
    });
    expect(saveConvergenceState).not.toHaveBeenCalledWith("pr-80", expect.objectContaining({
      autoConvergeEnabled: true,
    }));
  });

  it("starts native Path to Merge with the currently actionable review-comment scope", async () => {
    const user = userEvent.setup();
    const { pathToMergeStart } = renderPane({
      checks: [makeCheck({ conclusion: "success" })],
      reviewThreads: [makeThread()],
      statusOverrides: { checksStatus: "passing" },
      inventorySnapshot: {
        items: [makeInventoryItem({ type: "review_thread" })],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    await user.click(await screen.findByRole("button", { name: /auto-converge/i }));
    expect(pathToMergeStart).not.toHaveBeenCalled();
    await user.click(await screen.findByRole("button", { name: /start path to merge/i }));

    await waitFor(() => {
      expect(pathToMergeStart).toHaveBeenCalledWith({
        prId: "pr-80",
        scope: "comments",
        modelId: "openai/gpt-5.4",
        reasoning: "high",
        permissionMode: "guarded_edit",
      });
    });
  });

  it("restores a persisted convergence session on mount and remounts with the exact session URL", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "running",
      pollerStatus: "idle",
      currentRound: 2,
      activeSessionId: "session-2",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-2",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const firstRender = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      onNavigate,
      convergenceState,
    });

    await waitFor(() => {
      expect(firstRender.loadConvergenceState).toHaveBeenCalledWith("pr-80", { force: true });
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));

    const [viewSessionButton] = await screen.findAllByRole("button", { name: /view session/i });
    await user.click(viewSessionButton);

    expect(onNavigate).toHaveBeenCalledWith("/work?laneId=lane-1&sessionId=session-2");
    firstRender.unmount();

    const secondRender = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      onNavigate,
      convergenceState,
    });

    await waitFor(() => {
      expect(secondRender.loadConvergenceState).toHaveBeenCalledWith("pr-80", { force: true });
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));

    await screen.findAllByRole("button", { name: /view session/i });

    secondRender.unmount();
  });

  it("pauses a restored auto-converge run when the persisted session has already been disposed", async () => {
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "running",
      pollerStatus: "idle",
      currentRound: 2,
      activeSessionId: "session-2",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-2",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const { saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      convergenceState,
      sessionStatus: "disposed",
    });

    await waitFor(() => {
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        pauseReason: "Agent session stopped before completion.",
      }));
    });
  });

  it("pauses auto-converge when a completed agent session leaves unpublished commits", async () => {
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "running",
      pollerStatus: "idle",
      currentRound: 2,
      activeSessionId: "session-1",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-1",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const { saveConvergenceState, getSyncStatus } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      convergenceState,
      sessionStatus: "completed",
      syncStatus: { ahead: 1, recommendedAction: "push" },
    });

    await waitFor(() => {
      expect(getSyncStatus).toHaveBeenCalledWith({ laneId: "lane-1" });
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        status: "paused",
        pollerStatus: "paused",
        activeSessionId: null,
        pauseReason: expect.stringContaining("not pushed to the PR branch"),
      }));
    });
  });

  it("marks a manual convergence round as failed when the agent exits with unpushed commits", async () => {
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: false,
      status: "running",
      pollerStatus: "idle",
      currentRound: 1,
      activeSessionId: "session-1",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-1",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const { saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      convergenceState,
      sessionStatus: "completed",
      syncStatus: { ahead: 1, recommendedAction: "push" },
    });

    await waitFor(() => {
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        status: "failed",
        pollerStatus: "stopped",
        activeSessionId: null,
        errorMessage: expect.stringContaining("not pushed to the PR branch"),
      }));
    });

    expect(screen.getByText(/not pushed to the PR branch/i)).toBeTruthy();
  });

  it("restores a persisted waiting-for-checks runtime from canonical state", async () => {
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "polling",
      pollerStatus: "waiting_for_checks",
      currentRound: 2,
      activeSessionId: null,
    });

    const { loadConvergenceState } = renderPane({
      checks: [makeCheck({ status: "in_progress", conclusion: null })],
      reviewThreads: [],
      convergenceState,
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 2, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: true },
      },
    });

    await waitFor(() => {
      expect(loadConvergenceState).toHaveBeenCalledWith("pr-80", { force: true });
    });
  });

  it("does not start the legacy renderer poller while native Path to Merge owns the runtime", async () => {
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      pathToMergeActive: true,
      status: "polling",
      pollerStatus: "waiting_for_checks",
      currentRound: 2,
      activeSessionId: null,
    });

    const {
      loadConvergenceState,
      getChecks,
      getStatus,
      issueInventorySync,
    } = renderPane({
      checks: [makeCheck({ status: "in_progress", conclusion: null })],
      reviewThreads: [],
      convergenceState,
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 2, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: true },
      },
    });

    await waitFor(() => {
      expect(loadConvergenceState).toHaveBeenCalledWith("pr-80", { force: true });
    });

    getChecks.mockClear();
    getStatus.mockClear();
    issueInventorySync.mockClear();
    await React.act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20));
    });

    expect(getChecks).not.toHaveBeenCalled();
    expect(getStatus).not.toHaveBeenCalled();
    expect(issueInventorySync).not.toHaveBeenCalled();
  });

  it("refreshes stale convergence checks when opening the path to merge tab", async () => {
    const user = userEvent.setup();
    renderPane({
      checks: [makeCheck({ status: "in_progress", conclusion: null })],
      freshChecks: [makeCheck({ status: "completed", conclusion: "success" })],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem()],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));

    await waitFor(() => {
      expect((screen.getByRole("button", { name: /launch agent/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });

  it("disabling auto-converge during an active round stops the session and clears the handle", async () => {
    const user = userEvent.setup();
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "running",
      pollerStatus: "idle",
      currentRound: 2,
      activeSessionId: "session-2",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-2",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const { aiResolutionStop, saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      convergenceState,
      sessionStatus: "running",
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    await user.click(screen.getAllByRole("button", { name: /stop auto-converge/i })[0]!);

    await waitFor(() => {
      expect(aiResolutionStop).toHaveBeenCalledWith({ sessionId: "session-2" });
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        autoConvergeEnabled: false,
        status: "stopped",
        activeSessionId: null,
        activeHref: null,
      }));
    });
  });

  it("retains session handle when stop fails during auto-converge toggle off", async () => {
    const user = userEvent.setup();
    const convergenceState = makeConvergenceState({
      autoConvergeEnabled: true,
      status: "running",
      pollerStatus: "idle",
      currentRound: 2,
      activeSessionId: "session-2",
      activeLaneId: "lane-1",
      activeHref: "/work?laneId=lane-1&sessionId=session-2",
      lastStartedAt: "2026-03-23T12:29:00.000Z",
    });

    const { aiResolutionStop, saveConvergenceState } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      convergenceState,
      sessionStatus: "running",
    });

    aiResolutionStop.mockRejectedValueOnce(new Error("Network timeout"));

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    await user.click(screen.getAllByRole("button", { name: /stop auto-converge/i })[0]!);

    await waitFor(() => {
      expect(aiResolutionStop).toHaveBeenCalledWith({ sessionId: "session-2" });
      expect(saveConvergenceState).toHaveBeenCalledWith("pr-80", expect.objectContaining({
        autoConvergeEnabled: false,
        status: "running",
        activeSessionId: "session-2",
        activeHref: "/work?laneId=lane-1&sessionId=session-2",
        errorMessage: "Network timeout",
      }));
    });
  });

  it("refreshes convergence inventory from the header refresh button without leaving the tab", async () => {
    const user = userEvent.setup();
    const {
      getReviewThreads,
      issueInventorySync,
      onRefresh,
    } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem({ headline: "Initial review inventory" })],
        convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    expect(await screen.findByText("Initial review inventory")).toBeTruthy();

    issueInventorySync.mockResolvedValueOnce({
      items: [makeInventoryItem({ id: "inv-2", externalId: "thread:2", headline: "Refreshed review inventory" })],
      convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
    });
    onRefresh.mockClear();
    getReviewThreads.mockClear();
    issueInventorySync.mockClear();

    await user.click(screen.getByRole("button", { name: /^refresh$/i }));

    expect(await screen.findByText("Refreshed review inventory")).toBeTruthy();
    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
      expect(getReviewThreads).toHaveBeenCalledTimes(1);
      expect(issueInventorySync).toHaveBeenCalledTimes(1);
    });
  });

  it("rebuilds convergence inventory immediately after reset instead of leaving the panel blank", async () => {
    const user = userEvent.setup();
    const {
      issueInventoryReset,
      issueInventorySync,
      resetConvergenceState,
    } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      inventorySnapshot: {
        items: [makeInventoryItem({ headline: "Stale review inventory" })],
        convergence: { currentRound: 2, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: true },
      },
    });

    await user.click(screen.getByRole("button", { name: /path to merge/i }));
    expect(await screen.findByText("Stale review inventory")).toBeTruthy();

    issueInventorySync.mockResolvedValueOnce({
      items: [makeInventoryItem({ id: "inv-3", externalId: "thread:3", headline: "Rebuilt review inventory" })],
      convergence: { currentRound: 0, maxRounds: 5, totalNew: 1, totalSentToAgent: 0, isConverging: false },
    });
    issueInventorySync.mockClear();

    await user.click(screen.getByRole("button", { name: /reset inventory/i }));

    expect(await screen.findByText("Rebuilt review inventory")).toBeTruthy();
    await waitFor(() => {
      expect(issueInventoryReset).toHaveBeenCalledWith("pr-80");
      expect(resetConvergenceState).toHaveBeenCalledWith("pr-80");
      expect(issueInventorySync).toHaveBeenCalledTimes(1);
    });
  });

  it("loads review threads before and when opening the resolver", async () => {
    const user = userEvent.setup();
    const { getReviewThreads } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
    });

    await waitFor(() => {
      expect(getReviewThreads).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));

    await waitFor(() => {
      expect(getReviewThreads).toHaveBeenCalledTimes(2);
    });
  });

  it("copies the prepared resolver prompt to the clipboard", async () => {
    const user = userEvent.setup();
    const { issueResolutionPreviewPrompt, writeClipboardText } = renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
    });

    await user.click(screen.getByRole("button", { name: /ci \/ checks/i }));
    await user.click(await screen.findByRole("button", { name: /resolve issues with agent/i }));
    await user.click(screen.getByRole("button", { name: /copy resolver prompt/i }));

    await waitFor(() => {
      expect(issueResolutionPreviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
        prId: "pr-80",
        scope: "checks",
        additionalInstructions: "extra context",
      }));
      expect(writeClipboardText).toHaveBeenCalledWith("Prepared issue resolver prompt");
    });
  });

  it("renders review activity bodies as markdown instead of raw source text", async () => {
    renderPane({
      checks: [makeCheck()],
      reviewThreads: [],
      reviews: [
        makeReview({
          reviewer: "coderabbitai[bot]",
          state: "commented",
          body: "**Actionable comments posted: 3**\n\n<details><summary>Prompt for AI Agents</summary>Use the current code.</details>",
        }),
      ],
    });

    // Bot reviews that carry a body now render expanded by default (Linear-style),
    // so the markdown body is visible without toggling the card open.
    await screen.findByRole("button", { name: /coderabbit/i });

    expect(await screen.findByText("Actionable comments posted: 3")).toBeTruthy();
    expect(screen.queryByText(/\*\*Actionable comments posted: 3\*\*/)).toBeNull();
    expect(screen.getByText("Prompt for AI Agents")).toBeTruthy();
  });

  it("routes detail fetches to coordinate endpoints and shows the create/map banner for an unmapped PR", async () => {
    const coords = { repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 200 };
    const getDetailByGithub = vi.fn().mockResolvedValue({
      prId: "gh:ade-dev/ade#200",
      body: "Unmapped PR body",
      labels: [],
      assignees: [],
      requestedReviewers: [],
      author: { login: "octocat", avatarUrl: null },
      isDraft: false,
      milestone: null,
      linkedIssues: [],
    });
    const getFilesByGithub = vi.fn().mockResolvedValue([]);
    const getCommitsByGithub = vi.fn().mockResolvedValue([]);
    const getActionRunsByGithub = vi.fn().mockResolvedValue([]);
    const getActivityByGithub = vi.fn().mockResolvedValue([]);
    const getReviewThreadsByGithub = vi.fn().mockResolvedValue([]);
    // Row-based variants must NOT be called for an unmapped PR.
    const getDetail = vi.fn().mockResolvedValue(null);
    const loadConvergenceState = vi.fn();
    const onCreateLane = vi.fn();

    mockUsePrs.mockReturnValue({
      convergenceStatesByPrId: {},
      detailReviewThreads: [],
      loadConvergenceState,
      saveConvergenceState: vi.fn(),
      resetConvergenceState: vi.fn(),
      rebaseNeeds: [],
      resolverModel: "openai/gpt-5.4",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
      dismissedAiSummaries: {},
      timelineFiltersByPrId: {},
      detailAiSummary: null,
      detailDeployments: [],
      detailLiveDataPrId: null,
      viewerLogin: "octocat",
      setTimelineFilters: vi.fn(),
      setAiSummaryDismissed: vi.fn(),
      regeneratePrAiSummary: vi.fn(),
    });

    Object.assign(window, {
      ade: {
        prs: {
          getDetail,
          getFiles: vi.fn().mockResolvedValue([]),
          getCommits: vi.fn().mockResolvedValue([]),
          getActionRuns: vi.fn().mockResolvedValue([]),
          getActivity: vi.fn().mockResolvedValue([]),
          getReviewThreads: vi.fn().mockResolvedValue([]),
          getDetailByGithub,
          getFilesByGithub,
          getCommitsByGithub,
          getActionRunsByGithub,
          getActivityByGithub,
          getReviewThreadsByGithub,
          getChecks: vi.fn().mockResolvedValue([]),
          getStatus: vi.fn().mockResolvedValue(null),
          onAiResolutionEvent: vi.fn(() => () => {}),
        },
        app: { openExternal: vi.fn(), writeClipboardText: vi.fn() },
        lanes: { list: vi.fn().mockResolvedValue([]) },
        git: { getSyncStatus: vi.fn() },
        sessions: { get: vi.fn() },
      },
    });

    render(
      <MemoryRouter>
        <PrDetailPane
          pr={makePr({ id: "gh:ade-dev/ade#200", laneId: "" })}
          status={null}
          checks={[]}
          reviews={[]}
          comments={[]}
          detailBusy={false}
          lanes={[]}
          mergeMethod="squash"
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onNavigate={vi.fn()}
          unmapped
          githubCoords={coords}
          unmappedAffordance={{
            linkableLanes: [],
            selectedLaneId: "",
            onSelectLane: vi.fn(),
            onLink: vi.fn(),
            linkBusy: false,
            canCreateLane: true,
            onCreateLane,
            scope: "repo",
          }}
        />
      </MemoryRouter>,
    );

    // Coordinate endpoints are used; the row-based getDetail is never called.
    await waitFor(() => {
      expect(getDetailByGithub).toHaveBeenCalledWith(coords);
    });
    expect(getDetail).not.toHaveBeenCalled();
    // Lane-dependent convergence load is skipped for unmapped PRs.
    expect(loadConvergenceState).not.toHaveBeenCalled();

    // The create/map banner renders and wires the create-lane action.
    const banner = await screen.findByTestId("pr-unmapped-affordance");
    const user = userEvent.setup();
    await user.click(within(banner).getByRole("button", { name: /create lane from pr branch/i }));
    expect(onCreateLane).toHaveBeenCalled();
  });
});
