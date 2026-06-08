/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneDeleteRisk, LaneSummary } from "../../../shared/types";
import {
  ManageLaneDialog,
  EMPTY_LANE_DELETE_SELECTION,
  type LaneDeleteSelection,
} from "./ManageLaneDialog";

afterEach(cleanup);

const deleteRisk: LaneDeleteRisk = {
  laneId: "lane-1",
  branchRef: "feature/manage-tabs",
  dirty: false,
  hasUnpushedCommits: false,
  unpushedCommitCount: 0,
  remoteBranchExists: true,
  runningProcessCount: 0,
  activeChatCount: 0,
  activePtyCount: 0,
  activeWatcherCount: 0,
  envInitialized: true,
};

function makeLane(overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id: "lane-1",
    name: "Manage tabs",
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: "feature/manage-tabs",
    worktreePath: "/tmp/ade/manage-tabs",
    attachedRootPath: null,
    parentLaneId: null,
    childCount: 0,
    stackDepth: 0,
    parentStatus: null,
    isEditProtected: false,
    status: { dirty: false, ahead: 0, behind: 0, remoteBehind: -1, rebaseInProgress: false },
    color: null,
    icon: null,
    tags: [],
    folder: null,
    createdAt: "2026-05-27T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
}

type DialogProps = Parameters<typeof ManageLaneDialog>[0];

function makeProps(overrides: Partial<DialogProps> = {}): DialogProps {
  const lane = makeLane();
  return {
    open: true,
    onOpenChange: vi.fn(),
    managedLane: lane,
    managedLanes: undefined,
    allLanes: [lane],
    deleteSelection: EMPTY_LANE_DELETE_SELECTION,
    setDeleteSelection: vi.fn(),
    deleteForce: true,
    setDeleteForce: vi.fn(),
    chatSessionCount: 0,
    laneActionBusy: false,
    laneActionStatus: null,
    laneActionError: null,
    laneActionKind: null,
    onAdoptAttached: vi.fn(),
    onArchive: vi.fn(),
    onDelete: vi.fn(),
    onAppearanceChanged: vi.fn(),
    onStackReorganized: vi.fn(),
    ...overrides,
  };
}

function selectedTabLabel(): string | null {
  return screen
    .getAllByRole("tab")
    .find((tab) => tab.getAttribute("aria-selected") === "true")
    ?.textContent ?? null;
}

describe("ManageLaneDialog tabs", () => {
  const originalAde = (globalThis.window as any).ade;

  beforeEach(() => {
    (globalThis.window as any).ade = {
      lanes: {
        getDeleteRisk: vi.fn().mockResolvedValue(deleteRisk),
        onDeleteEvent: vi.fn(() => vi.fn()),
        updateAppearance: vi.fn().mockResolvedValue(undefined),
        reparent: vi.fn().mockResolvedValue(undefined),
      },
    };
  });

  afterEach(() => {
    (globalThis.window as any).ade = originalAde;
    vi.clearAllMocks();
  });

  it("opens on the delete tab by default for a single lane", () => {
    render(<ManageLaneDialog {...makeProps()} />);

    expect(selectedTabLabel()).toBe("Delete");
  });

  it("opens on the delete tab for batch lane management", () => {
    const firstLane = makeLane({ id: "lane-1", name: "First lane" });
    const secondLane = makeLane({ id: "lane-2", name: "Second lane" });

    render(
      <ManageLaneDialog
        {...makeProps({
          managedLane: null,
          managedLanes: [firstLane, secondLane],
          allLanes: [firstLane, secondLane],
        })}
      />,
    );

    expect(selectedTabLabel()).toBe("Delete");
  });

  it("does not reset the selected tab when the lane object refreshes", () => {
    const lane = makeLane();
    const { rerender } = render(
      <ManageLaneDialog {...makeProps({ managedLane: lane, allLanes: [lane] })} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    expect(selectedTabLabel()).toBe("Archive");

    const refreshedLane = { ...lane, color: "#5eead4" };
    rerender(
      <ManageLaneDialog {...makeProps({ managedLane: refreshedLane, allLanes: [refreshedLane] })} />,
    );

    expect(selectedTabLabel()).toBe("Archive");
  });

  it("shows active chat sessions in the delete preflight", async () => {
    render(<ManageLaneDialog {...makeProps({ chatSessionCount: 1 })} />);

    await waitFor(() => {
      expect(screen.getByText("1 chat session")).toBeTruthy();
    });
  });

  it("disables the delete button when nothing is selected", async () => {
    render(<ManageLaneDialog {...makeProps({ deleteSelection: EMPTY_LANE_DELETE_SELECTION })} />);

    const deleteButton = await screen.findByRole("button", { name: /delete lane/i });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables delete once a target is selected and fires onDelete", async () => {
    const onDelete = vi.fn();
    const selection: LaneDeleteSelection = { worktree: true, localBranch: false, remoteBranch: false };
    render(<ManageLaneDialog {...makeProps({ deleteSelection: selection, onDelete })} />);

    const deleteButton = await screen.findByRole("button", { name: /delete lane/i });
    expect((deleteButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
