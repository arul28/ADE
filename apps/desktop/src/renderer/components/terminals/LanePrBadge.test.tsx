/* @vitest-environment jsdom */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { LanePrBadge } from "./LanePrBadge";

function pr(overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    id: "pr-1",
    laneId: "lane-1",
    projectId: "project-1",
    repoOwner: "ade",
    repoName: "desktop",
    githubPrNumber: 101,
    githubUrl: "https://github.com/ade/desktop/pull/101",
    githubNodeId: null,
    title: "Current work",
    state: "open",
    baseBranch: "main",
    headBranch: "current",
    checksStatus: "passing",
    reviewStatus: "approved",
    additions: 1,
    deletions: 0,
    lastSyncedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("LanePrBadge", () => {
  it("keeps a single PR as the compact chip", () => {
    render(<LanePrBadge pr={pr()} onOpen={vi.fn()} />);

    expect(screen.getByRole("button", { name: /Pull request #101/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /other pull requests/ })).toBeNull();
  });

  it("shows a counter and lets the hover list open a specific PR", () => {
    const onOpen = vi.fn();
    const onOpenList = vi.fn();
    const previous = pr({
      id: "pr-100",
      githubPrNumber: 100,
      title: "Previous work",
      state: "merged",
      headBranch: "previous",
    });
    render(
      <LanePrBadge
        pr={pr()}
        prs={[pr(), previous]}
        onOpen={onOpen}
        onOpenList={onOpenList}
      />,
    );

    expect(screen.getByRole("button", { name: "Open 2 pull requests for this lane" })).toBeTruthy();
    fireEvent.click(screen.getByTitle("Pull request #100 · Merged · Previous work"));
    expect(onOpen).toHaveBeenCalledWith(previous);

    fireEvent.click(screen.getByRole("button", { name: "Open 2 pull requests for this lane" }));
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });
});
