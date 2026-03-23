// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "lane",
    laneType: "worktree",
    baseRef: "origin/main",
    branchRef: "feature/lane",
    worktreePath: "/tmp/lane-1",
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    createdAt: "2026-03-23T12:00:00.000Z",
    ...overrides,
  };
}

const mockLanes: LaneSummary[] = [
  makeLane({
    id: "lane-primary",
    name: "main",
    laneType: "primary",
    branchRef: "main",
    worktreePath: "/tmp/main",
    childCount: 2,
  }),
  makeLane({
    id: "lane-1",
    name: "01 queue lane",
    branchRef: "feature/queue-1",
    worktreePath: "/tmp/lane-1",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    status: { dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    createdAt: "2026-03-23T12:01:00.000Z",
  }),
  makeLane({
    id: "lane-2",
    name: "02 queue lane",
    branchRef: "feature/queue-2",
    worktreePath: "/tmp/lane-2",
    parentLaneId: "lane-primary",
    stackDepth: 1,
    status: { dirty: false, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false },
    createdAt: "2026-03-23T12:02:00.000Z",
  }),
];

vi.mock("../../state/appStore", () => ({
  useAppStore: (selector: (state: { lanes: LaneSummary[] }) => unknown) => selector({ lanes: mockLanes }),
}));

import { CreatePrModal, reorderQueueLaneIds } from "./CreatePrModal";

describe("CreatePrModal queue workflow", () => {
  const originalAde = globalThis.window.ade;
  const createQueue = vi.fn();

  beforeEach(() => {
    createQueue.mockReset();
    createQueue.mockResolvedValue({
      groupId: "queue-group-1",
      prs: [],
      errors: [],
    });

    globalThis.window.ade = {
      prs: {
        createQueue,
      },
      git: {
        getSyncStatus: vi.fn().mockResolvedValue(null),
      },
    } as any;
  });

  afterEach(() => {
    globalThis.window.ade = originalAde;
    cleanup();
  });

  it("adds selected lanes to the queue order and removes them from the queue builder", async () => {
    const user = userEvent.setup();
    render(<CreatePrModal open onOpenChange={vi.fn()} />);

    await user.click(screen.getAllByRole("button", { name: /queue workflow/i })[0]!);
    await user.click(screen.getByRole("checkbox", { name: /01 queue lane/i }));
    await user.click(screen.getByRole("checkbox", { name: /02 queue lane/i }));

    expect(document.querySelectorAll("[data-queue-lane-id]").length).toBe(2);

    const laneOneRow = document.querySelector('[data-queue-lane-id="lane-1"]');
    expect(laneOneRow).toBeTruthy();
    await user.click(within(laneOneRow as HTMLElement).getByTitle("Remove lane from queue"));

    expect(document.querySelectorAll("[data-queue-lane-id]").length).toBe(1);
    expect(document.querySelector('[data-queue-lane-id="lane-1"]')).toBeNull();
    expect((screen.getByRole("checkbox", { name: /01 queue lane/i }) as HTMLInputElement).checked).toBe(false);
  });

  it("uses the dragged queue order when creating queue PRs", async () => {
    const user = userEvent.setup();
    render(<CreatePrModal open onOpenChange={vi.fn()} />);

    await user.click(screen.getAllByRole("button", { name: /queue workflow/i })[0]!);
    await user.click(screen.getByRole("checkbox", { name: /01 queue lane/i }));
    await user.click(screen.getByRole("checkbox", { name: /02 queue lane/i }));

    const laneOneRow = document.querySelector('[data-queue-lane-id="lane-1"]');
    const laneTwoRow = document.querySelector('[data-queue-lane-id="lane-2"]');
    expect(laneOneRow).toBeTruthy();
    expect(laneTwoRow).toBeTruthy();

    fireEvent.dragStart(laneTwoRow as HTMLElement);
    fireEvent.dragOver(laneOneRow as HTMLElement);
    fireEvent.drop(laneOneRow as HTMLElement);

    await user.click(screen.getByRole("button", { name: /next step/i }));
    await user.click(screen.getByRole("button", { name: /create pr/i }));

    await waitFor(() => expect(createQueue).toHaveBeenCalledTimes(1));
    expect(createQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        laneIds: ["lane-2", "lane-1"],
        targetBranch: "main",
      }),
    );
  });
});

describe("reorderQueueLaneIds", () => {
  it("returns the original array when dragged and target are the same", () => {
    const ids = ["a", "b", "c"];
    expect(reorderQueueLaneIds(ids, "b", "b")).toBe(ids);
  });

  it("returns the original array when dragged id is not found", () => {
    const ids = ["a", "b", "c"];
    expect(reorderQueueLaneIds(ids, "z", "b")).toBe(ids);
  });

  it("returns the original array when target id is not found", () => {
    const ids = ["a", "b", "c"];
    expect(reorderQueueLaneIds(ids, "a", "z")).toBe(ids);
  });

  it("moves an item forward (drag from above target)", () => {
    // Drag "a" (index 0) to where "c" (index 2) is
    expect(reorderQueueLaneIds(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("moves an item backward (drag from below target)", () => {
    // Drag "c" (index 2) to where "a" (index 0) is
    expect(reorderQueueLaneIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("handles adjacent swap: drag earlier to later", () => {
    // Dragging "a" onto adjacent "b" places "a" at b's position (insert-before semantic),
    // which after index adjustment is effectively a no-op for immediate neighbors.
    expect(reorderQueueLaneIds(["a", "b", "c"], "a", "b")).toEqual(["a", "b", "c"]);
  });

  it("handles adjacent swap: drag later to earlier", () => {
    expect(reorderQueueLaneIds(["a", "b", "c"], "b", "a")).toEqual(["b", "a", "c"]);
  });

  it("handles a longer list - drag from start to end", () => {
    expect(reorderQueueLaneIds(["a", "b", "c", "d", "e"], "a", "e")).toEqual(["b", "c", "d", "a", "e"]);
  });

  it("handles a longer list - drag from end to start", () => {
    expect(reorderQueueLaneIds(["a", "b", "c", "d", "e"], "e", "a")).toEqual(["e", "a", "b", "c", "d"]);
  });

  it("handles a longer list - drag from middle to middle", () => {
    expect(reorderQueueLaneIds(["a", "b", "c", "d", "e"], "b", "d")).toEqual(["a", "c", "b", "d", "e"]);
  });
});
