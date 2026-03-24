// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrSnapshot, LaneSummary, MergeMethod, PrWithConflicts } from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../detail/PrDetailPane", () => ({
  PrDetailPane: ({
    pr,
    queueContext,
  }: {
    pr: { id: string };
    queueContext?: { groupId: string } | null;
  }) => (
    <div data-testid="pr-detail-pane">
      {pr.id}
      {queueContext ? <span data-testid="queue-context">{queueContext.groupId}</span> : null}
    </div>
  ),
}));

import { GitHubTab } from "./GitHubTab";

function makeGitHubPr(overrides: Partial<GitHubPrSnapshot["repoPullRequests"][number]> = {}): GitHubPrSnapshot["repoPullRequests"][number] {
  return {
    id: "repo-open",
    scope: "repo",
    repoOwner: "ade-dev",
    repoName: "ade",
    githubPrNumber: 101,
    githubUrl: "https://github.com/ade-dev/ade/pull/101",
    title: "Open PR",
    state: "open",
    isDraft: false,
    baseBranch: "main",
    headBranch: "feature/open",
    author: "octocat",
    createdAt: "2026-03-13T11:00:00.000Z",
    updatedAt: "2026-03-13T11:30:00.000Z",
    linkedPrId: "pr-open",
    linkedGroupId: null,
    linkedLaneId: "lane-open",
    linkedLaneName: "lane-open",
    adeKind: "single",
    workflowDisplayState: null,
    cleanupState: null,
    ...overrides,
  };
}

const snapshot: GitHubPrSnapshot = {
  repo: { owner: "ade-dev", name: "ade" },
  viewerLogin: "octocat",
  syncedAt: "2026-03-13T12:00:00.000Z",
  repoPullRequests: [
    makeGitHubPr(),
    makeGitHubPr({
      id: "repo-merged",
      githubPrNumber: 102,
      githubUrl: "https://github.com/ade-dev/ade/pull/102",
      title: "Merged PR",
      state: "merged",
      headBranch: "feature/merged",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
      linkedPrId: "pr-merged",
      linkedLaneId: "lane-merged",
      linkedLaneName: "lane-merged",
    }),
    makeGitHubPr({
      id: "repo-queue",
      githubPrNumber: 103,
      githubUrl: "https://github.com/ade-dev/ade/pull/103",
      title: "Queue PR",
      headBranch: "feature/queue",
      createdAt: "2026-03-13T10:30:00.000Z",
      updatedAt: "2026-03-13T11:45:00.000Z",
      linkedPrId: "pr-queue",
      linkedGroupId: "queue-group-1",
      linkedLaneId: "lane-queue",
      linkedLaneName: "lane-queue",
      adeKind: "queue",
    }),
  ],
  externalPullRequests: [],
};

describe("GitHubTab", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      prs: [
        { id: "pr-open" },
        { id: "pr-merged" },
        { id: "pr-queue" },
      ] satisfies Partial<PrWithConflicts>[],
      mergeContextByPrId: {
        "pr-queue": { groupType: "queue", groupId: "queue-group-1", members: [] },
      },
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
    });

    Object.assign(window, {
      ade: {
        prs: {
          getGitHubSnapshot: vi.fn().mockResolvedValue(snapshot),
          linkToLane: vi.fn(),
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

  function renderTab(overrides: Partial<{
    selectedPrId: string | null;
    onSelectPr: ReturnType<typeof vi.fn>;
    onOpenQueueView: ReturnType<typeof vi.fn>;
  }> = {}) {
    const onSelectPr = overrides.onSelectPr ?? vi.fn();
    const onOpenQueueView = overrides.onOpenQueueView ?? vi.fn();
    render(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={overrides.selectedPrId ?? null}
          onSelectPr={onSelectPr}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
          onOpenQueueView={onOpenQueueView}
        />
      </MemoryRouter>,
    );
    return { onSelectPr, onOpenQueueView };
  }

  it("does not auto-jump to a different PR when switching filters", async () => {
    const user = userEvent.setup();
    const { onSelectPr } = renderTab({ selectedPrId: "pr-merged" });

    await screen.findByText("Merged PR");

    await user.click(screen.getByRole("button", { name: /^open/i }));

    await waitFor(() => expect(onSelectPr).toHaveBeenLastCalledWith(null));
    expect(screen.queryByText("Merged PR")).toBeNull();
  });

  it("opens the linked queue from a queue-tagged GitHub row", async () => {
    const user = userEvent.setup();
    const { onOpenQueueView } = renderTab();

    const queueLinks = await screen.findAllByText("open queue");
    await user.click(queueLinks[0]!);

    expect(onOpenQueueView).toHaveBeenCalledWith("queue-group-1");
  });

  it("passes queue context into the normal PR detail pane", async () => {
    renderTab({ selectedPrId: "pr-queue" });

    await waitFor(() => {
      expect(screen.getByTestId("queue-context").textContent).toContain("queue-group-1");
    });
  });
});
