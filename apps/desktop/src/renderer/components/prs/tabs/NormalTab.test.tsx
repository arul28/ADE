// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrMergeContext, PrWithConflicts } from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../detail/PrDetailPane", () => ({
  PrDetailPane: ({ pr }: { pr: { id: string } }) => (
    <div data-testid="pr-detail-pane">{pr.id}</div>
  ),
}));

vi.mock("../shared/IntegrationPrContextPanel", () => ({
  IntegrationPrContextPanel: () => null,
}));

import { NormalTab } from "./NormalTab";

function makePr(overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "proj-1",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 101,
    githubUrl: "https://github.com/ade-dev/ade/pull/101",
    githubNodeId: "PR_101",
    title: "Test PR",
    state: "open",
    baseBranch: "main",
    headBranch: "feature/test",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 10,
    deletions: 3,
    lastSyncedAt: "2026-03-24T00:00:00.000Z",
    createdAt: "2026-03-24T00:00:00.000Z",
    updatedAt: "2026-03-24T00:00:00.000Z",
    conflictAnalysis: null,
    ...overrides,
  };
}

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "feature/test",
    description: "Test lane",
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/test",
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
    createdAt: "2026-03-24T00:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

describe("NormalTab", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      setActiveTab: vi.fn(),
      setSelectedRebaseItemId: vi.fn(),
    });

    Object.assign(window, {
      ade: {
        prs: {
          getDetail: vi.fn().mockResolvedValue({
            prId: "pr-1",
            body: "",
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
          getReviewThreads: vi.fn().mockResolvedValue([]),
          land: vi.fn(),
          openInGitHub: vi.fn(),
        },
        app: {
          openExternal: vi.fn(),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderTab(overrides: {
    prs?: PrWithConflicts[];
    lanes?: LaneSummary[];
    mergeContextByPrId?: Record<string, PrMergeContext>;
    selectedPrId?: string | null;
  } = {}) {
    const onSelectPr = vi.fn();
    render(
      <MemoryRouter>
        <NormalTab
          prs={overrides.prs ?? [makePr()]}
          lanes={overrides.lanes ?? [makeLane()]}
          mergeContextByPrId={overrides.mergeContextByPrId ?? {}}
          mergeMethod="squash"
          selectedPrId={overrides.selectedPrId ?? null}
          onSelectPr={onSelectPr}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );
    return { onSelectPr };
  }

  it("shows the CI running indicator for PRs with pending checks", async () => {
    renderTab({
      prs: [makePr({ checksStatus: "pending" })],
    });

    await waitFor(() => {
      expect(screen.getAllByLabelText("CI running").length).toBeGreaterThan(0);
    });
  });

  it("does not show the CI running indicator for PRs with passing checks", async () => {
    renderTab({
      prs: [makePr({ checksStatus: "passing" })],
    });

    await waitFor(() => {
      expect(screen.getByText("Test PR")).toBeTruthy();
    });

    expect(screen.queryByLabelText("CI running")).toBeNull();
  });

  it("shows the CI running indicator only for PRs that have pending checks when mixed", async () => {
    renderTab({
      prs: [
        makePr({ id: "pr-1", checksStatus: "passing", title: "Passing PR", githubPrNumber: 101 }),
        makePr({ id: "pr-2", laneId: "lane-2", checksStatus: "pending", title: "Pending PR", githubPrNumber: 102 }),
      ],
      lanes: [
        makeLane(),
        makeLane({ id: "lane-2", name: "feature/pending" }),
      ],
    });

    await waitFor(() => {
      expect(screen.getByText("Passing PR")).toBeTruthy();
      expect(screen.getByText("Pending PR")).toBeTruthy();
    });

    // Exactly one CI running indicator for the pending PR
    expect(screen.getAllByLabelText("CI running")).toHaveLength(1);
  });
});
