// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubRequestBudget } from "../../../../shared/types";
import { PrsProvider, usePrs } from "./PrsContext";

/**
 * Wiring-level cover for the 2026-08-17 quota burn. `githubPollGovernor.test.ts`
 * proves the ladder maths; these prove the provider is actually plumbed to it —
 * that a failed PR read arms it and that the runtime's 500-request reserve
 * reaches the foreground timers at all, which was the gap that let one open PR
 * detail pane spend 5,001 core requests in an hour.
 */

const originalAde = globalThis.window.ade;

const CHECKS_BASE_PERIOD_MS = 5_000;

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
    createdAt: "2026-08-17T12:00:00.000Z",
    updatedAt: "2026-08-17T12:00:00.000Z",
    conflictAnalysis: null,
    creationStrategy: "manual",
  };
}

function budget(overrides: Partial<GitHubRequestBudget> = {}): GitHubRequestBudget {
  return { pausedUntil: null, failureKind: null, retryAt: null, ...overrides };
}

function installAde(options: {
  getChecks?: ReturnType<typeof vi.fn>;
  getRequestBudget?: unknown;
}) {
  globalThis.window.ade = {
    prs: {
      refresh: vi.fn().mockResolvedValue(undefined),
      listWithConflicts: vi.fn().mockResolvedValue([makeFakePr("pr-1"), makeFakePr("pr-2")]),
      onEvent: vi.fn(() => () => {}),
      listSnapshots: vi.fn().mockResolvedValue([]),
      getStatus: vi.fn().mockResolvedValue({ state: "open" }),
      getChecks: options.getChecks ?? vi.fn().mockResolvedValue([]),
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
    github: options.getRequestBudget === undefined
      ? {}
      : { getRequestBudget: options.getRequestBudget },
    lanes: {
      list: vi.fn().mockResolvedValue([]),
      listAutoRebaseStatuses: vi.fn().mockResolvedValue([]),
      onAutoRebaseEvent: vi.fn(() => () => {}),
      onLifecycleEvent: vi.fn(() => () => {}),
    },
    rebase: {
      scanNeeds: vi.fn().mockResolvedValue([]),
      onEvent: vi.fn(() => () => {}),
    },
  } as never;
}

function GovernorHarness() {
  const {
    isGithubPollStoodDown,
    githubPollPeriodFor,
    loading,
    setSelectedPrId,
    selectedPrId,
  } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => setSelectedPrId("pr-1")}>select pr-1</button>
      <button type="button" onClick={() => setSelectedPrId("pr-2")}>select pr-2</button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="selected-pr-id">{selectedPrId ?? ""}</div>
      <div data-testid="paused">{isGithubPollStoodDown() ? "paused" : "running"}</div>
      <div data-testid="period">{githubPollPeriodFor(CHECKS_BASE_PERIOD_MS)}</div>
    </div>
  );
}

async function renderHarness(options: Parameters<typeof installAde>[0]) {
  installAde(options);
  render(
    <PrsProvider>
      <GovernorHarness />
    </PrsProvider>,
  );
  await waitFor(() => {
    expect(screen.getByTestId("loading").textContent).toBe("idle");
  });
}

afterEach(() => {
  cleanup();
  globalThis.window.ade = originalAde;
  window.location.hash = "";
  window.history.replaceState(null, "", "/");
});

describe("PrsContext GitHub poll governor", () => {
  it("does not hold the fast checks cadence open when the checks read fails", async () => {
    // The regression: `getChecks` rejecting during the GitHub outage left the
    // pane looking like CI had not started, so the 5s loop kept running at
    // ~7-10 requests a tick until the quota was gone.
    const getChecks = vi.fn().mockRejectedValue(new Error("GitHub API request failed (HTTP 503)"));
    await renderHarness({ getChecks });

    await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));

    await waitFor(() => {
      expect(getChecks).toHaveBeenCalled();
      expect(screen.getByTestId("paused").textContent).toBe("paused");
    });
    expect(Number(screen.getByTestId("period").textContent))
      .toBeGreaterThan(CHECKS_BASE_PERIOD_MS);
  });

  it("keeps the fast cadence while GitHub is answering", async () => {
    await renderHarness({});
    await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));

    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-1");
    });
    expect(screen.getByTestId("paused").textContent).toBe("running");
    expect(Number(screen.getByTestId("period").textContent)).toBe(CHECKS_BASE_PERIOD_MS);
  });

  it("stands foreground reads down at the 500-request reserve", async () => {
    // The reserve was previously enforced in exactly one place — the background
    // PR poller — while every foreground read went straight to
    // `githubService.apiRequest` with no gate at all.
    const pausedUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    await renderHarness({ getRequestBudget: vi.fn().mockResolvedValue(budget({ pausedUntil })) });

    await waitFor(() => {
      expect(screen.getByTestId("paused").textContent).toBe("paused");
    });
    expect(Number(screen.getByTestId("period").textContent))
      .toBeGreaterThan(CHECKS_BASE_PERIOD_MS);
  });

  it("leaves foreground reads running while quota is healthy", async () => {
    const getRequestBudget = vi.fn().mockResolvedValue(budget());
    await renderHarness({ getRequestBudget });

    // Assert the budget was actually consulted: "running" is also the initial
    // state, so without this the test would pass even if it were never read.
    await waitFor(() => {
      expect(getRequestBudget).toHaveBeenCalled();
    });
    expect(screen.getByTestId("paused").textContent).toBe("running");
    expect(Number(screen.getByTestId("period").textContent)).toBe(CHECKS_BASE_PERIOD_MS);
  });

  it("keeps the quota reserve armed across a successful user-driven read", async () => {
    // User actions are ungated on purpose, so their successes reach the
    // governor. When the reserve shared one field with the failure ladder, a
    // single PR open wiped it and handed the automatic loops their 5s cadence
    // back with the quota still below the reserve.
    const pausedUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    await renderHarness({
      getRequestBudget: vi.fn().mockResolvedValue(budget({ pausedUntil })),
    });
    await waitFor(() => {
      expect(screen.getByTestId("paused").textContent).toBe("paused");
    });

    await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-1");
    });

    expect(screen.getByTestId("paused").textContent).toBe("paused");
  });

  it("survives a runtime that cannot answer the budget read", async () => {
    // An older remote runtime has no `github.getRequestBudget` action. Losing
    // the reserve signal must not also lose the local failure ladder.
    const getChecks = vi.fn().mockRejectedValue(new Error("GitHub API request failed (HTTP 503)"));
    await renderHarness({ getChecks, getRequestBudget: undefined });

    await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));

    await waitFor(() => {
      expect(screen.getByTestId("paused").textContent).toBe("paused");
    });
  });

  it("keeps the stand-down when the user selects a different PR", async () => {
    // The old backoff was reset on every PR selection, so clicking around a
    // stuck tab — the natural reaction — disarmed the only brake. GitHub being
    // down is account-wide, not per-PR. Selecting a *different* PR is what
    // re-runs the effect that used to clear it.
    const getChecks = vi.fn().mockRejectedValue(new Error("GitHub API request failed (HTTP 503)"));
    await renderHarness({ getChecks });

    await userEvent.click(screen.getByRole("button", { name: "select pr-1" }));
    await waitFor(() => {
      expect(screen.getByTestId("paused").textContent).toBe("paused");
    });

    await userEvent.click(screen.getByRole("button", { name: "select pr-2" }));
    await waitFor(() => {
      expect(screen.getByTestId("selected-pr-id").textContent).toBe("pr-2");
    });
    expect(screen.getByTestId("paused").textContent).toBe("paused");
  });
});
