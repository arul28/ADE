// @vitest-environment jsdom

import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

const originalAde = globalThis.window.ade;

function makeFakePr(id: string) {
  return {
    id,
    laneId: `lane-${id}`,
    projectId: "proj-1",
    repoOwner: "octocat",
    repoName: "hello-world",
    githubPrNumber: 42,
    githubUrl: `https://github.com/octocat/hello-world/pull/${id}`,
    githubNodeId: `node-${id}`,
    title: `PR ${id}`,
    state: "open",
    baseBranch: "main",
    headBranch: `feature/${id}`,
    checksStatus: "none",
    reviewStatus: "none",
    additions: 1,
    deletions: 1,
    lastSyncedAt: null,
    createdAt: "2026-03-24T12:00:00.000Z",
    updatedAt: "2026-03-24T12:00:00.000Z",
    conflictAnalysis: null,
    creationStrategy: "manual",
  };
}

function installAde(listSnapshots: ReturnType<typeof vi.fn>) {
  globalThis.window.ade = {
    prs: {
      refresh: vi.fn().mockResolvedValue(undefined),
      listWithConflicts: vi.fn().mockResolvedValue([makeFakePr("pr-1")]),
      listQueueStates: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
      listSnapshots,
      getStatus: vi.fn().mockResolvedValue({ state: "open" }),
      getChecks: vi.fn().mockResolvedValue([]),
      getReviews: vi.fn().mockResolvedValue([]),
      getComments: vi.fn().mockResolvedValue([]),
      getReviewThreads: vi.fn().mockResolvedValue([]),
      getDeployments: vi.fn().mockResolvedValue([]),
      getAiSummary: vi.fn().mockResolvedValue(null),
      getMergeContext: vi.fn().mockResolvedValue({
        prId: "pr-1",
        groupId: null,
        groupType: null,
        sourceLaneIds: ["lane-pr-1"],
        targetLaneId: null,
        integrationLaneId: null,
        members: [],
      }),
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
}

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  globalThis.window.ade = originalAde;
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});

it("does not let snapshot prefill overwrite a warm detail cache", async () => {
  vi.stubEnv("MODE", "production");
  window.history.replaceState(null, "", "/");
  window.location.hash = "";

  const { PrsProvider, usePrs } = await import("./PrsContext");

  function DetailHarness() {
    const { detailStatus, loading, selectedPrId, setSelectedPrId } = usePrs();
    return (
      <div>
        <button type="button" onClick={() => setSelectedPrId("pr-1")}>
          select pr-1
        </button>
        <div data-testid="loading">{loading ? "loading" : "idle"}</div>
        <div data-testid="selected-pr-id">{selectedPrId ?? ""}</div>
        <div data-testid="status">{detailStatus?.state ?? ""}</div>
      </div>
    );
  }

  const coldSnapshots = vi.fn().mockResolvedValue([]);
  installAde(coldSnapshots);

  const firstRender = render(
    <PrsProvider>
      <DetailHarness />
    </PrsProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("idle");
  });
  await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));
  await waitFor(() => {
    expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-1");
    expect(screen.getByTestId("status").textContent).toBe("open");
  });
  await act(async () => {
    await Promise.resolve();
  });
  firstRender.unmount();

  const staleSnapshots = vi.fn().mockResolvedValue([
    {
      prId: "pr-1",
      detail: null,
      status: { state: "closed" },
      checks: [],
      reviews: [],
      comments: [],
      files: [],
      commits: [],
      updatedAt: "2026-03-24T12:05:00.000Z",
    },
  ]);
  installAde(staleSnapshots);

  render(
    <PrsProvider>
      <DetailHarness />
    </PrsProvider>,
  );

  await waitFor(() => {
    expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-1");
    expect(screen.getByTestId("status").textContent).toBe("open");
  });
  await act(async () => {
    await Promise.resolve();
  });

  expect(staleSnapshots).toHaveBeenCalledTimes(1);
  expect(staleSnapshots).toHaveBeenCalledWith({});
  expect(screen.getByTestId("status").textContent).toBe("open");
});
