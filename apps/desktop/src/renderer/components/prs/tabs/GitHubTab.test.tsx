// @vitest-environment jsdom

import React from "react";
import { MemoryRouter } from "react-router-dom";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrSnapshot, LaneSummary, MergeMethod } from "../../../../shared/types";
import type { PrRouteSelectionTarget } from "../prsRouteState";

vi.mock("react-resizable-panels", async () => {
  const harness = await import("./GitHubTab.testHarness");
  return {
    Group: harness.MockPanelGroup,
    Panel: harness.MockPanel,
    Separator: harness.MockSeparator,
  };
});

vi.mock("../state/PrsContext", async () => {
  const { mockUsePrs } = await import("./GitHubTab.testHarness");
  return { usePrs: () => mockUsePrs() };
});

vi.mock("../detail/PrDetailPane", async () => {
  const { MockPrDetailPane } = await import("./GitHubTab.testHarness");
  return { PrDetailPane: MockPrDetailPane };
});

import { GitHubTab } from "./GitHubTab";
import { GITHUB_TAB_SNAPSHOT_FRESH_MS } from "./githubTabModel";
import {
  cleanupGitHubTabTest,
  mockUsePrs,
  renderGitHubTab,
  setupGitHubTabTest,
} from "./GitHubTab.testHarness";
import {
  createDeferred,
  makeGitHubPr,
  makePrsContext,
  snapshot,
} from "./GitHubTab.testFixtures";

describe("GitHubTab snapshot lifecycle", () => {
  beforeEach(() => {
    setupGitHubTabTest();
  });

  afterEach(() => {
    cleanupGitHubTabTest();
  });

  function renderTab(overrides: Partial<{
    selectedPrId: string | null;
    selectedPrTarget: PrRouteSelectionTarget | null;
    onSelectPr: ReturnType<typeof vi.fn>;
    onRefreshAll: ReturnType<typeof vi.fn>;
    lanes: LaneSummary[];
  }> = {}) {
    return renderGitHubTab(GitHubTab, overrides);
  }

  function renderTabEl(selectedPrId: string) {
    return (
      <MemoryRouter>
        <GitHubTab
          lanes={[]}
          mergeMethod={"squash" satisfies MergeMethod}
          selectedPrId={selectedPrId}
          onSelectPr={vi.fn()}
          onRefreshAll={vi.fn().mockResolvedValue(undefined)}
        />
      </MemoryRouter>
    );
  }

  it("shows and manages the selected GitHub stack from the cached snapshot", async () => {
    const user = userEvent.setup();
    const stack = {
      id: "stack-18",
      number: 18,
      nodeId: "STACK_18",
      repoOwner: "ade-dev",
      repoName: "ade",
      baseBranch: "main",
      open: true,
      createdAt: "2026-07-30T12:00:00.000Z",
      syncedAt: "2026-07-30T12:10:00.000Z",
      lastError: null,
      entries: [
        {
          githubPrNumber: 101,
          position: 1,
          state: "open" as const,
          isDraft: false,
          mergedAt: null,
          headBranch: "feature/open",
          headSha: "sha-101",
        },
        {
          githubPrNumber: 104,
          position: 2,
          state: "open" as const,
          isDraft: false,
          mergedAt: null,
          headBranch: "feature/top",
          headSha: "sha-104",
        },
      ],
    };
    const stackedSnapshot: GitHubPrSnapshot = {
      ...snapshot,
      stacks: [stack],
      repoPullRequests: [
        makeGitHubPr({
          stack: { id: "stack-18", number: 18, size: 2, position: 1, baseBranch: "main" },
        }),
        makeGitHubPr({
          id: "repo-top",
          githubPrNumber: 104,
          githubUrl: "https://github.com/ade-dev/ade/pull/104",
          title: "Top stack layer",
          headBranch: "feature/top",
          linkedPrId: null,
          linkedLaneId: null,
          linkedLaneName: null,
          adeKind: null,
          stack: { id: "stack-18", number: 18, size: 2, position: 2, baseBranch: "main" },
        }),
      ],
      externalPullRequests: [],
    };
    vi.mocked(window.ade.prs.getGitHubSnapshot).mockResolvedValue(stackedSnapshot);
    renderTab({ selectedPrId: "pr-open" });

    expect(await screen.findByText("GitHub Stack #18")).toBeTruthy();
    expect(screen.getByLabelText("GitHub Stack 1 of 2")).toBeTruthy();
    expect(screen.getAllByText("Top stack layer")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Review on GitHub" }));
    expect(window.ade.app.openExternal).toHaveBeenCalledWith(
      "https://github.com/ade-dev/ade/pull/101",
    );

    await user.click(screen.getByRole("button", { name: /Manage stack/i }));
    await user.type(screen.getByLabelText("Pull request numbers to add"), "105, 106");
    await user.click(screen.getByRole("button", { name: "Add PRs" }));
    await waitFor(() => {
      expect(window.ade.prs.addGitHubStackPullRequests).toHaveBeenCalledWith({
        repo: { owner: "ade-dev", name: "ade" },
        stackNumber: 18,
        pullRequests: [105, 106],
      });
    });
  });

  it("does not auto-jump to a different PR when switching filters", async () => {
    const user = userEvent.setup();
    const { onSelectPr } = renderTab({ selectedPrId: "pr-merged" });

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-merged");
    });

    await user.click(screen.getByRole("button", { name: /^open/i }));

    await waitFor(() => expect(onSelectPr).toHaveBeenLastCalledWith(null, null));
    expect(screen.queryByTestId("pr-detail-pane")).toBeNull();
  });

  it("follows a selected PR into the merged bucket when its linked state transitions", async () => {
    (window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...snapshot,
      repoPullRequests: [makeGitHubPr()],
      externalPullRequests: [],
    });
    mockUsePrs.mockReturnValue(makePrsContext([
      { id: "pr-open", state: "open", repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 101 },
    ]));

    const view = render(renderTabEl("pr-open"));

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
    });
    // Starts on the open tab.
    expect((screen.getByRole("button", { name: /^open/i }) as HTMLButtonElement).style.fontWeight).toBe("600");

    // The linked ADE PR transitions open -> merged.
    mockUsePrs.mockReturnValue(makePrsContext([
      { id: "pr-open", state: "merged", repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 101 },
    ]));
    view.rerender(renderTabEl("pr-open"));

    // The filter follows to merged and the selection is preserved (not stranded).
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /^merged/i }) as HTMLButtonElement).style.fontWeight).toBe("600");
    });
    expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
  });

  it("keeps a merged PR visible via an overlay row after it drops from the open-only snapshot", async () => {
    const getSnap = window.ade.prs.getGitHubSnapshot as ReturnType<typeof vi.fn>;
    const openOnly: GitHubPrSnapshot = { ...snapshot, repoPullRequests: [makeGitHubPr()], externalPullRequests: [] };
    getSnap.mockResolvedValue(openOnly);

    let prsEventCb: ((event: { type: string }) => void) | undefined;
    (window.ade.prs.onEvent as ReturnType<typeof vi.fn>).mockImplementation((cb: (event: { type: string }) => void) => {
      prsEventCb = cb;
      return () => {};
    });

    mockUsePrs.mockReturnValue(makePrsContext([
      { id: "pr-open", state: "open", repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 101 },
    ]));

    render(renderTabEl("pr-open"));

    await waitFor(() => {
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
    });
    expect(screen.getByRole("button", { name: /#101 Open PR/i })).toBeTruthy();

    // The PR merges AND drops out of the open-only snapshot.
    mockUsePrs.mockReturnValue(makePrsContext([
      { id: "pr-open", state: "merged", repoOwner: "ade-dev", repoName: "ade", githubPrNumber: 101 },
    ]));
    getSnap.mockResolvedValue({ ...openOnly, repoPullRequests: [] });
    // PR events only reload a snapshot that is no longer fresh, so age the one
    // this tab just loaded past the freshness window.
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + GITHUB_TAB_SNAPSHOT_FRESH_MS + 1_000);
    await act(async () => {
      prsEventCb?.({ type: "prs-updated" });
      await Promise.resolve();
    });

    // The overlay keeps the row visible under merged with the selection intact.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /#101 Open PR/i })).toBeTruthy();
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("pr-open");
      expect((screen.getByRole("button", { name: /^merged/i }) as HTMLButtonElement).style.fontWeight).toBe("600");
    });
    // Merged count reflects the overlay row (1), not doubled.
    expect(screen.getByRole("button", { name: /^merged/i }).textContent).toContain("1");
    nowSpy.mockRestore();
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
      expect(screen.getByTestId("pr-detail-pane").textContent).toContain("gh:ade-dev/ade#101");
    });
    await waitFor(() => {
      expect(onRefreshAll).toHaveBeenCalledWith({ prId: "pr-open" });
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
    vi.useFakeTimers();

    // `prs-updated` fires for any PR-domain write, including ones that change
    // nothing this tab renders. A snapshot loaded moments ago is not reloaded.
    act(() => {
      prEventCallback?.({ type: "prs-updated", polledAt: "2026-03-13T12:00:30.000Z", prs: [] });
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(window.ade.prs.getGitHubSnapshot).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(31_000);
    act(() => {
      prEventCallback?.({ type: "prs-updated", polledAt: "2026-03-13T12:01:01.000Z", prs: [] });
    });

    await vi.waitFor(() => {
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
});
