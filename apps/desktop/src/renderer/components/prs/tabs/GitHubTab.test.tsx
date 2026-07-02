// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateLaneFromPrBranchPreflightResult, GitHubPrSnapshot, LaneSummary, MergeMethod, PrWithConflicts } from "../../../../shared/types";

vi.mock("react-resizable-panels", () => ({
  Group: ({ children }: { children: React.ReactNode }) => <div data-testid="github-tab-layout">{children}</div>,
  Panel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement> & { id?: string }) => (
    <div data-testid={props.id} {...props}>
      {children}
    </div>
  ),
  Separator: (props: React.HTMLAttributes<HTMLDivElement>) => <div role="separator" {...props} />,
}));

const mockUsePrs = vi.fn();

vi.mock("../state/PrsContext", () => ({
  usePrs: () => mockUsePrs(),
}));

type MockUnmappedAffordance = {
  linkableLanes: Array<{ id: string; name: string }>;
  selectedLaneId: string;
  onSelectLane: (laneId: string) => void;
  onLink: () => void;
  linkBusy: boolean;
  canCreateLane: boolean;
  onCreateLane: () => void;
  scope: "repo" | "external";
};

vi.mock("../detail/PrDetailPane", () => ({
  PrDetailPane: ({
    pr,
    queueContext,
    onUnmap,
    unmapped,
    unmappedAffordance,
  }: {
    pr: { id: string };
    queueContext?: { groupId: string } | null;
    onUnmap?: () => void;
    unmapped?: boolean;
    unmappedAffordance?: MockUnmappedAffordance | null;
  }) => (
    <div data-testid="pr-detail-pane" data-unmapped={unmapped ? "true" : "false"}>
      {pr.id}
      {queueContext ? <span data-testid="queue-context">{queueContext.groupId}</span> : null}
      {onUnmap ? <button type="button" onClick={onUnmap}>Unmap from lane</button> : null}
      {unmappedAffordance ? (
        <div data-testid="pr-unmapped-affordance">
          {unmappedAffordance.canCreateLane ? (
            <button type="button" onClick={unmappedAffordance.onCreateLane}>
              Create lane from PR branch
            </button>
          ) : null}
          {unmappedAffordance.linkableLanes.length > 0 ? (
            <>
              <select
                aria-label="Select lane to map"
                value={unmappedAffordance.selectedLaneId}
                onChange={(event) => unmappedAffordance.onSelectLane(event.target.value)}
              >
                <option value="">Map to lane…</option>
                {unmappedAffordance.linkableLanes.map((lane) => (
                  <option key={lane.id} value={lane.id}>{lane.name}</option>
                ))}
              </select>
              <button
                type="button"
                disabled={!unmappedAffordance.selectedLaneId || unmappedAffordance.linkBusy}
                onClick={unmappedAffordance.onLink}
              >
                Map
              </button>
            </>
          ) : null}
        </div>
      ) : null}
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

function makeLaneSummary(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-open",
    name: "lane-open",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "refs/heads/feature/open",
    worktreePath: "/tmp/lane-open",
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
    createdAt: "2026-03-13T10:00:00.000Z",
    archivedAt: null,
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

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makePreflightResult(args: {
  githubPrNumber: number;
  title: string;
  headBranch: string;
  remoteBranch: string;
}): CreateLaneFromPrBranchPreflightResult {
  return {
    preflight: {
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: args.githubPrNumber,
      githubUrl: `https://github.com/ade-dev/ade/pull/${args.githubPrNumber}`,
      title: args.title,
      headBranch: args.headBranch,
      headRepoOwner: "ade-dev",
      headRepoName: "ade",
      headSha: "head-sha",
      remoteBranch: args.remoteBranch,
      importBranchRef: args.remoteBranch,
      targetLaneName: args.title,
      baseBranch: "main",
      canCreate: true,
      status: "ready",
      blockingConflict: null,
      blockingConflicts: [],
    },
    lane: null,
    pr: null,
  };
}

describe("GitHubTab", () => {
  beforeEach(() => {
    mockUsePrs.mockReturnValue({
      prs: [
        { id: "pr-open", state: "open", checksStatus: "pending", reviewStatus: "requested", additions: 12, deletions: 3 },
        { id: "pr-merged", state: "merged", checksStatus: "passing", reviewStatus: "approved", additions: 5, deletions: 1 },
        { id: "pr-queue", state: "open", checksStatus: "passing", reviewStatus: "approved", additions: 7, deletions: 2 },
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
          onEvent: vi.fn(() => () => {}),
          linkToLane: vi.fn(),
          preflightCreateLaneFromPrBranch: vi.fn().mockResolvedValue({
            preflight: {
              repoOwner: "ade-dev",
              repoName: "ade",
              githubPrNumber: 200,
              githubUrl: "https://github.com/ade-dev/ade/pull/200",
              title: "Unlinked PR",
              headBranch: "feature/open",
              headRepoOwner: "ade-dev",
              headRepoName: "ade",
              remoteBranch: "origin/feature/open",
              importBranchRef: "origin/feature/open",
              targetLaneName: "Unlinked PR",
              baseBranch: "main",
              canCreate: true,
              status: "ready",
              blockingConflict: null,
              blockingConflicts: [],
            },
            lane: null,
            pr: null,
          }),
          createLaneFromPrBranch: vi.fn().mockResolvedValue({
            preflight: {
              repoOwner: "ade-dev",
              repoName: "ade",
              githubPrNumber: 200,
              githubUrl: "https://github.com/ade-dev/ade/pull/200",
              title: "Unlinked PR",
              headBranch: "feature/open",
              headRepoOwner: "ade-dev",
              headRepoName: "ade",
              remoteBranch: "origin/feature/open",
              importBranchRef: "origin/feature/open",
              targetLaneName: "Unlinked PR",
              baseBranch: "main",
              canCreate: true,
              status: "ready",
              blockingConflict: null,
              blockingConflicts: [],
            },
            lane: { id: "lane-created", name: "Unlinked PR" },
            pr: { id: "pr-created", laneId: "lane-created" },
          }),
          delete: vi.fn().mockResolvedValue(undefined),
        },
        github: {
          getStatus: vi.fn().mockResolvedValue({
            tokenStored: true,
            patTokenStored: true,
            tokenDecryptionFailed: false,
            storageScope: "app",
            authSource: "pat",
            tokenType: "classic",
            repo: { owner: "ade-dev", name: "ade" },
            hasOrigin: true,
            userLogin: "octocat",
            scopes: [],
            ghCliPath: null,
            ghAuthError: null,
            checkedAt: "2026-03-13T12:00:00.000Z",
            repoAccessOk: null,
            repoAccessError: null,
            connected: true,
          }),
        },
        app: {
          openExternal: vi.fn(),
        },
        lanes: {
          list: vi.fn().mockResolvedValue([]),
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
    onRefreshAll: ReturnType<typeof vi.fn>;
    lanes: LaneSummary[];
  }> = {}) {
    const onSelectPr = overrides.onSelectPr ?? vi.fn();
    const onOpenQueueView = overrides.onOpenQueueView ?? vi.fn();
    const onRefreshAll = overrides.onRefreshAll ?? vi.fn().mockResolvedValue(undefined);
    render(
      <MemoryRouter>
        <GitHubTab
          lanes={overrides.lanes ?? []}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={overrides.selectedPrId ?? null}
          onSelectPr={onSelectPr}
          onRefreshAll={onRefreshAll}
          onOpenQueueView={onOpenQueueView}
        />
      </MemoryRouter>,
    );
    return { onSelectPr, onOpenQueueView, onRefreshAll };
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

  it("restores each filter tab's selected PR when switching back", async () => {
    const user = userEvent.setup();
    renderTab();

    await user.click(await screen.findByRole("button", { name: /#101 Open PR/i }));
    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
    });

    await user.click(screen.getByRole("button", { name: /^merged/i }));
    expect(screen.queryByTestId("pr-detail-pane")).toBeNull();

    await user.click(screen.getByRole("button", { name: /#102 Merged PR/i }));
    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-merged");
    });

    await user.click(screen.getByRole("button", { name: /^open/i }));
    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
    });

    await user.click(screen.getByRole("button", { name: /^merged/i }));
    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-merged");
    });
  });

  it("shows projection-backed filter counts before closed history is opened", async () => {
    const snapshotWithProjectionCounts: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr()],
      history: {
        includeExternalClosed: false,
        pageLimit: 0,
        repoPullRequestsLoaded: 1,
        repoPullRequestsMayHaveMore: false,
        repoPullRequestCounts: {
          open: 7,
          merged: 3,
          closed: 2,
        },
      },
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithProjectionCounts);

    renderTab();

    await screen.findByText("Open PR");
    expect(within(screen.getByRole("button", { name: /^open/i })).getByText("7")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^merged/i })).getByText("3")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^closed/i })).getByText("2")).toBeTruthy();
  });

  it("shows a loading indicator while the GitHub snapshot is in flight", async () => {
    const deferred = createDeferred<GitHubPrSnapshot>();
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockReturnValueOnce(deferred.promise);

    renderTab();

    expect(screen.getByLabelText("Loading pull requests")).toBeTruthy();
    act(() => {
      deferred.resolve(snapshot);
    });
    await screen.findByText("Open PR");
    await waitFor(() => {
      expect(screen.queryByLabelText("Loading pull requests")).toBeNull();
    });
  });

  it("shows a spinner inside the active history tab while that tab loads", async () => {
    const user = userEvent.setup();
    const openOnlySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [makeGitHubPr()],
      externalPullRequests: [],
      history: {
        includeExternalClosed: false,
        pageLimit: 0,
        repoPullRequestsLoaded: 1,
        repoPullRequestsMayHaveMore: false,
      },
    };
    const historySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      history: {
        includeExternalClosed: true,
        pageLimit: 2,
        repoPullRequestsLoaded: snapshot.repoPullRequests.length,
        repoPullRequestsMayHaveMore: false,
      },
    };
    const historyRequest = createDeferred<GitHubPrSnapshot>();
    const getGitHubSnapshot = window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>;
    getGitHubSnapshot.mockResolvedValueOnce(openOnlySnapshot).mockReturnValueOnce(historyRequest.promise);

    renderTab();

    await screen.findByText("Open PR");
    await user.click(screen.getByRole("button", { name: /^merged/i }));
    expect(screen.getByLabelText("Loading merged pull requests")).toBeTruthy();

    act(() => {
      historyRequest.resolve(historySnapshot);
    });
    await waitFor(() => {
      expect(screen.queryByLabelText("Loading merged pull requests")).toBeNull();
    });
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

  it("shows friendly copy when GitHub is not connected", async () => {
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Error invoking remote method 'prs:getGitHubSnapshot': Error: GitHub token missing. Set it in Settings to sync pull requests."),
    );

    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Connect GitHub in Settings with gh auth or a PAT to sync pull requests.")).toBeTruthy();
    });
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    expect(screen.queryByText(/Error invoking remote method/)).toBeNull();
    expect(screen.getByRole("button", { name: /connect github/i })).toBeTruthy();
  });

  it("passes queue context into the normal PR detail pane", async () => {
    renderTab({ selectedPrId: "pr-queue" });

    await waitFor(() => {
      expect(screen.getByTestId("queue-context").textContent).toContain("queue-group-1");
    });
  });

  it("requires confirmation before unmapping a GitHub PR from its lane", async () => {
    const user = userEvent.setup();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    try {
      renderTab();

      await waitFor(() => {
        expect(screen.getByText("Open PR")).toBeTruthy();
      });
      await user.click(screen.getByRole("button", { name: /#101 Open PR/i }));
      await waitFor(() => {
        expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
      });
      await user.click(screen.getByRole("button", { name: /unmap from lane/i }));

      expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining("Unmap PR #101"));
      expect(window.ade.prs.delete).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it("renders a cached ADE detail shell while a linked PR hydrates", async () => {
    mockUsePrs.mockReturnValue({
      prs: [],
      mergeContextByPrId: {},
      detailStatus: null,
      detailChecks: [],
      detailReviews: [],
      detailComments: [],
      detailBusy: false,
      loading: true,
      setViewerLogin: vi.fn(),
    });

    const onRefreshAll = vi.fn().mockResolvedValue(undefined);
    renderTab({ selectedPrId: "pr-open", onRefreshAll });

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
    });
    await waitFor(() => {
      expect(onRefreshAll).toHaveBeenCalledWith({ prId: "pr-open" });
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
    await waitFor(() => {
      expect(screen.getByText("Open PR")).toBeTruthy();
    });
    vi.useFakeTimers();
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();

    fireEvent.click(screen.getByRole("button", { name: /^sync now$/i }));

    await vi.advanceTimersByTimeAsync(0);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledTimes(2);
  });

  it("silently reloads the GitHub snapshot when PR events arrive", async () => {
    let prEventCallback: ((event: { type: "prs-updated"; polledAt: string; prs: [] }) => void) | null = null;
    (window.ade.prs.onEvent as ReturnType<typeof vi.fn>).mockImplementation((cb) => {
      prEventCallback = cb;
      return vi.fn();
    });
    renderTab();

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();

    act(() => {
      prEventCallback?.({ type: "prs-updated", polledAt: "2026-03-13T12:00:30.000Z", prs: [] });
    });

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
  });

  it("loads older closed history in bounded page increments", async () => {
    const user = userEvent.setup();
    const historySnapshot: GitHubPrSnapshot = {
      ...snapshot,
      history: {
        includeExternalClosed: true,
        pageLimit: 2,
        repoPullRequestsLoaded: 200,
        repoPullRequestsMayHaveMore: true,
      },
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(historySnapshot);
    renderTab();

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
    await user.click(screen.getByRole("button", { name: /^merged/i }));
    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: false,
        includeExternalClosed: true,
        historyPageLimit: 2,
      });
    });
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();

    await user.click(screen.getByRole("button", { name: /load older pull requests/i }));

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: true,
        includeExternalClosed: true,
        historyPageLimit: 4,
      });
    });
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
        historyPageLimit: 2,
      });
    });

    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockClear();
    await user.click(screen.getByRole("button", { name: /^open/i }));
    await user.click(screen.getByRole("button", { name: /^sync now$/i }));

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({
        force: true,
        includeExternalClosed: true,
        historyPageLimit: 2,
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
    let rejectOpenOnly!: (error: Error) => void;
    let resolveFullHistory!: (snapshot: GitHubPrSnapshot) => void;
    const openOnlyRequest = new Promise<GitHubPrSnapshot>((_resolve, reject) => {
      rejectOpenOnly = reject;
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

    await user.click(screen.getByRole("button", { name: /^sync now$/i }));
    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    });
    await user.click(screen.getByRole("button", { name: /^merged/i }));
    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({
        force: false,
        includeExternalClosed: true,
        historyPageLimit: 2,
      });
    });

    resolveFullHistory(fullHistorySnapshot);
    await screen.findByText("Merged PR");

    rejectOpenOnly(new Error("stale open-only failed"));
    await waitFor(() => {
      expect(screen.getByText("Merged PR")).toBeTruthy();
      expect(screen.queryByText("stale open-only failed")).toBeNull();
    });

    getGitHubSnapshot.mockClear();
    getGitHubSnapshot.mockResolvedValue(fullHistorySnapshot);
    await user.click(screen.getByRole("button", { name: /^open/i }));
    await user.click(screen.getByRole("button", { name: /^sync now$/i }));

    await waitFor(() => {
      expect(getGitHubSnapshot).toHaveBeenCalledWith({
        force: true,
        includeExternalClosed: true,
        historyPageLimit: 2,
      });
    });
  });

  it("places a linked PR in merged when local state is terminal and the GitHub snapshot is stale open", async () => {
    const user = userEvent.setup();
    const staleOpenSnapshot: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-stale-open-merged",
          githubPrNumber: 102,
          githubUrl: "https://github.com/ade-dev/ade/pull/102",
          title: "Stale open snapshot",
          state: "open",
          linkedPrId: "pr-merged",
          linkedLaneId: "lane-merged",
          linkedLaneName: "lane-merged",
        }),
      ],
      externalPullRequests: [],
      history: {
        includeExternalClosed: false,
        pageLimit: 0,
        repoPullRequestsLoaded: 1,
        repoPullRequestsMayHaveMore: false,
        // Server-side totals still bucket the stale row under "open"; the
        // badge counts must follow the reconciled state instead.
        repoPullRequestCounts: {
          open: 5,
          merged: 3,
          closed: 2,
        },
      },
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(staleOpenSnapshot);

    renderTab();

    await waitFor(() => {
      expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: false });
    });
    expect(screen.queryByText("Stale open snapshot")).toBeNull();

    // The reconciled row moves from open to merged in the badge totals too.
    expect(within(screen.getByRole("button", { name: /^open/i })).getByText("4")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^merged/i })).getByText("4")).toBeTruthy();
    expect(within(screen.getByRole("button", { name: /^closed/i })).getByText("2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /^merged/i }));

    await waitFor(() => {
      expect(screen.getByText("Stale open snapshot")).toBeTruthy();
    });
  });

  it("shows linked and unmapped PRs together under the status tabs", async () => {
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
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Open PR")).not.toBeNull();
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });
  });

  it("marks unlinked PRs as unmapped", async () => {
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
    renderTab();

    await waitFor(() => {
      expect(screen.getByText("Unlinked PR")).not.toBeNull();
    });
    expect(screen.getAllByText("unmapped").length).toBeGreaterThan(0);
  });

  it("renders the full PR detail pane (with create/map affordance) for a selected unmapped PR", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          headBranch: "feature/no-lane",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    // No lane owns the PR head branch → the "Create lane from PR branch" action
    // is offered (and there is no matching lane to map to).
    renderTab({ lanes: [] });

    await user.click(await screen.findByText("Unlinked PR"));

    // The full detail pane renders (not the legacy read-only gate), keyed by a
    // stable synthetic id derived from the GitHub coordinates.
    const pane = await screen.findByTestId("pr-detail-pane");
    expect(pane.getAttribute("data-unmapped")).toBe("true");
    expect(pane.textContent).toContain("gh:ade-dev/ade#200");

    // The create/map affordance is present (no read-only gate).
    const affordance = within(pane).getByTestId("pr-unmapped-affordance");
    expect(within(affordance).getByRole("button", { name: /create lane from pr branch/i })).toBeTruthy();
  });

  it("maps an unmapped PR to a lane via the in-pane affordance", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          headBranch: "feature/lane-match",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab({
      lanes: [makeLaneSummary({ id: "lane-match", name: "Matching lane", branchRef: "refs/heads/feature/lane-match" })],
    });

    await user.click(await screen.findByText("Unlinked PR"));
    const pane = await screen.findByTestId("pr-detail-pane");
    const affordance = within(pane).getByTestId("pr-unmapped-affordance");

    await user.selectOptions(within(affordance).getByLabelText("Select lane to map"), "lane-match");
    await user.click(within(affordance).getByRole("button", { name: /^map$/i }));

    await waitFor(() => {
      expect(window.ade.prs.linkToLane).toHaveBeenCalledWith({
        laneId: "lane-match",
        prUrlOrNumber: "https://github.com/ade-dev/ade/pull/200",
      });
    });
  });

  it("opens a preflight dialog for an unmapped PR branch", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));

    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 200,
    });
    const dialog = await screen.findByRole("dialog", { name: /create lane from pr branch/i });
    expect(within(dialog).getByText(/#200 Unlinked PR/)).toBeTruthy();
    expect(within(dialog).getAllByText("origin/feature/open").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("Unlinked PR").length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText("main").length).toBeGreaterThan(0);
  });

  it("ignores stale create-lane preflight results from a previous PR", async () => {
    const user = userEvent.setup();
    const firstPreflight = createDeferred<CreateLaneFromPrBranchPreflightResult>();
    const secondPreflight = createDeferred<CreateLaneFromPrBranchPreflightResult>();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked-first",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "First PR",
          headBranch: "feature/first",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:10:00.000Z",
        }),
        makeGitHubPr({
          id: "repo-unlinked-second",
          githubPrNumber: 201,
          githubUrl: "https://github.com/ade-dev/ade/pull/201",
          title: "Second PR",
          headBranch: "feature/second",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>)
      .mockImplementation((args: { githubPrNumber: number }) =>
        args.githubPrNumber === 200 ? firstPreflight.promise : secondPreflight.promise);
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 200,
    });
    await user.click(screen.getByRole("button", { name: /cancel/i }));
    await user.click(await screen.findByText("Second PR"));
    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    expect(window.ade.prs.preflightCreateLaneFromPrBranch).toHaveBeenCalledWith({
      repoOwner: "ade-dev",
      repoName: "ade",
      githubPrNumber: 201,
    });

    await act(async () => {
      firstPreflight.resolve(makePreflightResult({
        githubPrNumber: 200,
        title: "First PR",
        headBranch: "feature/first",
        remoteBranch: "origin/feature/first",
      }));
      await firstPreflight.promise;
    });
    expect(screen.queryByText(/#200 First PR/)).toBeNull();
    expect(screen.getByText(/checking branch ownership/i)).toBeTruthy();

    await act(async () => {
      secondPreflight.resolve(makePreflightResult({
        githubPrNumber: 201,
        title: "Second PR",
        headBranch: "feature/second",
        remoteBranch: "origin/feature/second",
      }));
      await secondPreflight.promise;
    });

    expect(await screen.findByText(/#201 Second PR/)).toBeTruthy();
    expect(screen.queryByText(/#200 First PR/)).toBeNull();
    const secondDialog = await screen.findByRole("dialog", { name: /create lane from pr branch/i });
    expect(within(secondDialog).getAllByText("origin/feature/second").length).toBeGreaterThan(0);
  });

  it("shows blocking preflight conflicts before creating a lane", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      preflight: {
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
        githubUrl: "https://github.com/ade-dev/ade/pull/200",
        title: "Unlinked PR",
        headBranch: "feature/open",
        headRepoOwner: "ade-dev",
        headRepoName: "ade",
        remoteBranch: "origin/feature/open",
        importBranchRef: "origin/feature/open",
        targetLaneName: "Unlinked PR",
        baseBranch: "main",
        canCreate: false,
        status: "blocked",
        blockingConflict: {
          code: "branch_owned",
          message: "Branch 'feature/open' is already owned by lane 'Existing lane'.",
          laneId: "lane-existing",
          laneName: "Existing lane",
        },
        blockingConflicts: [],
      },
      lane: null,
      pr: null,
    });
    renderTab();

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));

    expect(await screen.findByText(/already owned by lane 'Existing lane'/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^create lane$/i })).toHaveProperty("disabled", true);
    expect(window.ade.prs.createLaneFromPrBranch).not.toHaveBeenCalled();
  });

  it("does not let an archived branch match hide the create-lane action", async () => {
    const user = userEvent.setup();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue(snapshotWithUnlinked);
    (window.ade.prs.preflightCreateLaneFromPrBranch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      preflight: {
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
        githubUrl: "https://github.com/ade-dev/ade/pull/200",
        title: "Unlinked PR",
        headBranch: "feature/open",
        headRepoOwner: "ade-dev",
        headRepoName: "ade",
        remoteBranch: "origin/feature/open",
        importBranchRef: "origin/feature/open",
        targetLaneName: "Unlinked PR",
        baseBranch: "main",
        canCreate: false,
        status: "blocked",
        blockingConflict: {
          code: "branch_owned",
          message: "Branch 'feature/open' is already owned by archived lane 'Archived lane'.",
          laneId: "lane-archived",
          laneName: "Archived lane",
        },
        blockingConflicts: [],
      },
      lane: null,
      pr: null,
    });

    renderTab({
      lanes: [
        makeLaneSummary({
          id: "lane-archived",
          name: "Archived lane",
          branchRef: "refs/heads/feature/open",
          archivedAt: "2026-03-12T12:00:00.000Z",
        }),
      ],
    });

    expect(await screen.findByRole("button", { name: /create lane from pr branch/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Archived lane" })).toBeNull();

    await user.click(screen.getByRole("button", { name: /create lane from pr branch/i }));

    expect(await screen.findByText(/already owned by archived lane 'Archived lane'/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /^create lane$/i })).toHaveProperty("disabled", true);
  });

  it("creates a lane from an unmapped PR branch, refreshes lanes, and selects the mapped PR", async () => {
    const user = userEvent.setup();
    const onSelectPr = vi.fn();
    const onRefreshAll = vi.fn().mockResolvedValue(undefined);
    const forcedSnapshot = createDeferred<GitHubPrSnapshot>();
    const snapshotWithUnlinked: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "repo-unlinked",
          githubPrNumber: 200,
          githubUrl: "https://github.com/ade-dev/ade/pull/200",
          title: "Unlinked PR",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:05:00.000Z",
        }),
      ],
      externalPullRequests: [],
    };
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(snapshotWithUnlinked)
      .mockReturnValueOnce(forcedSnapshot.promise);
    renderTab({ onSelectPr, onRefreshAll });

    await user.click(await screen.findByRole("button", { name: /create lane from pr branch/i }));
    await user.click(await screen.findByRole("button", { name: /^create lane$/i }));

    await waitFor(() => {
      expect(window.ade.prs.createLaneFromPrBranch).toHaveBeenCalledWith({
        repoOwner: "ade-dev",
        repoName: "ade",
        githubPrNumber: 200,
      });
    });
    await waitFor(() => {
      expect(onSelectPr).toHaveBeenCalledWith("pr-created");
    });
    expect(onRefreshAll).toHaveBeenCalledWith({ prId: "pr-created" });
    expect(window.ade.lanes.list).toHaveBeenCalledWith({
      includeArchived: false,
      includeStatus: false,
    });
    expect(window.ade.prs.getGitHubSnapshot).toHaveBeenCalledWith({ force: true });
    await act(async () => {
      forcedSnapshot.resolve(snapshotWithUnlinked);
      await forcedSnapshot.promise;
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

  it("sorts PRs by updatedAt descending", async () => {
    const snapshotOrdered: GitHubPrSnapshot = {
      ...snapshot,
      repoPullRequests: [
        makeGitHubPr({
          id: "pr-old",
          githubPrNumber: 50,
          title: "Old PR",
          createdAt: "2026-03-13T12:00:00.000Z",
          updatedAt: "2026-03-13T12:10:00.000Z",
        }),
        makeGitHubPr({
          id: "pr-new",
          githubPrNumber: 150,
          title: "New PR",
          createdAt: "2026-03-13T08:00:00.000Z",
          updatedAt: "2026-03-13T12:30:00.000Z",
        }),
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
