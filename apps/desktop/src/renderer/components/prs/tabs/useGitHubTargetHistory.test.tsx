// @vitest-environment jsdom

import React from "react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubPrSnapshot } from "../../../../shared/types";
import type { PrRouteSelectionTarget } from "../prsRouteState";
import { useGitHubTargetHistory } from "./useGitHubTargetHistory";

const target: PrRouteSelectionTarget = {
  prId: null,
  prNumber: 224,
  repoOwner: "ade-dev",
  repoName: "ade",
};

const staleSnapshot: GitHubPrSnapshot = {
  repo: { owner: "ade-dev", name: "ade" },
  viewerLogin: "octocat",
  repoPullRequests: [],
  externalPullRequests: [],
  syncedAt: "2026-03-13T12:00:00.000Z",
  history: {
    includeExternalClosed: true,
    pageLimit: 2,
    repoPullRequestsLoaded: 2,
    repoPullRequestsMayHaveMore: true,
    repoPullRequestCounts: null,
  },
};

function Harness({
  loadSnapshot,
  snapshot,
}: {
  loadSnapshot: (options?: {
    force?: boolean;
    silent?: boolean;
    includeExternalClosed?: boolean;
    historyPageLimit?: number;
  }) => Promise<GitHubPrSnapshot | null>;
  snapshot: GitHubPrSnapshot;
}) {
  useGitHubTargetHistory({
    displayedItems: [],
    loadSnapshot,
    selectedPrId: null,
    selectedPrTarget: target,
    snapshot,
  });
  return null;
}

describe("useGitHubTargetHistory", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs off when a forced history fetch returns the same page limit", async () => {
    const loadSnapshot = vi.fn().mockResolvedValue(staleSnapshot);
    render(<Harness loadSnapshot={loadSnapshot} snapshot={staleSnapshot} />);

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);
    expect(loadSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      force: true,
      includeExternalClosed: true,
      historyPageLimit: 4,
      silent: true,
    }));

    await act(async () => {
      vi.advanceTimersByTime(29_999);
      await Promise.resolve();
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(loadSnapshot).toHaveBeenCalledTimes(3);
  });
});
