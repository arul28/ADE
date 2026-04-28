/* @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneRebaseBanner } from "./LaneRebaseBanner";

vi.mock("../ui/SmartTooltip", () => ({
  SmartTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("LaneRebaseBanner", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows rebase suggestion errors even when no rebase lists are visible", () => {
    render(
      <LaneRebaseBanner
        visibleRebaseSuggestions={[]}
        visibleAutoRebaseNeedsAttention={[]}
        lanesById={new Map()}
        rebaseSuggestionError="Could not load rebase suggestions."
        onViewRebaseDetails={vi.fn()}
        onDismissRebase={vi.fn()}
        onDismissAutoRebase={vi.fn()}
      />,
    );

    expect(screen.getByText("Could not load rebase suggestions.")).toBeTruthy();
  });
});
