/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutoRebaseLaneStatus, LaneSummary, RebaseSuggestion } from "../../../shared/types";
import { LaneRebaseBanner } from "./LaneRebaseBanner";

vi.mock("../ui/SmartTooltip", () => ({
  SmartTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function lane(id: string, name: string): LaneSummary {
  return { id, name, worktreePath: `/tmp/${id}` } as LaneSummary;
}

function suggestion(laneId: string, behindCount = 3): RebaseSuggestion {
  return { laneId, behindCount, baseLabel: "origin/main", hasPr: false } as RebaseSuggestion;
}

function attention(laneId: string): AutoRebaseLaneStatus {
  return { laneId, state: "rebaseConflict", message: "Manual rebase required." } as AutoRebaseLaneStatus;
}

function renderBanner(props: Partial<React.ComponentProps<typeof LaneRebaseBanner>> = {}) {
  const lanesById = new Map<string, LaneSummary>([
    ["a", lane("a", "lane-a")],
    ["b", lane("b", "lane-b")],
  ]);
  return render(
    <LaneRebaseBanner
      visibleRebaseSuggestions={[]}
      visibleAutoRebaseNeedsAttention={[]}
      lanesById={lanesById}
      rebaseSuggestionError={null}
      onViewRebaseDetails={vi.fn()}
      onDismissRebase={vi.fn()}
      onDismissAutoRebase={vi.fn()}
      {...props}
    />,
  );
}

describe("LaneRebaseBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows rebase suggestion errors even when no rebase lists are visible", () => {
    renderBanner({ rebaseSuggestionError: "Could not load rebase suggestions." });
    expect(screen.getByText("Could not load rebase suggestions.")).toBeTruthy();
  });

  it("renders the full strip in banner mode", () => {
    renderBanner({ visibleRebaseSuggestions: [suggestion("a")], display: "banner" });
    expect(screen.getByText("REBASE SUGGESTED")).toBeTruthy();
    expect(screen.getByText("lane-a")).toBeTruthy();
  });

  it("collapses to a single summary line in badge mode", () => {
    renderBanner({
      visibleRebaseSuggestions: [suggestion("a"), suggestion("b")],
      display: "badge",
    });

    // No strip, no per-lane cards, no dismiss buttons.
    expect(screen.queryByText("REBASE SUGGESTED")).toBeNull();
    expect(screen.queryByText("lane-a")).toBeNull();
    expect(screen.getByText("2 behind")).toBeTruthy();
  });

  it("renders nothing for suggestions when set to off", () => {
    const { container } = renderBanner({
      visibleRebaseSuggestions: [suggestion("a")],
      display: "off",
    });
    expect(container.textContent?.trim()).toBe("");
  });

  it("still surfaces auto-rebase failures when suggestions are off", () => {
    renderBanner({
      visibleRebaseSuggestions: [suggestion("a")],
      visibleAutoRebaseNeedsAttention: [attention("b")],
      display: "off",
    });

    // A failed auto-rebase is a broken state, not a suggestion — turning
    // suggestions off must not hide it. The "behind" count stays suppressed.
    expect(screen.getByText(/1 lane needs attention/)).toBeTruthy();
    expect(screen.queryByText(/behind/)).toBeNull();
  });

  it("collapses to one line when both banners would exceed the budget", () => {
    renderBanner({
      visibleRebaseSuggestions: [suggestion("a")],
      visibleAutoRebaseNeedsAttention: [attention("b")],
      display: "banner",
      bannerBudget: 1,
    });

    expect(screen.queryByText("REBASE SUGGESTED")).toBeNull();
    expect(screen.queryByText("AUTO-REBASE NEEDS ATTENTION")).toBeNull();
    expect(screen.getByText(/1 lane needs attention · 1 behind/)).toBeTruthy();
  });

  it("keeps both strips when the budget allows them", () => {
    renderBanner({
      visibleRebaseSuggestions: [suggestion("a")],
      visibleAutoRebaseNeedsAttention: [attention("b")],
      display: "banner",
      bannerBudget: 2,
    });

    expect(screen.getByText("REBASE SUGGESTED")).toBeTruthy();
    expect(screen.getByText("AUTO-REBASE NEEDS ATTENTION")).toBeTruthy();
  });

  it("keeps the error visible in the collapsed form too", () => {
    renderBanner({
      visibleRebaseSuggestions: [suggestion("a")],
      display: "badge",
      rebaseSuggestionError: "Could not load rebase suggestions.",
    });
    expect(screen.getByText("Could not load rebase suggestions.")).toBeTruthy();
  });
});
