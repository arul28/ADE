/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitCommitSummary } from "../../../shared/types";
import { CommitTimeline } from "./CommitTimeline";
import {
  __resetLaneGitListCacheForTests,
  invalidateLaneGitListCache,
  laneGitListScope,
} from "./laneGitListCache";

vi.mock("../ui/SmartTooltip", () => ({
  SmartTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function commit(id: string, subject: string): GitCommitSummary {
  return {
    sha: id.repeat(40),
    shortSha: id.repeat(7),
    parents: [],
    authorName: "Ada",
    authoredAt: "2026-10-17T10:00:00.000Z",
    subject,
    pushed: true,
  };
}

function renderTimeline(props: Partial<React.ComponentProps<typeof CommitTimeline>> = {}) {
  return render(
    <CommitTimeline
      laneId="lane-1"
      selectedSha={null}
      onSelectCommit={() => undefined}
      cacheScope={laneGitListScope("/repo", "lane-1")}
      cacheBranchRef="feature/a"
      hideHeader
      {...props}
    />,
  );
}

/** Resolves once the History read has landed and its result is rendered. */
async function settle(container: HTMLElement) {
  await waitFor(() => {
    expect(container.querySelector("button:disabled")).toBeNull();
  });
}

describe("CommitTimeline cached history", () => {
  const originalAde = globalThis.window.ade;
  let listRecentCommits: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    __resetLaneGitListCacheForTests();
    listRecentCommits = vi.fn(async () => [commit("2", "feat: second"), commit("1", "feat: first")]);
    globalThis.window.ade = {
      git: {
        listRecentCommits,
        getCommitMessage: vi.fn(async () => ""),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("paints the last history on a remount before the fresh read lands", async () => {
    const first = renderTimeline();
    expect(await screen.findByText("feat: first")).toBeTruthy();
    first.unmount();

    listRecentCommits.mockImplementation(() => new Promise(() => undefined));
    renderTimeline();

    expect(screen.getByText("feat: first")).toBeTruthy();
    expect(listRecentCommits).toHaveBeenCalledTimes(2);
  });

  it("replaces the cached rows once the fresh read lands", async () => {
    const first = renderTimeline();
    await screen.findByText("feat: first");
    first.unmount();

    listRecentCommits.mockResolvedValue([commit("3", "feat: third")]);
    renderTimeline();

    expect(await screen.findByText("feat: third")).toBeTruthy();
    expect(screen.queryByText("feat: first")).toBeNull();
  });

  it("never paints the rows from before a mutation", async () => {
    const first = renderTimeline();
    await screen.findByText("feat: first");
    first.unmount();

    invalidateLaneGitListCache("/repo", "lane-1");
    listRecentCommits.mockImplementation(() => new Promise(() => undefined));
    renderTimeline();

    expect(screen.queryByText("feat: first")).toBeNull();
  });

  it("never paints another lane's or another branch's history", async () => {
    const first = renderTimeline();
    await screen.findByText("feat: first");
    first.unmount();

    listRecentCommits.mockImplementation(() => new Promise(() => undefined));
    const otherLane = renderTimeline({ cacheScope: laneGitListScope("/repo", "lane-2") });
    expect(screen.queryByText("feat: first")).toBeNull();
    otherLane.unmount();

    renderTimeline({ cacheBranchRef: "feature/renamed" });
    expect(screen.queryByText("feat: first")).toBeNull();
  });

  it("ends a revisit with the same rows as a cold read of the same fixture", async () => {
    const cold = renderTimeline();
    await screen.findByText("feat: first");
    await settle(cold.container);
    const coldHtml = cold.container.innerHTML;
    cold.unmount();

    const warm = renderTimeline();
    expect(warm.container.innerHTML).toContain("feat: first");
    await settle(warm.container);

    expect(warm.container.innerHTML).toBe(coldHtml);
  });

  it("keeps the last successful history cached when a later read fails", async () => {
    const first = renderTimeline();
    await screen.findByText("feat: first");
    first.unmount();

    listRecentCommits.mockRejectedValueOnce(new Error("Lane worktree is missing. Restore it."));
    const failed = renderTimeline();
    expect(await screen.findByText("Lane worktree is missing. Restore it.")).toBeTruthy();
    failed.unmount();

    listRecentCommits.mockImplementation(() => new Promise(() => undefined));
    renderTimeline();

    expect(screen.getByText("feat: first")).toBeTruthy();
  });
});
