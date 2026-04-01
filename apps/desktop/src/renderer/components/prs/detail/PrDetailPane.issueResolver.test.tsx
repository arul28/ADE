// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  IssueInventoryItem,
  LaneSummary,
  PrActivityEvent,
  PrCheck,
  PrConvergenceState,
  PrReviewThread,
  PrStatus,
  PrWithConflicts,
} from "../../../../shared/types";

const mockUsePrs = vi.fn();

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

import { PrDetailPane } from "./PrDetailPane";

function makeCheck(overrides: Partial<PrCheck> = {}): PrCheck {
  return { name: "ci / unit", status: "completed", conclusion: "failure", detailsUrl: null, startedAt: null, completedAt: null, ...overrides };
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

function makePr(): PrWithConflicts {
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
  };
}

function makeLane(): LaneSummary {
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
  reviewThreads: PrReviewThread[];
  lanes?: LaneSummary[];
  onNavigate?: (path: string) => void;
  activity?: PrActivityEvent[];
  statusOverrides?: Partial<PrStatus>;
  mergeMethod?: "merge" | "squash" | "rebase";
  convergenceState?: PrConvergenceState | null;
  inventorySnapshot?: {
    items: IssueInventoryItem[];
    convergence: { currentRound: number; maxRounds: number; totalNew: number; totalSentToAgent: number; isConverging: boolean };
  };
}) {
  const issueResolutionStart = vi.fn().mockResolvedValue({
    sessionId: "session-1",
    laneId: "lane-1",
    href: "/work?laneId=lane-1&sessionId=session-1",
  });
  const issueResolutionPreviewPrompt = vi.fn().mockResolvedValue({
    title: "Resolve PR #80 issues",
    prompt: "Prepared issue resolver prompt",
  });
  const getReviewThreads = vi.fn().mockResolvedValue(args.reviewThreads);
  const writeClipboardText = vi.fn().mockResolvedValue(undefined);
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
  const convergenceState = args.convergenceState ?? null;
  const loadConvergenceState = vi.fn().mockResolvedValue(convergenceState);
  const saveConvergenceState = vi.fn().mockImplementation(async (_prId: string, state: Partial<PrConvergenceState>) => (
    convergenceState ? { ...convergenceState, ...state } : makeConvergenceState(state)
  ));
  const resetConvergenceState = vi.fn().mockResolvedValue(undefined);
  mockUsePrs.mockReturnValue({
    convergenceStatesByPrId: convergenceState ? { "pr-80": convergenceState } : {},
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    rebaseNeeds: [],
    resolverModel: "openai/gpt-5.4-codex",
    resolverReasoningLevel: "high",
    resolverPermissionMode: "guarded_edit",
    setResolverModel: vi.fn(),
    setResolverReasoningLevel: vi.fn(),
    setResolverPermissionMode: vi.fn(),
  });
  Object.assign(window, {
    ade: {
      prs: {
        getDetail: vi.fn().mockResolvedValue({
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
        getFiles: vi.fn().mockResolvedValue([]),
        getActionRuns: vi.fn().mockResolvedValue([]),
        getActivity: vi.fn().mockResolvedValue(args.activity ?? []),
        getReviewThreads,
        issueInventorySync: vi.fn().mockResolvedValue({
          items: args.inventorySnapshot?.items ?? [],
          convergence: args.inventorySnapshot?.convergence ?? { currentRound: 0, maxRounds: 5, totalNew: 0, totalSentToAgent: 0, isConverging: false },
        }),
        pipelineSettingsGet: vi.fn().mockResolvedValue({
          autoMerge: false,
          mergeMethod: "repo_default",
          maxRounds: 5,
          onRebaseNeeded: "pause",
        }),
        getChecks: vi.fn().mockResolvedValue(args.checks),
        getStatus: vi.fn().mockResolvedValue(args.statusOverrides ? makeStatus(args.statusOverrides) : makeStatus()),
        onAiResolutionEvent: vi.fn(() => () => {}),
        issueResolutionStart,
        issueResolutionPreviewPrompt,
        loadConvergenceState,
        saveConvergenceState,
        resetConvergenceState,
        land,
        openInGitHub: vi.fn().mockResolvedValue(undefined),
      },
      app: {
        openExternal: vi.fn(),
        writeClipboardText,
      },
      ai: {
        getStatus: vi.fn().mockResolvedValue({
          availableModels: [],
        }),
      },
    },
  });

  return {
    issueResolutionStart,
    issueResolutionPreviewPrompt,
    getReviewThreads,
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    writeClipboardText,
    land,
    onRefresh,
    ...render(
      <PrDetailPane
        pr={makePr()}
        status={makeStatus(args.statusOverrides)}
        checks={args.checks}
        reviews={[]}
        comments={[]}
        detailBusy={false}
        lanes={args.lanes ?? [makeLane()]}
        mergeMethod={args.mergeMethod ?? "squash"}
        onRefresh={onRefresh}
        onNavigate={args.onNavigate ?? vi.fn()}
      />,
    ),
  };
}

describe("PrDetailPane issue resolver CTA", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      convergenceStatesByPrId: {},
      loadConvergenceState: vi.fn(),
      saveConvergenceState: vi.fn(),
      resetConvergenceState: vi.fn(),
      rebaseNeeds: [],
      resolverModel: "openai/gpt-5.4-codex",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it.each(visibilityCases)("$name — Path to Merge tab is always visible", async ({ checks, reviewThreads, statusOverrides }) => {
    renderPane({ checks, reviewThreads, statusOverrides });

    // Path to Merge is now a permanent tab (2nd position), always rendered
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /path to merge/i })).toBeTruthy();
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
    renderPane({
      checks: [
        makeCheck({ name: "ci / unit", conclusion: "success" }),
        makeCheck({ name: "ci / e2e", conclusion: "failure" }),
        makeCheck({ name: "ci / lint", status: "in_progress", conclusion: null }),
      ],
      reviewThreads: [],
    });

    await waitFor(() => {
      expect(screen.getByText("Some checks failing")).toBeTruthy();
      expect(screen.getByText("1/3 checks passing, 1 still running")).toBeTruthy();
      expect(screen.getAllByLabelText("CI running").length).toBeGreaterThan(0);
    });
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

    const mergeButton = await screen.findByRole("button", { name: /merge pull request/i });
    expect((mergeButton as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole("button", { name: /create merge commit/i }));
    await user.click(screen.getByRole("checkbox", { name: /attempt merge anyway if github allows bypass rules/i }));

    const bypassButton = screen.getByRole("button", { name: /attempt merge anyway/i });
    expect((bypassButton as HTMLButtonElement).disabled).toBe(false);

    await user.click(bypassButton);

    await waitFor(() => {
      expect(land).toHaveBeenCalledWith({ prId: "pr-80", method: "merge" });
      expect(onRefresh).toHaveBeenCalled();
    });
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

    await user.click(screen.getByRole("button", { name: /path to merge/i }));

    await screen.findAllByRole("button", { name: /view session/i });

    secondRender.unmount();
  });

  it("reloads review threads when opening the resolver", async () => {
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
      activity: [
        {
          id: "review-1",
          type: "review",
          author: "coderabbitai[bot]",
          avatarUrl: null,
          body: "**Actionable comments posted: 3**\n\n<details><summary>Prompt for AI Agents</summary>Use the current code.</details>",
          timestamp: "2026-03-23T12:00:00.000Z",
          metadata: { state: "commented" },
        },
      ],
    });

    expect(await screen.findByText("Actionable comments posted: 3")).toBeTruthy();
    expect(screen.queryByText(/\*\*Actionable comments posted: 3\*\*/)).toBeNull();
    expect(screen.getByText("Prompt for AI Agents")).toBeTruthy();
  });
});
