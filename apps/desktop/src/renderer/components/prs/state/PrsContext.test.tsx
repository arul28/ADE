// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoRebaseLaneStatus, PrConvergenceState, PrConvergenceStatePatch, PrSnapshotHydration, PrSummary, PrWithConflicts, RebaseNeed } from "../../../../shared/types";
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
  const { activeTab, selectedPrId, selectedQueueGroupId, selectedRebaseItemId } = usePrs();
  return (
    <div>
      <div data-testid="active-tab">{activeTab}</div>
      <div data-testid="selected-pr-id">{selectedPrId ?? ""}</div>
      <div data-testid="selected-queue-group-id">{selectedQueueGroupId ?? ""}</div>
      <div data-testid="selected-rebase-item-id">{selectedRebaseItemId ?? ""}</div>
    </div>
  );
}

function TabSwitchHarness() {
  const { activeTab, setActiveTab, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => setActiveTab("queue")}>
        queue
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="active-tab">{activeTab}</div>
    </div>
  );
}

function DetailHarness() {
  const {
    detailBusy,
    detailChecks,
    detailReviews,
    detailComments,
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
      <div data-testid="status">{detailStatus?.state ?? ""}</div>
      <div data-testid="checks-count">{detailChecks.length}</div>
      <div data-testid="reviews-count">{detailReviews.length}</div>
      <div data-testid="comments-count">{detailComments.length}</div>
    </div>
  );
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
        listQueueStates: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
        listAutoRebaseStatuses: vi.fn().mockResolvedValue([refreshedAutoStatus]),
        onAutoRebaseEvent: vi.fn(() => () => {}),
      },
      rebase: {
        scanNeeds: vi.fn().mockResolvedValue([refreshedNeed]),
        onEvent: vi.fn(() => () => {}),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
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
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();

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
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "refresh pr-1" }));

    await waitFor(() => {
      expect(window.ade.prs.refresh).toHaveBeenCalledWith({ prId: "pr-1" });
    });
  });

  it("preserves targeted refresh args queued behind an in-flight refresh", async () => {
    const user = userEvent.setup();
    let resolveFirstRefresh!: () => void;
    vi.mocked(window.ade.prs.refresh).mockImplementationOnce(() => new Promise<PrSummary[]>((resolve) => {
      resolveFirstRefresh = () => resolve([]);
    }));

    render(
      <PrsProvider>
        <DualRefreshHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

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
    expect(window.ade.prs.refresh).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "queue" }));

    await waitFor(() => {
      expect(screen.getByTestId("active-tab").textContent).toBe("queue");
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
    });
    expect(window.ade.prs.getComments).toHaveBeenCalledWith("pr-1");
  });

  it("does not let cached snapshot hydration overwrite live detail data", async () => {
    const user = userEvent.setup();
    vi.mocked(window.ade.prs.listWithConflicts).mockResolvedValue([makeFakePr("pr-1")]);
    let resolveSnapshots!: (snapshots: PrSnapshotHydration[]) => void;
    const snapshotsPromise = new Promise<PrSnapshotHydration[]>((resolve) => {
      resolveSnapshots = resolve;
    });
    Object.assign(window.ade.prs, {
      listSnapshots: vi.fn((_args: { prId: string }) => snapshotsPromise),
      getStatus: vi.fn(async (_prId: string) => ({ state: "open" })),
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

    await user.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("status").textContent).toBe("open");
      expect(screen.getByTestId("checks-count").textContent).toBe("0");
    });

    await act(async () => {
      resolveSnapshots([
        {
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
              name: "stale-ci",
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
        },
      ]);
      await snapshotsPromise;
    });

    expect(screen.getByTestId("status").textContent).toBe("open");
    expect(screen.getByTestId("checks-count").textContent).toBe("0");
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
    expect(screen.getByTestId("selected-queue-group-id").textContent).toBe("");
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
    expect(screen.getByTestId("selected-queue-group-id").textContent).toBe("");
    expect(screen.getByTestId("selected-rebase-item-id").textContent).toBe("");

    window.history.replaceState(null, "", "/");
  });
});

// ---------------------------------------------------------------------------
// Convergence state management
// ---------------------------------------------------------------------------

function makeFakeConvergenceState(prId: string, overrides?: Partial<PrConvergenceState>): PrConvergenceState {
  const now = new Date().toISOString();
  return {
    prId,
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

function makeFakePr(id: string): PrWithConflicts {
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
  };
}

/** Harness that exposes convergence-related methods and state */
function ConvergenceHarness() {
  const {
    loadConvergenceState,
    saveConvergenceState,
    resetConvergenceState,
    convergenceStatesByPrId,
    loading,
  } = usePrs();

  const resultRef = React.useRef<PrConvergenceState | null>(null);

  return (
    <div>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="cached-keys">{Object.keys(convergenceStatesByPrId).sort().join(",")}</div>
      <div data-testid="result">{resultRef.current ? JSON.stringify(resultRef.current) : "none"}</div>
      <button
        type="button"
        data-testid="load"
        onClick={async () => {
          const result = await loadConvergenceState("pr-1");
          resultRef.current = result;
        }}
      >
        load
      </button>
      <button
        type="button"
        data-testid="load-force"
        onClick={async () => {
          const result = await loadConvergenceState("pr-1", { force: true });
          resultRef.current = result;
        }}
      >
        load-force
      </button>
      <button
        type="button"
        data-testid="save"
        onClick={async () => {
          const result = await saveConvergenceState("pr-1", { autoConvergeEnabled: true });
          resultRef.current = result;
        }}
      >
        save
      </button>
      <button
        type="button"
        data-testid="save-then-load"
        onClick={async () => {
          await saveConvergenceState("pr-1", { autoConvergeEnabled: true });
          const result = await loadConvergenceState("pr-1");
          resultRef.current = result;
        }}
      >
        save-then-load
      </button>
      <button
        type="button"
        data-testid="reset"
        onClick={async () => {
          await resetConvergenceState("pr-1");
          resultRef.current = null;
        }}
      >
        reset
      </button>
    </div>
  );
}

describe("PrsContext convergence state", () => {
  let convergenceGetMock: ReturnType<typeof vi.fn>;
  let convergenceSaveMock: ReturnType<typeof vi.fn>;
  let convergenceDeleteMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    convergenceGetMock = vi.fn().mockImplementation(() =>
      Promise.resolve(makeFakeConvergenceState("pr-1")),
    );
    convergenceSaveMock = vi.fn().mockImplementation(() =>
      Promise.resolve(makeFakeConvergenceState("pr-1", { autoConvergeEnabled: true })),
    );
    convergenceDeleteMock = vi.fn().mockResolvedValue(undefined);

    globalThis.window.ade = {
      prs: {
        refresh: vi.fn().mockResolvedValue(undefined),
        listWithConflicts: vi.fn().mockResolvedValue([makeFakePr("pr-1")]),
        listQueueStates: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
        convergenceStateGet: convergenceGetMock,
        convergenceStateSave: convergenceSaveMock,
        convergenceStateDelete: convergenceDeleteMock,
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
        listAutoRebaseStatuses: vi.fn().mockResolvedValue([]),
        onAutoRebaseEvent: vi.fn(() => () => {}),
      },
      rebase: {
        scanNeeds: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("loadConvergenceState calls IPC when not cached and stores result", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // Click load — should call IPC
    await user.click(screen.getByTestId("load"));

    await waitFor(() => {
      expect(convergenceGetMock).toHaveBeenCalledWith("pr-1");
    });

    // State should now be cached
    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });
  });

  it("loadConvergenceState returns cached state without calling IPC when already loaded", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // First load — populates cache via IPC
    await user.click(screen.getByTestId("load"));
    await waitFor(() => {
      expect(convergenceGetMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });

    // Second load — should use cache, no new IPC call
    await user.click(screen.getByTestId("load"));

    // Give React a tick to process
    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });

    // IPC should still have been called only once
    expect(convergenceGetMock).toHaveBeenCalledTimes(1);
  });

  it("loadConvergenceState with force: true always calls IPC even when cached", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // First load — populates cache
    await user.click(screen.getByTestId("load"));
    await waitFor(() => {
      expect(convergenceGetMock).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });

    // Force load — should call IPC again
    await user.click(screen.getByTestId("load-force"));
    await waitFor(() => {
      expect(convergenceGetMock).toHaveBeenCalledTimes(2);
    });
  });

  it("saveConvergenceState calls IPC and updates cache", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // Save — calls IPC and caches
    await user.click(screen.getByTestId("save"));

    await waitFor(() => {
      expect(convergenceSaveMock).toHaveBeenCalledWith("pr-1", { autoConvergeEnabled: true });
    });

    // State should now be cached
    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });
  });

  it("uses the updated ref cache for a back-to-back save then load", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    await user.click(screen.getByTestId("save-then-load"));

    await waitFor(() => {
      expect(convergenceSaveMock).toHaveBeenCalledWith("pr-1", { autoConvergeEnabled: true });
    });

    expect(convergenceGetMock).not.toHaveBeenCalled();
  });

  it("resetConvergenceState calls IPC delete and removes from cache", async () => {
    const user = userEvent.setup();
    render(
      <PrsProvider>
        <ConvergenceHarness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // First load to populate cache
    await user.click(screen.getByTestId("load"));
    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });

    // Reset — calls IPC delete and removes from cache
    await user.click(screen.getByTestId("reset"));

    await waitFor(() => {
      expect(convergenceDeleteMock).toHaveBeenCalledWith("pr-1");
    });

    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("");
    });
  });

  it("convergence states are pruned when PR list changes", async () => {
    const pr1 = makeFakePr("pr-1");
    const pr2 = makeFakePr("pr-2");

    // Use a mutable variable so we can switch the return value after init
    let activePrs: PrWithConflicts[] = [pr1, pr2];
    const listMock = vi.fn().mockImplementation(() => Promise.resolve(activePrs));

    globalThis.window.ade = {
      prs: {
        refresh: vi.fn().mockResolvedValue(undefined),
        listWithConflicts: listMock,
        listQueueStates: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
        convergenceStateGet: vi.fn().mockImplementation((prId: string) =>
          Promise.resolve(makeFakeConvergenceState(prId)),
        ),
        convergenceStateSave: vi.fn().mockImplementation((prId: string, partial: PrConvergenceStatePatch) =>
          Promise.resolve(makeFakeConvergenceState(prId, partial)),
        ),
        convergenceStateDelete: vi.fn().mockResolvedValue(undefined),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
        listAutoRebaseStatuses: vi.fn().mockResolvedValue([]),
        onAutoRebaseEvent: vi.fn(() => () => {}),
      },
      rebase: {
        scanNeeds: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
      },
    } as any;

    function PruneHarness() {
      const {
        loadConvergenceState,
        convergenceStatesByPrId,
        loading,
        refresh,
      } = usePrs();

      return (
        <div>
          <div data-testid="loading">{loading ? "loading" : "idle"}</div>
          <div data-testid="cached-keys">{Object.keys(convergenceStatesByPrId).sort().join(",")}</div>
          <button
            type="button"
            data-testid="load-pr1"
            onClick={() => void loadConvergenceState("pr-1")}
          >
            load-pr1
          </button>
          <button
            type="button"
            data-testid="load-pr2"
            onClick={() => void loadConvergenceState("pr-2")}
          >
            load-pr2
          </button>
          <button
            type="button"
            data-testid="refresh"
            onClick={() => void refresh()}
          >
            refresh
          </button>
        </div>
      );
    }

    const user = userEvent.setup();
    render(
      <PrsProvider>
        <PruneHarness />
      </PrsProvider>,
    );

    // Wait for initial load
    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });

    // Load convergence state for both PRs
    await user.click(screen.getByTestId("load-pr1"));
    await user.click(screen.getByTestId("load-pr2"));

    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1,pr-2");
    });

    // Switch the PR list to only include pr-1, then refresh
    activePrs = [pr1];
    await user.click(screen.getByTestId("refresh"));

    // After refresh, pr-2 should be pruned from convergence cache
    await waitFor(() => {
      expect(screen.getByTestId("cached-keys").textContent).toBe("pr-1");
    });
  });
});
