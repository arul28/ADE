// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    labels: [],
    isBot: false,
    commentCount: 0,
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
        { id: "pr-open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3 },
        { id: "pr-merged", checksStatus: "passing", reviewStatus: "approved", additions: 5, deletions: 1 },
        { id: "pr-queue", checksStatus: "passing", reviewStatus: "approved", additions: 7, deletions: 2 },
      ] satisfies Partial<PrWithConflicts>[],
      mergeContextByPrId: {
        "pr-queue": { groupType: "queue", groupId: "queue-group-1", members: [] },
      },
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: false,
      setViewerLogin: vi.fn(),
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
    vi.useRealTimers();
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

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-merged");
    });

    await user.click(screen.getByRole("button", { name: /^open/i }));

    await waitFor(() => expect(onSelectPr).toHaveBeenLastCalledWith(null));
    expect(screen.queryByTestId("pr-detail-pane")).toBeNull();
  });

  it("opens the linked queue from a queue-tagged GitHub row", async () => {
    const user = userEvent.setup();
    const { onOpenQueueView } = renderTab();

    const queueLinks = await screen.findAllByText("open queue");
    await user.click(queueLinks[0]!);

    expect(onOpenQueueView).toHaveBeenCalledWith("queue-group-1");
  });

  it("shares the snapshot viewer login with PR context", async () => {
    const setViewerLogin = vi.fn();
    mockUsePrs.mockReturnValue({
      prs: [],
      mergeContextByPrId: {},
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: false,
      setViewerLogin,
    });

    renderTab();

    await waitFor(() => {
      expect(setViewerLogin).toHaveBeenCalledWith("octocat");
    });
  });

  it("passes queue context into the normal PR detail pane", async () => {
    renderTab({ selectedPrId: "pr-queue" });

    await waitFor(() => {
      expect(screen.getByTestId("queue-context").textContent).toContain("queue-group-1");
    });
  });

  it("shows a running CI indicator for PR cards with pending checks", async () => {
    renderTab();

    await waitFor(() => {
      expect(screen.getAllByLabelText("CI running").length).toBeGreaterThan(0);
    });
  });

  it("does not force-refresh the GitHub snapshot when linked PRs hydrate after mount", async () => {
    const emptyContext = {
      prs: [],
      mergeContextByPrId: {},
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: true,
    };
    const loadedContext = {
      ...emptyContext,
      prs: [
        { id: "pr-open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3 },
      ],
      loading: false,
    };
    mockUsePrs.mockReturnValue(emptyContext);
    const { rerender } = render(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });

    mockUsePrs.mockReturnValue(loadedContext);
    rerender(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
    });
    expect(window.ade.prs.getGitHubSnapshot).not.toHaveBeenCalledWith({ force: true });
  });

  it("does not force-refresh the GitHub snapshot immediately after a fresh snapshot load", async () => {
    const loadedContext = {
      prs: [
        { id: "pr-open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3, updatedAt: "2026-03-13T11:30:00.000Z" },
      ],
      mergeContextByPrId: {},
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: false,
      setViewerLogin: vi.fn(),
    };
    mockUsePrs.mockReturnValue(loadedContext);
    const { rerender } = render(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });

    mockUsePrs.mockReturnValue({
      ...loadedContext,
      prs: [
        { ...loadedContext.prs[0]!, updatedAt: "2026-03-13T11:31:00.000Z" },
      ],
    });
    rerender(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
    });
    expect(window.ade.prs.getGitHubSnapshot).not.toHaveBeenCalledWith({ force: true });
  });

  it("does not force-refresh the GitHub snapshot for CI/review-only PR status updates", async () => {
    const loadedContext = {
      prs: [
        { id: "pr-open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3, updatedAt: "2026-03-13T11:30:00.000Z" },
      ],
      mergeContextByPrId: {},
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: false,
      setViewerLogin: vi.fn(),
    };
    mockUsePrs.mockReturnValue(loadedContext);
    const { rerender } = render(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });

    vi.useFakeTimers();
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();
    await vi.advanceTimersByTimeAsync(31_000);

    mockUsePrs.mockReturnValue({
      ...loadedContext,
      prs: [
        {
          ...loadedContext.prs[0]!,
          checksStatus: "passing",
          reviewStatus: "approved",
          updatedAt: "2026-03-13T11:31:00.000Z",
        },
      ],
    });
    rerender(
      <MemoryRouter>
        <GitHubTab
          lanes={[] satisfies LaneSummary[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={null}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>,
    );
    await vi.advanceTimersByTimeAsync(31_000);

    expect(window.ade.prs.getGitHubSnapshot).not.toHaveBeenCalled();
  });

  it("paces hot snapshot refreshes after manual sync", async () => {
    renderTab();

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
    vi.useFakeTimers();
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^sync$/i }));

    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps loaded closed history during manual sync after returning to the open filter", async () => {
    const user = userEvent.setup();
    renderTab();

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });

    await user.click(screen.getByRole("button", { name: /^merged/i }));
    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: false,
        includeExternalClosed: true,
      });
    });

    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();
    await user.click(screen.getByRole("button", { name: /^open/i }));
    await user.click(screen.getByRole("button", { name: /^sync$/i }));

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: true,
        includeExternalClosed: true,
      });
    });
  });

  it("does not let a superseded open-only snapshot overwrite loaded closed history", async () => {
    const user = userEvent.setup();
    const openOnlySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr()],
      externalPullRequests: [],
    };
    const fullHistorySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr(),
        makeGitHubPr({
          id: "repo-merged",
          githubPrNumber: 102,
          title: "Merged PR",
          state: "merged",
          linkedPrId: "pr-merged",
          linkedLaneId: "lane-merged",
        }),
      ],
    };
    let resolveOpenOnly!: (snapshot: GitHubPrSnapshot) => void;
    let resolveFullHistory!: (snapshot: GitHubPrSnapshot) => void;
    const openOnlyRequest = new Promise<GitHubPrSnapshot>((resolve) => {
      resolveOpenOnly = resolve;
    });
    const fullHistoryRequest = new Promise<GitHubPrSnapshot>((resolve) => {
      resolveFullHistory = resolve;
    });
    const getGitHubSnapshot = window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>;
    getGitHubSnapshot.mockReset();
    getGitHubSnapshot
      .mockResolvedValueOnce(openOnlySnapshot)
      .mockReturnValueOnce(openOnlyRequest)
      .mockReturnValueOnce(fullHistoryRequest);

    renderTab();

    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
    await screen.findByText("Open PR");

    await user.click(screen.getByRole("button", { name: /^sync$/i }));
    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    });
    await user.click(screen.getByRole("button", { name: /^merged/i }));
    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({
        force: false,
        includeExternalClosed: true,
      });
    });

    resolveFullHistory(fullHistorySnapshot);
    await screen.findByText("Merged PR");

    resolveOpenOnly(openOnlySnapshot);
    await waitFor(() => {
      expect(screen.getByText("Merged PR")).toBeTruthy();
    });
  });

  it("filters by ADE scope showing only linked PRs", async () => {
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    const user = userEvent.setup();
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /^ADE/i }));

    await waitFor(() => {
      expect(screen.queryByText("Unlinked PR")).toBeNull();
      expect(screen.getByText("Open PR")).not.toBeNull();
    });
  });

  it("filters by External scope showing only unlinked PRs", async () => {
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        ...snapshot.repoPullRequests,
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    const user = userEvent.setup();
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: /^External/i }));

    await waitFor(() => {
      expect(screen.queryByText("Open PR")).toBeNull();
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });
  });

  it("renders bot badge when isBot is true", async () => {
    const snapshotWithBot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "bot-pr",
          githubPrNumber: 300,
          title: "Bot PR",
          author: "dependabot[bot]",
          isBot: true,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithBot);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("bot")).not.toBeNull();
    });
  });

  it("renders labels when present", async () => {
    const snapshotWithLabels: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "labeled-pr",
          githubPrNumber: 400,
          title: "Labeled PR",
          labels: [
            { name: "bug", color: "d73a4a", description: null },
            { name: "enhancement", color: "a2eeef", description: null },
          ],
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithLabels);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("bug")).not.toBeNull();
      expect(screen.getByText("enhancement")).not.toBeNull();
    });
  });

  it("renders comment count when greater than zero", async () => {
    const snapshotWithComments: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "commented-pr",
          githubPrNumber: 500,
          title: "Commented PR",
          commentCount: 42,
          createdAt: "2026-03-13T12:00:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithComments);
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("42")).not.toBeNull();
    });
  });

  it("sorts PRs by createdAt descending", async () => {
    const snapshotOrdered: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({ id: "pr-old", githubPrNumber: 50, title: "Old PR", createdAt: "2026-03-13T08:00:00.000Z" }),
        makeGitHubPr({ id: "pr-new", githubPrNumber: 150, title: "New PR", createdAt: "2026-03-13T12:00:00.000Z" }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotOrdered);
    renderTab();

    await waitFor(() => {
      const buttons = screen.getAllByRole("button").filter((btn) =>
        btn.textContent?.includes("PR") && (btn.textContent?.includes("Old") || btn.textContent?.includes("New")),
      );
      expect(buttons.length).toBe(2);
      expect(buttons[0]!.textContent).toContain("New PR");
      expect(buttons[1]!.textContent).toContain("Old PR");
    });
  });
});
