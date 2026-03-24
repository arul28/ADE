// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutoRebaseLaneStatus, RebaseNeed } from "../../../../shared/types";
import { PrsProvider, usePrs } from "./PrsContext";

const originalAde = globalThis.window.ade;

function Harness() {
  const { refresh, rebaseNeeds, autoRebaseStatuses, loading } = usePrs();
  return (
    <div>
      <button type="button" onClick={() => void refresh()}>
        refresh
      </button>
      <div data-testid="loading">{loading ? "loading" : "idle"}</div>
      <div data-testid="needs-count">{rebaseNeeds.length}</div>
      <div data-testid="auto-count">{autoRebaseStatuses.length}</div>
    </div>
  );
}

describe("PrsContext refresh", () => {
  beforeEach(() => {
    const refreshedNeed: RebaseNeed = {
      laneId: "lane-1",
      laneName: "Lane 1",
      baseBranch: "main",
      behindBy: 1,
      conflictPredicted: false,
      conflictingFiles: [],
      prId: null,
      groupContext: null,
      dismissedAt: null,
      deferredUntil: null,
    };
    const refreshedAutoStatus: AutoRebaseLaneStatus = {
      laneId: "lane-1",
      parentLaneId: "lane-parent",
      parentHeadSha: "abc123",
      state: "autoRebased",
      updatedAt: "2026-03-24T12:00:00.000Z",
      conflictCount: 0,
      message: null,
    };

    globalThis.window.ade = {
      prs: {
        refresh: vi.fn().mockResolvedValue(undefined),
        listWithConflicts: vi.fn().mockResolvedValue([]),
        listQueueStates: vi.fn().mockResolvedValue([]),
        onEvent: vi.fn(() => () => {}),
      },
      lanes: {
        list: vi.fn().mockResolvedValue([]),
        listAutoRebaseStatuses: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValue([refreshedAutoStatus]),
        onAutoRebaseEvent: vi.fn(() => () => {}),
      },
      rebase: {
        scanNeeds: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([])
          .mockResolvedValue([refreshedNeed]),
        onEvent: vi.fn(() => () => {}),
      },
    } as any;
  });

  afterEach(() => {
    cleanup();
    globalThis.window.ade = originalAde;
  });

  it("refreshes rebase needs and auto-rebase statuses without waiting for events", async () => {
    const user = userEvent.setup();

    render(
      <PrsProvider>
        <Harness />
      </PrsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("loading").textContent).toBe("idle");
    });
    expect(screen.getByTestId("needs-count").textContent).toBe("0");
    expect(screen.getByTestId("auto-count").textContent).toBe("0");

    await user.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => {
      expect(screen.getByTestId("needs-count").textContent).toBe("1");
      expect(screen.getByTestId("auto-count").textContent).toBe("1");
    });
  });
});
