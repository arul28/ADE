// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LaneSummary,
  PrAiSummary,
  PrDeployment,
  PrReviewThread,
  PrStatus,
  PrWithConflicts,
} from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../shared/PrIssueResolverModal", () => ({
  PrIssueResolverModal: ({ open }: { open: boolean }) => (open ? <div data-testid="issue-resolver-modal-open" /> : null),
}));

import { PrDetailPane } from "./PrDetailPane";

function makePr(): PrWithConflicts {
  return {
    id: "pr-200",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 200,
    githubUrl: "https://github.com/ade-dev/ade/pull/200",
    githubNodeId: "PR_kwDOExample",
    title: "Timeline rails integration smoke",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/pr-200",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 10,
    deletions: 2,
    lastSyncedAt: "2026-04-14T10:00:00.000Z",
    createdAt: "2026-04-14T09:00:00.000Z",
    updatedAt: "2026-04-14T10:00:00.000Z",
    conflictAnalysis: null,
  };
}

function makeLane(): LaneSummary {
  return {
    id: "lane-1",
    name: "feature/pr-200",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/pr-200",
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
    createdAt: "2026-04-14T09:00:00.000Z",
    archivedAt: null,
  };
}

function makeStatus(): PrStatus {
  return {
    prId: "pr-200",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    isMergeable: true,
    mergeConflicts: false,
    behindBaseBy: 0,
  };
}

const reviewThread: PrReviewThread = {
  id: "thread-smoke-1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 10,
  originalLine: 10,
  startLine: null,
  originalStartLine: null,
  diffSide: "RIGHT",
  url: null,
  createdAt: "2026-04-14T09:30:00.000Z",
  updatedAt: "2026-04-14T09:30:00.000Z",
  comments: [
    {
      id: "c-1",
      author: "reviewer",
      authorAvatarUrl: null,
      body: "Consider renaming this.",
      url: null,
      createdAt: "2026-04-14T09:30:00.000Z",
      updatedAt: "2026-04-14T09:30:00.000Z",
    },
  ],
};

const deployment: PrDeployment = {
  id: "deploy-1",
  environment: "preview",
  state: "success",
  description: null,
  environmentUrl: "https://preview.example.com",
  logUrl: null,
  sha: "abc123",
  ref: "feature/pr-200",
  creator: "bot",
  createdAt: "2026-04-14T09:45:00.000Z",
  updatedAt: "2026-04-14T09:45:00.000Z",
};

const aiSummary: PrAiSummary = {
  prId: "pr-200",
  summary: "This PR tightens timeline rails integration.",
  riskAreas: ["State fetch order"],
  reviewerHotspots: ["PrsContext.tsx"],
  unresolvedConcerns: [],
  generatedAt: "2026-04-14T10:00:00.000Z",
  headSha: "abc123",
};

function installAdeMock() {
  Object.assign(window, {
    ade: {
      prs: {
        getDetail: vi.fn().mockResolvedValue({
          prId: "pr-200",
          body: "This is the PR description body.",
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
        getActivity: vi.fn().mockResolvedValue([]),
        getReviewThreads: vi.fn().mockResolvedValue([reviewThread]),
        getChecks: vi.fn().mockResolvedValue([]),
        getStatus: vi.fn().mockResolvedValue(makeStatus()),
        issueInventorySync: vi.fn().mockResolvedValue({
          items: [],
          convergence: { currentRound: 0, maxRounds: 5, totalNew: 0, totalSentToAgent: 0, isConverging: false },
        }),
        issueInventoryReset: vi.fn().mockResolvedValue(undefined),
        pipelineSettingsGet: vi.fn().mockResolvedValue({
          autoMerge: false,
          mergeMethod: "repo_default",
          maxRounds: 5,
          onRebaseNeeded: "pause",
        }),
        onAiResolutionEvent: vi.fn(() => () => {}),
        openInGitHub: vi.fn().mockResolvedValue(undefined),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([makeLane()]),
      },
      git: {
        getSyncStatus: vi.fn().mockResolvedValue({
          hasUpstream: true,
          upstreamRef: "origin/feature/pr-200",
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "none",
        }),
      },
      app: {
        openExternal: vi.fn(),
        writeClipboardText: vi.fn().mockResolvedValue(undefined),
      },
      sessions: {
        get: vi.fn().mockResolvedValue(null),
      },
      ai: {
        getStatus: vi.fn().mockResolvedValue({ availableModels: [] }),
      },
    },
  });
}

describe("PrDetailPane Timeline+Rails overview", () => {
  beforeEach(() => {
    installAdeMock();
    mockUsePrs.mockReturnValue({
      convergenceStatesByPrId: {},
      loadConvergenceState: vi.fn().mockResolvedValue(null),
      saveConvergenceState: vi.fn().mockResolvedValue(null),
      resetConvergenceState: vi.fn().mockResolvedValue(undefined),
      rebaseNeeds: [],
      resolverModel: "openai/gpt-5.4-codex",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
      prsTimelineRailsEnabled: true,
      dismissedAiSummaries: {},
      timelineFiltersByPrId: {},
      viewerLogin: "octocat",
      detailAiSummary: aiSummary,
      detailReviewThreads: [reviewThread],
      detailDeployments: [deployment],
      setTimelineFilters: vi.fn(),
      setAiSummaryDismissed: vi.fn(),
      regeneratePrAiSummary: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders timeline + commit rail + status rail when the flag is enabled", async () => {
    render(
      <MemoryRouter>
        <PrDetailPane
          pr={makePr()}
          status={makeStatus()}
          checks={[]}
          reviews={[]}
          comments={[]}
          detailBusy={false}
          lanes={[makeLane()]}
          mergeMethod="squash"
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onNavigate={vi.fn()}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-timeline-rails")).toBeTruthy();
      expect(screen.getByTestId("pr-commit-rail")).toBeTruthy();
      expect(screen.getByTestId("pr-timeline")).toBeTruthy();
      expect(screen.getByTestId("pr-status-rail")).toBeTruthy();
    });
  });

  it("falls back to the legacy overview when the flag is disabled", async () => {
    mockUsePrs.mockReturnValue({
      convergenceStatesByPrId: {},
      loadConvergenceState: vi.fn().mockResolvedValue(null),
      saveConvergenceState: vi.fn().mockResolvedValue(null),
      resetConvergenceState: vi.fn().mockResolvedValue(undefined),
      rebaseNeeds: [],
      resolverModel: "openai/gpt-5.4-codex",
      resolverReasoningLevel: "high",
      resolverPermissionMode: "guarded_edit",
      setResolverModel: vi.fn(),
      setResolverReasoningLevel: vi.fn(),
      setResolverPermissionMode: vi.fn(),
      prsTimelineRailsEnabled: false,
      dismissedAiSummaries: {},
      timelineFiltersByPrId: {},
      viewerLogin: "octocat",
      detailAiSummary: null,
      detailReviewThreads: [],
      detailDeployments: [],
      setTimelineFilters: vi.fn(),
      setAiSummaryDismissed: vi.fn(),
      regeneratePrAiSummary: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <MemoryRouter>
        <PrDetailPane
          pr={makePr()}
          status={makeStatus()}
          checks={[]}
          reviews={[]}
          comments={[]}
          detailBusy={false}
          lanes={[makeLane()]}
          mergeMethod="squash"
          onRefresh={vi.fn().mockResolvedValue(undefined)}
          onNavigate={vi.fn()}
        />
      </MemoryRouter>,
    );

    // The legacy Overview has the merge bar "MERGEABLE" text; Timeline rails container is absent.
    await waitFor(() => {
      expect(screen.queryByTestId("pr-detail-timeline-rails")).toBeNull();
    });
  });
});
