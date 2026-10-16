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

/** Opens the multi-PR hover list on LanePrBadgePopover's pill. */
function openPopoverHoverCard(): HTMLElement {
  const pill = screen.getByRole("button", { name: /PR #101/ });
  const trigger = pill.parentElement;
  if (!(trigger instanceof HTMLElement)) throw new Error("popover hover trigger not found");
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

  it("shows a caret and lets the hover list open a specific PR or the list", () => {
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

    const pill = screen.getByRole("button", { name: /1 other pull requests on this lane/ });
    expect(pill).toBeTruthy();
    expect(screen.getByTestId("lane-pr-badge-caret")).toBeTruthy();
    const hoverCard = openLanePrHoverCard();
    // Portaled out of the pill so row/pill overflow cannot clip the list.
    expect(pill.contains(hoverCard)).toBe(false);
    fireEvent.click(screen.getByTitle("Pull request #100 · Merged · Previous work"));
    expect(onOpen).toHaveBeenCalledWith(previous);

    fireEvent.click(screen.getByText("Show all in Pull requests"));
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

  it("does not bubble portaled panel clicks into the enclosing row", () => {
    const onRowClick = vi.fn();
    const onRowMouseDown = vi.fn();
    render(
      <div onClick={onRowClick} onMouseDown={onRowMouseDown}>
        <LanePrBadge
          pr={pr()}
          prs={[pr(), pr({ id: "pr-100", githubPrNumber: 100 })]}
          onOpen={vi.fn()}
        />
      </div>,
    );

    const hoverCard = openLanePrHoverCard();
    fireEvent.mouseDown(hoverCard);
    fireEvent.click(hoverCard);

    expect(onRowMouseDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
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

  it("adds a Show all row to the multi-PR hover list only when a list handler is given", () => {
    const prs = [tag(), tag({ id: "pr-100", githubPrNumber: 100, title: "Previous work", state: "merged" })];

    const { unmount } = render(<LanePrBadgePopover prs={prs} onActivate={vi.fn()} />);
    openPopoverHoverCard();
    expect(screen.getByText("Previous work")).toBeTruthy();
    expect(screen.queryByText("Show all in Pull requests")).toBeNull();

    unmount();
    render(<LanePrBadgePopover prs={prs} onActivate={vi.fn()} onOpenList={vi.fn()} />);
    openPopoverHoverCard();
    expect(screen.getByText("Show all in Pull requests")).toBeTruthy();
  });
});
