// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrSnapshot, LaneSummary, MergeMethod, PrWithConflicts } from "../../../../shared/types";

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

vi.mock("../detail/PrDetailPane", () => ({
  PrDetailPane: ({ pr }: { pr: { id: string } }) => <div data-testid="pr-detail-pane">{pr.id}</div>,
}));

import { GitHubTab } from "./GitHubTab";

const snapshot: GitHubPrSnapshot = {
  repo: { owner: "ade-dev", name: "ade" },
  viewerLogin: "octocat",
  syncedAt: "2026-03-13T12:00:00.000Z",
  repoPullRequests: [
    {
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
    },
    {
      id: "repo-merged",
      scope: "repo",
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 102,
      githubUrl: "https://github.com/ade-dev/ade/pull/102",
      title: "Merged PR",
      state: "merged",
      isDraft: false,
      baseBranch: "main",
      headBranch: "feature/merged",
      author: "octocat",
      createdAt: "2026-03-13T09:00:00.000Z",
      updatedAt: "2026-03-13T10:00:00.000Z",
      linkedPrId: "pr-merged",
      linkedGroupId: null,
      linkedLaneId: "lane-merged",
      linkedLaneName: "lane-merged",
      adeKind: "single",
      workflowDisplayState: null,
      cleanupState: null,
    },
  ],
  externalPullRequests: [],
};

describe("GitHubTab", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      prs: [
        { id: "pr-open" },
        { id: "pr-merged" },
      ] satisfies Partial<PrWithConflicts>[],
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

  it("lets you return to the open filter after a merged PR was selected", async () => {
    const user = userEvent.setup();
    const onSelectPr = vi.fn();

    render(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId="pr-merged"
          onSelectPr={onSelectPr}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await screen.findByText("Merged PR");

    await user.click(screen.getByRole("button", { name: /^open/i }));

    await waitFor(() => expect(onSelectPr).toHaveBeenLastCalledWith("pr-open"));
    await waitFor(() => expect(screen.getByText("Open PR")).toBeTruthy());
    expect(screen.queryByText("Merged PR")).toBeNull();
  });
});
