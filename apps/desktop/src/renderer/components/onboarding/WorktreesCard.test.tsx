/* @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/appStore";
import { WorktreesCard } from "./WorktreesCard";

describe("WorktreesCard", () => {
  const originalAde = window.ade;
  const originalRefreshLanes = useAppStore.getState().refreshLanes;
  let refreshLanes: typeof originalRefreshLanes;

  beforeEach(() => {
    refreshLanes = vi.fn(async () => undefined) as unknown as typeof originalRefreshLanes;
    useAppStore.setState({ refreshLanes });
    window.ade = ({
      ...(originalAde ?? {}),
      lanes: {
        ...((originalAde as typeof window.ade | undefined)?.lanes ?? {}),
        listUnregisteredWorktrees: vi.fn()
          .mockResolvedValueOnce([{ path: "/repo/worktree-a", branch: "feature/a" }])
          .mockResolvedValueOnce([]),
        attach: vi.fn(async () => ({})),
      },
    } as unknown) as typeof window.ade;
  });

  afterEach(() => {
    cleanup();
    window.ade = originalAde;
    useAppStore.setState({ refreshLanes: originalRefreshLanes });
    vi.restoreAllMocks();
  });

  it("refreshes the shared lane store after importing existing worktrees", async () => {
    render(<WorktreesCard />);

    await screen.findByText("feature/a");
    fireEvent.click(screen.getByRole("button", { name: "Add 1 as lane" }));

    await waitFor(() => {
      expect(window.ade.lanes.attach).toHaveBeenCalledWith({
        name: "feature/a",
        attachedPath: "/repo/worktree-a",
      });
      expect(refreshLanes).toHaveBeenCalledWith({ includeStatus: false });
      expect(window.ade.lanes.listUnregisteredWorktrees).toHaveBeenCalledTimes(2);
    });
  });
});
