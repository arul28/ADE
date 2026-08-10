/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "../../../shared/types";
import { LanePrBadge } from "./LanePrBadge";
import { LanePrBadgePopover } from "../lanes/LanePrBadgePopover";
import type { LaneTabPrTag } from "../lanes/lanePageModel";

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

function tag(overrides: Partial<LaneTabPrTag> = {}): LaneTabPrTag {
  return {
    source: "ade",
    id: "pr-1",
    linkedPrId: "pr-1",
    githubPrNumber: 101,
    githubUrl: "https://github.com/ade/desktop/pull/101",
    repoOwner: "ade",
    repoName: "desktop",
    title: "Current work",
    state: "open",
    checksStatus: "passing",
    reviewStatus: "approved",
    ...overrides,
  };
}

function openLanePrHoverCard(): HTMLElement {
  const cluster = screen.getByTitle("2 pull requests on this lane");
  const trigger = cluster.firstElementChild;
  if (!(trigger instanceof HTMLElement)) throw new Error("lane PR hover trigger not found");
  fireEvent.mouseEnter(trigger);
  return screen.getByTestId("lane-pr-hover-card");
}

afterEach(cleanup);

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
    const hoverCard = openLanePrHoverCard();
    expect(hoverCard.parentElement).toBe(document.body);
    fireEvent.click(screen.getByTitle("Pull request #100 · Merged · Previous work"));
    expect(onOpen).toHaveBeenCalledWith(previous);

    fireEvent.click(screen.getByRole("button", { name: "Open 2 pull requests for this lane" }));
    expect(onOpenList).toHaveBeenCalledTimes(1);
  });

  it("announces each multi-PR row's CI and review status", () => {
    render(
      <LanePrBadge
        pr={pr()}
        prs={[pr(), pr({ id: "pr-100", githubPrNumber: 100, checksStatus: "failing", reviewStatus: "changes_requested" })]}
        onOpen={vi.fn()}
      />,
    );

    openLanePrHoverCard();
    expect(screen.getByRole("img", { name: "CI failing; Review changes requested" })).toBeTruthy();
  });

  it("keeps the lane PR hover card open while its own panel scrolls", () => {
    render(
      <LanePrBadge
        pr={pr()}
        prs={[pr(), pr({ id: "pr-100", githubPrNumber: 100 })]}
        onOpen={vi.fn()}
      />,
    );

    const hoverCard = openLanePrHoverCard();
    fireEvent.scroll(hoverCard);

    expect(screen.getByTestId("lane-pr-hover-card")).toBe(hoverCard);
  });

  it("moves focus into the multi-PR hover card from the trigger", async () => {
    render(
      <LanePrBadge
        pr={pr()}
        prs={[pr(), pr({ id: "pr-100", githubPrNumber: 100 })]}
        onOpen={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: /Pull request #101/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });

    const hoverCard = await screen.findByTestId("lane-pr-hover-card");
    const firstRow = hoverCard.querySelector<HTMLElement>('[role="button"]');
    expect(firstRow).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(firstRow));

    fireEvent.keyDown(firstRow!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("lane-pr-hover-card")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps a popover count non-interactive without a list handler", () => {
    render(
      <LanePrBadgePopover
        prs={[tag(), tag({ id: "pr-100", githubPrNumber: 100, title: "Previous work", state: "merged" })]}
        onActivate={vi.fn()}
      />,
    );

    const count = screen.getByTitle("Hover to inspect all pull requests for this lane");
    expect(count.tagName).toBe("SPAN");
    expect(count.getAttribute("role")).toBeNull();
  });
});
