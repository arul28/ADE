// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AutoRebaseLaneStatus,
  PrAiSummary,
  PrConflictAnalysis,
  PrDeployment,
  PrEventPayload,
  PrSnapshotHydration,
  PrSummary,
  PrWithConflicts,
  RebaseNeed,
  LaneLifecycleEvent,
} from "../../../../shared/types";
import { PrsProvider, usePrs } from "./PrsContext";

const originalAde = globalThis.window.ade;

function Harness() {
  const { refresh, rebaseNeeds, autoRebaseStatuses, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="needs-count">{rebaseNeeds.length}</div>
      <div data-testid="auto-count">{autoRebaseStatuses.length}</div>
    </div>
  );
}

function TargetedRefreshHarness() {
  const { refresh, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => void refresh({ prId: "pr-1" })}>
        refresh pr-1
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
    </div>
  );
}

function DualRefreshHarness() {
  const { refresh, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => void refresh()}>
        refresh all
      </button>
      <button type="button" onClick={() => void refresh({ prId: "pr-1" })}>
        refresh pr-1
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
    </div>
  );
}

function RouteHarness() {
  const { activeTab, selectedPrId, selectedRebaseItemId } = usePrs();
  return (
    <div>
      <div data-testid="active-tab">{activeTab}</div>
      <div data-testid="selected-pr-id">{selectedPrId ?? ""}</div>
      <div data-testid="selected-rebase-item-id">{selectedRebaseItemId ?? ""}</div>
    </div>
  );
}

function TabSwitchHarness() {
  const { activeTab, setActiveTab, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => setActiveTab("integration")}>
        integration
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="active-tab">{activeTab}</div>
    </div>
  );
}

function ConflictRefreshHarness() {
  const { activeTab, prs, setActiveTab, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => setActiveTab("integration")}>
        integration
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="active-tab">{activeTab}</div>
      <div data-testid="conflict-risk">
        {prs.map((pr) => `${pr.id}:${pr.conflictAnalysis?.riskLevel ?? "none"}`).join(",")}
      </div>
    </div>
  );
}

function DetailHarness() {
  const {
    detailBusy,
    detailChecks,
    detailReviews,
    detailComments,
    detailDeployments,
    detailAiSummary,
    detailLiveDataPrId,
    detailStatus,
    loading,
    selectedPrId,
    setSelectedPrId,
  } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => setSelectedPrId("pr-1")}>
        select pr-1
      </button>
      <button type="button" onClick={() => setSelectedPrId("pr-2")}>
        select pr-2
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="detail-busy">{detailBusy ? "busy" : "idle"}</div>
      <div data-testid="selected-pr-id">{selectedPrId ?? ""}</div>
      <div data-testid="live-detail-pr-id">{detailLiveDataPrId ?? ""}</div>
      <div data-testid="status">{detailStatus?.state ?? ""}</div>
      <div data-testid="checks-count">{detailChecks.length}</div>
      <div data-testid="reviews-count">{detailReviews.length}</div>
      <div data-testid="comments-count">{detailComments.length}</div>
      <div data-testid="deployments-count">{detailDeployments.length}</div>
      <div data-testid="ai-summary">{detailAiSummary?.summary ?? ""}</div>
    </div>
  );
}

function ActiveToggleDetailHarness() {
  const [active, setActive] = React.useState(true);
  return (
    <div>
      <button type="button" onClick={() => setActive(false)}>deactivate</button>
      <button type="button" onClick={() => setActive(true)}>activate</button>
      <PrsProvider active={active}>
        <DetailHarness />
      </PrsProvider>
    </div>
  );
}

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

function enqueueDeferred<T>(store: Record<string, Deferred<T>[]>, prId: string): Deferred<T> {
  const request = createDeferred<T>();
  store[prId] = [...(store[prId] ?? []), request];
  return request;
}

function MergeContextHarness() {
  const { loading, mergeContextByPrId } = usePrs();
  return (
    <div>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="contexts">{Object.keys(mergeContextByPrId).sort().join(",")}</div>
    </div>
  );
}

describe("PrsContext refresh", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
    window.location.hash = "";
    const refreshedNeed: RebaseNeed = {
      laneId: "lane-1",
      laneName: "Lane 1",
      kind: "lane_base",
      baseBranch: "main",
      behindBy: 1,
      conflictPredicted: false,
      conflictingFiles: [],
      prId: null,
      groupContext: null,
      dismissedAt: null,
      deferredUntil: null,
    };
    const refreshedAutoStatus: AutoRebaseLaneStatus = {
      laneId: "lane-1",
      parentLaneId: "lane-parent",
      parentHeadSha: "abc123",
      state: "autoRebased",
      updatedAt: "2026-03-24T12:00:00.000Z",
      conflictCount: 0,
      message: null,
    };

    globalThis.window.ade = {
      prs: {
        refresh: vi.fn().mockResolvedValue(undefined),
        listWithConflicts: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
        listAutoRebaseStatuses: vi.fn().mockResolvedValue([refreshedAutoStatus]),
        onAutoRebaseEvent: vi.fn(() => () => {}),
        onLifecycleEvent: vi.fn(() => () => {}),
      },
      rebase: {
        scanNeeds: vi.fn().mockResolvedValue([refreshedNeed]),
        onEvent: vi.fn(() => () => {}),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    globalThis.window.ade = originalAde;
    window.location.hash = "";
    window.history.replaceState(null, "", "/");
  });

  it("skips rebase scans for the plain GitHub PR list", async () => {
    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    expect(window.ade.rebase.scanNeeds).not.toHaveBeenCalled();
    expect(window.ade.lanes.listAutoRebaseStatuses).not.toHaveBeenCalled();
    expect(window.ade.lanes.list).toHaveBeenCalledWith({ includeStatus: false });
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();
  });

  it("replays a hidden lane lifecycle refresh when the PRs tab becomes visible", async () => {
    let lifecycleListener: ((event: LaneLifecycleEvent) => void) | null = null;
    vi.mocked(window.ade.lanes.onLifecycleEvent).mockImplementation((listener) => {
      lifecycleListener = listener;
      return vi.fn();
    });
    let visibilityState: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });

    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    const baselineRefreshCount = vi.mocked(window.ade.prs.listWithConflicts).mock.calls.length;
    expect(baselineRefreshCount).toBeGreaterThan(0);

    vi.useFakeTimers();
    visibilityState = "hidden";
    act(() => {
      lifecycleListener?.({
        type: "lane-created",
        laneId: "lane-new",
        laneName: "New lane",
      });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180);
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(baselineRefreshCount);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(180);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(baselineRefreshCount + 1);
  });

  it("bounds automatic retries after persistent refresh failures", async () => {
    vi.useFakeTimers();
    vi.mocked(window.ade.prs.listWithConflicts).mockRejectedValue(new Error("boom"));

    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(4);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(window.ade.prs.listWithConflicts).toHaveBeenCalledTimes(4);
  });

  it("loads rebase diagnostics for a selected PR on the normal tab", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    Object.assign(window.ade.prs, {
      getStatus: vi.fn(async (_prId: string) => null),
      getChecks: vi.fn(async (_prId: string) => []),
      getReviews: vi.fn(async (_prId: string) => []),
      getComments: vi.fn(async (_prId: string) => []),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    expect(window.ade.rebase.scanNeeds).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "select pr-1" }));

    await waitFor(() => {
      expect(window.ade.rebase.scanNeeds).toHaveBeenCalled();
      expect(window.ade.lanes.listAutoRebaseStatuses).toHaveBeenCalled();
    });
  });

  it("refreshes rebase needs and auto-rebase statuses for workflow routes without waiting for events", async () => {
    window.location.hash = "#/prs?tab=workflows&workflow=rebase&laneId=lane-1";
    let resolveRefresh!: () => void;
    vi.mocked(window.ade.prs.refresh).mockReturnValueOnce(new Promise((resolve) => {
      resolveRefresh = () => resolve([]);
    }));

    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await waitFor(() => {
      expect(screen.getByTestId("needs-count").textContent).toBe("1");
      expect(screen.getByTestId("auto-count").textContent).toBe("1");
    });
    expect(window.ade.lanes.list).toHaveBeenCalledWith({ includeStatus: false });
    expect(window.ade.prs.refresh).toHaveBeenCalledTimes(1);
    const initialRebaseScanCount = vi.mocked(window.ade.rebase.scanNeeds).mock.calls.length;
    const initialAutoStatusCount = vi.mocked(window.ade.lanes.listAutoRebaseStatuses).mock.calls.length;
    expect(initialRebaseScanCount).toBeGreaterThanOrEqual(1);
    expect(initialAutoStatusCount).toBeGreaterThanOrEqual(1);
    resolveRefresh();
    await waitFor(() => {
      expect(vi.mocked(window.ade.rebase.scanNeeds).mock.calls.length).toBeGreaterThan(initialRebaseScanCount);
      expect(vi.mocked(window.ade.lanes.listAutoRebaseStatuses).mock.calls.length).toBeGreaterThan(initialAutoStatusCount);
    });
  });

  it("runs a GitHub PR refresh for explicit refresh actions", async () => {
    const user = userEvent.setup();

    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    vi.mocked(window.ade.prs.refresh).mockClear();

    await user.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledTimes(1);
    });
  });

  it("passes targeted PR refresh requests through to the PR service", async () => {
    const user = userEvent.setup();

    render(
      <PrsProvider>
        <TargetedRefreshHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    vi.mocked(window.ade.prs.refresh).mockClear();

    await user.click(screen.getByRole("button", { name: "refresh pr-1" }));

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prId: "pr-1" });
    });
  });

  it("preserves targeted refresh args queued behind an in-flight refresh", async () => {
    const user = userEvent.setup();
    let resolveFirstRefresh!: () => void;

    render(
      <PrsProvider>
        <DualRefreshHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    vi.mocked(window.ade.prs.refresh).mockClear();
    vi.mocked(window.ade.prs.refresh).mockImplementationOnce(() => new Promise<PrSummary[]>((resolve) => {
      resolveFirstRefresh = () => resolve([]);
    }));

    await user.click(screen.getByRole("button", { name: "refresh all" }));
    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: "refresh pr-1" }));
    expect(window.ade.prs.refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstRefresh();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prId: "pr-1" });
    });
  });

  it("does not run a GitHub PR refresh just because the local PR tab changes", async () => {
    const user = userEvent.setup();

    render(
      <PrsProvider>
        <TabSwitchHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    vi.mocked(window.ade.prs.refresh).mockClear();

    await user.click(screen.getByRole("button", { name: "integration" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("integration");
    });
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();
  });

  it("clears stale selected PR detail arrays when a cached snapshot has empty arrays", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]);
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async ({ prId }: { prId: string }) => [
        prId === "pr-1"
          ? {
              prId,
              detail: null,
              status: { state: "success" },
              checks: [
                {
                  name: "ci",
                  status: "completed",
                  conclusion: "success",
                  detailsUrl: null,
                  startedAt: null,
                  completedAt: null,
                },
              ],
              reviews: [
                {
                  reviewer: "octocat",
                  reviewerAvatarUrl: null,
                  state: "approved",
                  body: null,
                  submittedAt: null,
                },
              ],
              comments: [
                {
                  id: "comment-1",
                  author: "octocat",
                  authorAvatarUrl: null,
                  body: "looks good",
                  source: "issue",
                  url: null,
                  path: null,
                  line: null,
                  createdAt: null,
                },
              ],
              files: [],
              commits: [],
              updatedAt: "2026-03-24T12:00:00.000Z",
            }
          : {
              prId,
              detail: null,
              status: null,
              checks: [],
              reviews: [],
              comments: [],
              files: [],
              commits: [],
              updatedAt: "2026-03-24T12:05:00.000Z",
            },
      ]),
      getStatus: vi.fn((_prId: string) => new Promise(() => {})),
      getChecks: vi.fn((_prId: string) => new Promise(() => {})),
      getReviews: vi.fn((_prId: string) => new Promise(() => {})),
      getComments: vi.fn((_prId: string) => new Promise(() => {})),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("reviews-count").textContent).toBe("1");
      expect(screen.getByTestId("comments-count").textContent).toBe("1");
      expect(screen.getByTestId("status").textContent).toBe("success");
    });

    await user.click(screen.getByRole("button", { name: "select pr-2" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-2");
      expect(screen.getByTestId("checks-count").textContent).toBe("0");
      expect(screen.getByTestId("reviews-count").textContent).toBe("0");
      expect(screen.getByTestId("comments-count").textContent).toBe("0");
      expect(screen.getByTestId("status").textContent).toBe("");
    });
  });

  it("clears stale selected PR detail when snapshot cache misses and live detail is pending", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]);
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async ({ prId }: { prId: string }) => prId === "pr-1"
        ? [
            {
              prId,
              detail: null,
              status: { state: "success" },
              checks: [
                {
                  name: "ci",
                  status: "completed",
                  conclusion: "success",
                  detailsUrl: null,
                  startedAt: null,
                  completedAt: null,
                },
              ],
              reviews: [
                {
                  reviewer: "octocat",
                  reviewerAvatarUrl: null,
                  state: "approved",
                  body: null,
                  submittedAt: null,
                },
              ],
              comments: [
                {
                  id: "comment-1",
                  author: "octocat",
                  authorAvatarUrl: null,
                  body: "looks good",
                  source: "issue",
                  url: null,
                  path: null,
                  line: null,
                  createdAt: null,
                },
              ],
              files: [],
              commits: [],
              updatedAt: "2026-03-24T12:00:00.000Z",
            },
          ]
        : []),
      getStatus: vi.fn((_prId: string) => new Promise(() => {})),
      getChecks: vi.fn((_prId: string) => new Promise(() => {})),
      getReviews: vi.fn((_prId: string) => new Promise(() => {})),
      getComments: vi.fn((_prId: string) => new Promise(() => {})),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("reviews-count").textContent).toBe("1");
      expect(screen.getByTestId("comments-count").textContent).toBe("1");
      expect(screen.getByTestId("status").textContent).toBe("success");
    });

    await user.click(screen.getByRole("button", { name: "select pr-2" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-2");
      expect(screen.getByTestId("checks-count").textContent).toBe("0");
      expect(screen.getByTestId("reviews-count").textContent).toBe("0");
      expect(screen.getByTestId("comments-count").textContent).toBe("0");
      expect(screen.getByTestId("status").textContent).toBe("");
    });
  });

  it("marks detail idle when snapshot prefill is available while live detail waits", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async ({ prId }: { prId: string }) => [
        {
          prId,
          detail: null,
          status: {
            prId,
            state: "open",
            checksStatus: "passing",
            reviewStatus: "approved",
            isMergeable: true,
            mergeConflicts: false,
            behindBaseBy: 0,
          },
          checks: [
            {
              name: "cached-ci",
              status: "completed",
              conclusion: "success",
              detailsUrl: null,
              startedAt: null,
              completedAt: null,
            },
          ],
          reviews: [],
          comments: [],
          files: [],
          commits: [],
          updatedAt: "2026-03-24T12:00:00.000Z",
        },
      ]),
      getStatus: vi.fn((_prId: string) => new Promise(() => {})),
      getChecks: vi.fn((_prId: string) => new Promise(() => {})),
      getReviews: vi.fn((_prId: string) => new Promise(() => {})),
      getComments: vi.fn((_prId: string) => new Promise(() => {})),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
    });
  });

  it("applies selected PR status and checks without waiting for slow comments", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({ state: "open" })),
      getChecks: vi.fn(async () => [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
        },
      ]),
      getReviews: vi.fn(async () => []),
      getComments: vi.fn((_prId: string) => new Promise(() => {})),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("");
    });
    expect(window.ade.prs.getComments).toHaveBeenCalledWith("pr-1");
  });

  it("does not mark partial selected PR detail as live or fresh", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]);
    const getStatus = vi.fn(async (prId: string) => ({
      prId,
      state: "open",
      checksStatus: "passing",
      reviewStatus: "approved",
      isMergeable: true,
      mergeConflicts: false,
      behindBaseBy: 0,
    }));
    const getChecks = vi.fn(async () => {
      throw new Error("checks unavailable");
    });
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async () => []),
      getStatus,
      getChecks,
      getReviews: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("");
      expect(getChecks).toHaveBeenCalledWith("pr-1");
    });

    await user.click(screen.getByRole("button", { name: "select pr-2" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-2");
      expect(getStatus).toHaveBeenCalledWith("pr-2");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(getStatus.mock.calls.filter(([prId]) => prId === "pr-1")).toHaveLength(2);
    });
  });

  it("ignores stale primary detail settlements after reselecting the same PR", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]);
    const statusRequests: Record<string, Deferred<{ state: string }>[]> = {};
    const checksRequests: Record<string, Deferred<unknown[]>[]> = {};
    const reviewsRequests: Record<string, Deferred<unknown[]>[]> = {};
    const commentsRequests: Record<string, Deferred<unknown[]>[]> = {};
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async () => []),
      getStatus: vi.fn((prId: string) => enqueueDeferred(statusRequests, prId).promise),
      getChecks: vi.fn((prId: string) => enqueueDeferred(checksRequests, prId).promise),
      getReviews: vi.fn((prId: string) => enqueueDeferred(reviewsRequests, prId).promise),
      getComments: vi.fn((prId: string) => enqueueDeferred(commentsRequests, prId).promise),
    });

    const resolveDetailSet = async (prId: string, index: number, state: string) => {
      const status = statusRequests[prId]?.[index];
      const checks = checksRequests[prId]?.[index];
      const reviews = reviewsRequests[prId]?.[index];
      const comments = commentsRequests[prId]?.[index];
      if (!status || !checks || !reviews || !comments) {
        throw new Error(`Missing detail requests for ${prId} #${index}`);
      }
      await act(async () => {
        status.resolve({ state });
        checks.resolve([
          {
            name: `ci-${state}`,
            status: "completed",
            conclusion: state === "open" ? "success" : "failure",
            detailsUrl: null,
            startedAt: null,
            completedAt: null,
          },
        ]);
        reviews.resolve([]);
        comments.resolve([]);
        await Promise.all([status.promise, checks.promise, reviews.promise, comments.promise]);
      });
    };

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(statusRequests["pr-1"]).toHaveLength(1);
    });
    await user.click(screen.getByRole("button", { name: "select pr-2" }));
    await waitFor(() => {
      expect(statusRequests["pr-2"]).toHaveLength(1);
    });
    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(statusRequests["pr-1"]).toHaveLength(2);
    });

    await resolveDetailSet("pr-1", 1, "open");
    await waitFor(() => {
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("pr-1");
      expect(screen.getByTestId("status").textContent).toBe("open");
    });

    await resolveDetailSet("pr-1", 0, "closed");
    await waitFor(() => {
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("pr-1");
      expect(screen.getByTestId("status").textContent).toBe("open");
    });

    await resolveDetailSet("pr-2", 0, "closed");
  });

  it("uses cached snapshot hydration before applying live detail", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    const liveStatus = createDeferred<any>();
    const liveChecks = createDeferred<any[]>();
    const liveReviews = createDeferred<any[]>();
    const liveComments = createDeferred<any[]>();
    const snapshot: PrSnapshotHydration = {
      prId: "pr-1",
      detail: null,
      status: {
        prId: "pr-1",
        state: "closed",
        checksStatus: "failing",
        reviewStatus: "changes_requested",
        isMergeable: false,
        mergeConflicts: false,
        behindBaseBy: 0,
      },
      checks: [
        {
          name: "cached-ci",
          status: "completed",
          conclusion: "failure",
          detailsUrl: null,
          startedAt: null,
          completedAt: null,
        },
      ],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      updatedAt: "2026-03-24T12:10:00.000Z",
    };
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async (_args: { prId: string }) => [snapshot]),
      getStatus: vi.fn(async (_prId: string) => liveStatus.promise),
      getChecks: vi.fn(async (_prId: string) => liveChecks.promise),
      getReviews: vi.fn(async (_prId: string) => liveReviews.promise),
      getComments: vi.fn(async (_prId: string) => liveComments.promise),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("closed");
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
    });

    expect(window.ade.prs.getStatus).toHaveBeenCalledWith("pr-1");

    await act(async () => {
      liveStatus.resolve({
        prId: "pr-1",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      });
      await liveStatus.promise;
    });

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("");
    });

    await act(async () => {
      liveChecks.resolve([]);
      liveReviews.resolve([]);
      liveComments.resolve([]);
      await Promise.all([liveChecks.promise, liveReviews.promise, liveComments.promise]);
    });

    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("checks-count").textContent).toBe("0");
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("pr-1");
    });
  });

  it("hydrates deployments and AI summary after snapshot prefill while live detail is pending", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    const liveStatus = createDeferred<any>();
    const liveChecks = createDeferred<any[]>();
    const liveReviews = createDeferred<any[]>();
    const liveComments = createDeferred<any[]>();
    const snapshot: PrSnapshotHydration = {
      prId: "pr-1",
      detail: null,
      status: {
        prId: "pr-1",
        state: "closed",
        checksStatus: "failing",
        reviewStatus: "changes_requested",
        isMergeable: false,
        mergeConflicts: false,
        behindBaseBy: 0,
      },
      checks: [],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      updatedAt: "2026-03-24T12:10:00.000Z",
    };
    const deployment: PrDeployment = {
      id: "deployment-1",
      environment: "preview",
      state: "success",
      description: null,
      environmentUrl: "https://preview.example.com",
      logUrl: null,
      sha: "abc123",
      ref: "feature/open",
      creator: "octocat",
      createdAt: "2026-03-24T12:00:00.000Z",
      updatedAt: "2026-03-24T12:05:00.000Z",
    };
    const aiSummary: PrAiSummary = {
      prId: "pr-1",
      summary: "Cached overview is available.",
      riskAreas: [],
      reviewerHotspots: [],
      unresolvedConcerns: [],
      generatedAt: "2026-03-24T12:06:00.000Z",
      headSha: "abc123",
    };
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async (args?: { prId?: string }) => (args?.prId === "pr-1" ? [snapshot] : [])),
      getStatus: vi.fn(async (_prId: string) => liveStatus.promise),
      getChecks: vi.fn(async (_prId: string) => liveChecks.promise),
      getReviews: vi.fn(async (_prId: string) => liveReviews.promise),
      getComments: vi.fn(async (_prId: string) => liveComments.promise),
      getDeployments: vi.fn(async (_prId: string) => [deployment]),
      getAiSummary: vi.fn(async (_prId: string) => aiSummary),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("closed");
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
    });

    await waitFor(() => {
      expect(window.ade.prs.getDeployments).toHaveBeenCalledWith("pr-1");
      expect(window.ade.prs.getAiSummary).toHaveBeenCalledWith("pr-1");
      expect(screen.getByTestId("deployments-count").textContent).toBe("1");
      expect(screen.getByTestId("ai-summary").textContent).toBe("Cached overview is available.");
    });
    expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("");
  });

  it("refreshes secondary detail when a fresh primary detail cache is reused", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    const deployment: PrDeployment = {
      id: "deployment-1",
      environment: "preview",
      state: "success",
      description: null,
      environmentUrl: "https://preview.example.com",
      logUrl: null,
      sha: "abc123",
      ref: "feature/open",
      creator: "octocat",
      createdAt: "2026-03-24T12:00:00.000Z",
      updatedAt: "2026-03-24T12:05:00.000Z",
    };
    const aiSummary: PrAiSummary = {
      prId: "pr-1",
      summary: "Fresh summary is available.",
      riskAreas: [],
      reviewerHotspots: [],
      unresolvedConcerns: [],
      generatedAt: "2026-03-24T12:06:00.000Z",
      headSha: "abc123",
    };
    Object.assign(window.ade.prs, {
      getStatus: vi.fn(async (_prId: string) => ({
        prId: "pr-1",
        state: "open",
        checksStatus: "passing",
        reviewStatus: "approved",
        isMergeable: true,
        mergeConflicts: false,
        behindBaseBy: 0,
      })),
      getChecks: vi.fn(async (_prId: string) => []),
      getReviews: vi.fn(async (_prId: string) => []),
      getComments: vi.fn(async (_prId: string) => []),
      getDeployments: vi.fn(async (_prId: string) => [deployment]),
      getAiSummary: vi.fn(async (_prId: string) => aiSummary),
    });

    render(<ActiveToggleDetailHarness />);

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("live-detail-pr-id").textContent).toBe("pr-1");
      expect(window.ade.prs.getDeployments).toHaveBeenCalledTimes(1);
      expect(window.ade.prs.getAiSummary).toHaveBeenCalledTimes(1);
    });

    await user.click(screen.getByRole("button", { name: "deactivate" }));
    await user.click(screen.getByRole("button", { name: "activate" }));

    await waitFor(() => {
      expect(window.ade.prs.getDeployments).toHaveBeenCalledTimes(2);
      expect(window.ade.prs.getAiSummary).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps cached selected PR detail visible when live GitHub detail is rate limited", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn(async ({ prId }: { prId: string }) => [
        {
          prId,
          detail: null,
          status: {
            prId,
            state: "open",
            checksStatus: "passing",
            reviewStatus: "approved",
            isMergeable: true,
            mergeConflicts: false,
            behindBaseBy: 0,
          },
          checks: [
            {
              name: "cached-ci",
              status: "completed",
              conclusion: "success",
              detailsUrl: null,
              startedAt: null,
              completedAt: null,
            },
          ],
          reviews: [
            {
              reviewer: "octocat",
              reviewerAvatarUrl: null,
              state: "approved",
              body: null,
              submittedAt: null,
            },
          ],
          comments: [
            {
              id: "comment-1",
              author: "octocat",
              authorAvatarUrl: null,
              body: "cached comment",
              source: "issue",
              url: null,
              path: null,
              line: null,
              createdAt: null,
            },
          ],
          files: [],
          commits: [],
          updatedAt: "2026-03-24T12:00:00.000Z",
        },
      ]),
      getStatus: vi.fn(async () => {
        throw new Error("GitHub API rate limit exceeded");
      }),
      getChecks: vi.fn(async () => []),
      getReviews: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
    });

    render(
      <PrsProvider>
        <DetailHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("detail-busy").textContent).toBe("idle");
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("checks-count").textContent).toBe("1");
      expect(screen.getByTestId("reviews-count").textContent).toBe("1");
      expect(screen.getByTestId("comments-count").textContent).toBe("1");
    });
  });

  it("falls back to single merge-context hydration for IDs missing from a batch response", async () => {
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]);
    Object.assign(window.ade.prs, {
      getMergeContexts: vi.fn(async (prIds: string[]) =>
        Object.fromEntries(
          prIds
            .filter((prId) => prId === "pr-1")
            .map((prId) => [prId, {
              prId,
              groupId: null,
              groupType: null,
              sourceLaneIds: [`lane-${prId}`],
              targetLaneId: null,
              integrationLaneId: null,
              members: [],
            }]),
        ),
      ),
      getMergeContext: vi.fn(async (prId: string) => ({
        prId,
        groupId: null,
        groupType: null,
        sourceLaneIds: [`lane-${prId}`],
        targetLaneId: null,
        integrationLaneId: null,
        members: [],
      })),
    });

    render(
      <PrsProvider>
        <MergeContextHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    await waitFor(() => {
      expect(screen.getByTestId("contexts").textContent).toBe("pr-1,pr-2");
    });
    expect(window.ade.prs.getMergeContexts).toHaveBeenCalledWith(["pr-1", "pr-2"]);
    expect(window.ade.prs.getMergeContext).toHaveBeenCalledTimes(1);
    expect(window.ade.prs.getMergeContext).toHaveBeenCalledWith("pr-2");
  });

  it("refreshes workflow conflict analysis after prs-updated events", async () => {
    const user = userEvent.setup();
    let emitPrEvent: ((event: PrEventPayload) => void) | null = null;
    const stalePr = makeFakePr("pr-1", {
      conflictAnalysis: makeFakeConflictAnalysis("pr-1", {
        riskLevel: "high",
        overlapCount: 2,
        conflictPredicted: true,
      }),
    });
    const clearedPr = makeFakePr("pr-1", {
      conflictAnalysis: makeFakeConflictAnalysis("pr-1", {
        riskLevel: "none",
        overlapCount: 0,
        conflictPredicted: false,
      }),
    });
    const eventPr = toPrSummary(makeFakePr("pr-1", { title: "Updated PR pr-1" }));
    const conflictRefreshes = [[stalePr], [clearedPr]];
    const listWithConflicts = vi.fn(async (args?: { includeConflictAnalysis?: boolean }) => {
      if (args?.includeConflictAnalysis === true) {
        return conflictRefreshes.shift() ?? [clearedPr];
      }
      return [makeFakePr("pr-1")];
    });
    Object.assign(window.ade.prs, {
      listWithConflicts,
      onEvent: vi.fn((cb: (event: PrEventPayload) => void) => {
        emitPrEvent = cb;
        return () => {};
      }),
    });

    render(
      <PrsProvider>
        <ConflictRefreshHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    expect(screen.getByTestId("conflict-risk").textContent).toBe("pr-1:none");

    await user.click(screen.getByRole("button", { name: "integration" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("integration");
      expect(screen.getByTestId("conflict-risk").textContent).toBe("pr-1:high");
    });

    await act(async () => {
      emitPrEvent?.({
        type: "prs-updated",
        polledAt: "2026-05-30T12:00:00.000Z",
        prs: [eventPr],
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("conflict-risk").textContent).toBe("pr-1:none");
    });
    expect(listWithConflicts.mock.calls.filter(([args]) => args?.includeConflictAnalysis === true)).toHaveLength(2);
  });

  it("hydrates the Rebase/Merge workflow selection from the initial hash route", async () => {
    window.location.hash = "#/prs?tab=workflows&workflow=rebase&laneId=lane-1";

    render(
      <PrsProvider>
        <RouteHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("rebase");
    });
    expect(screen.getByTestId("selected-pr-id").textContent).toBe("");
    expect(screen.getByTestId("selected-rebase-item-id").textContent).toBe("lane-1");

  });

  it("does not bounce off the rebase workflow when a stale tab=normal shadows the hash", async () => {
    // BrowserRouter mock mode can leave a stale `?tab=normal` in the outer
    // search while the hash advances to a workflow URL. The initial route
    // resolver must treat the hash workflow as authoritative.
    window.history.replaceState(null, "", "/?tab=normal#/prs?tab=workflows&workflow=rebase&laneId=lane-1");
    expect(window.location.search).toBe("?tab=normal");
    expect(window.location.hash).toBe("#/prs?tab=workflows&workflow=rebase&laneId=lane-1");

    render(
      <PrsProvider>
        <RouteHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("rebase");
    });
    expect(screen.getByTestId("selected-pr-id").textContent).toBe("");
    expect(screen.getByTestId("selected-rebase-item-id").textContent).toBe("lane-1");

    window.history.replaceState(null, "", "/");
  });

  it("hydrates a legacy PR deep link without an explicit tab as the normal surface", async () => {
    window.history.replaceState(null, "", "/?prId=pr-123");
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-123")]);

    render(
      <PrsProvider>
        <RouteHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("normal");
    });
    expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-123");
    expect(screen.getByTestId("selected-rebase-item-id").textContent).toBe("");

    window.history.replaceState(null, "", "/");
  });
});

function makeFakeConflictAnalysis(
  prId: string,
  overrides: Partial<PrConflictAnalysis> = {},
): PrConflictAnalysis {
  return {
    prId,
    laneId: `lane-${prId}`,
    riskLevel: "none",
    overlapCount: 0,
    conflictPredicted: false,
    peerConflicts: [],
    analyzedAt: "2026-05-30T12:00:00.000Z",
    ...overrides,
  };
}

function toPrSummary(pr: PrWithConflicts): PrSummary {
  const { conflictAnalysis: _conflictAnalysis, ...summary } = pr;
  return summary;
}

function makeFakePr(id: string, overrides: Partial<PrWithConflicts> = {}): PrWithConflicts {
  return {
    id,
    laneId: `lane-${id}`,
    projectId: "proj-1",
    repoOwner: "test-owner",
    repoName: "test-repo",
    githubPrNumber: 1,
    githubUrl: `https://github.com/test-owner/test-repo/pull/1`,
    githubNodeId: null,
    title: `PR ${id}`,
    state: "open",
    baseBranch: "main",
    headBranch: `feature-${id}`,
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 10,
    deletions: 2,
    lastSyncedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    conflictAnalysis: null,
    ...overrides,
  };
}
