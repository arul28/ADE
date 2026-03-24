// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary, PrWithConflicts } from "../../../../shared/types";

import { PrLaneCleanupBanner } from "./PrLaneCleanupBanner";

describe("PrLaneCleanupBanner", () => {
  beforeEach(() => {
    Object.assign(window, {
      ade: {
        lanes: {
          archive: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
        },
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  function renderBanner(
    prOverrides: Partial<PrWithConflicts> = {},
    laneOverrides: Partial<LaneSummary> = {},
  ) {
    const pr = {
      id: "pr-1",
      state: "merged",
      laneId: "lane-1",
      ...prOverrides,
    } as PrWithConflicts;
    const lane = {
      id: "lane-1",
      name: "feature/lane-1",
      branchRef: "refs/heads/feature/lane-1",
      laneType: "branch",
      status: { dirty: false },
      ...laneOverrides,
    } as LaneSummary;

    render(
      <PrLaneCleanupBanner
        pr={pr}
        lane={lane}
        onNavigate={vi.fn()}
      />,
    );
  }

  it("archives a merged lane inline without opening a modal", async () => {
    const user = userEvent.setup();
    renderBanner();

    await user.click(screen.getByRole("button", { name: /archive/i }));

    await waitFor(() => {
      expect(window.ade.lanes.archive).toHaveBeenCalledWith({ laneId: "lane-1" });
    });
    expect(screen.getByText("Lane archived successfully")).toBeTruthy();
  });
});
