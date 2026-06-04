/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneDeleteRisk, LaneSummary } from "../../../shared/types";
import { ManageLaneDialog } from "./ManageLaneDialog";

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
    deleteMode: "worktree",
    setDeleteMode: vi.fn(),
    deleteRemoteName: "origin",
    setDeleteRemoteName: vi.fn(),
    deleteForce: false,
    setDeleteForce: vi.fn(),
    deleteConfirmText: "delete Manage tabs",
    setDeleteConfirmText: vi.fn(),
    deletePhrase: "delete Manage tabs",
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

  it("opens on the first non-destructive tab for a single lane", () => {
    render(<ManageLaneDialog {...makeProps()} />);

    expect(selectedTabLabel()).toBe("Appearance");
  });

  it("opens on archive for batch lane management", () => {
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

    expect(selectedTabLabel()).toBe("Archive");
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
    (window as any).ade.lanes.getDeleteRisk.mockResolvedValueOnce({
      ...deleteRisk,
      activeChatCount: 1,
    });

    render(<ManageLaneDialog {...makeProps()} />);

    fireEvent.click(screen.getByRole("tab", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.getByText("1 chat session")).toBeTruthy();
    });
  });

  it("allows a clean worktree-only delete without hidden confirmation text", async () => {
    const onDelete = vi.fn();
    render(
      <ManageLaneDialog
        {...makeProps({
          deleteConfirmText: "",
          onDelete,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Delete" }));

    const deleteButton = await screen.findByRole("button", { name: /delete lane/i });
    await waitFor(() => {
      expect((deleteButton as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(deleteButton);

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("requires typed confirmation for a dirty lane delete", async () => {
    (window as any).ade.lanes.getDeleteRisk.mockResolvedValueOnce({
      ...deleteRisk,
      dirty: true,
    });
    const onDelete = vi.fn();
    const { rerender } = render(
      <ManageLaneDialog
        {...makeProps({
          deleteConfirmText: "",
          onDelete,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Delete" }));

    const deleteButton = await screen.findByRole("button", { name: /delete lane/i });
    await waitFor(() => {
      expect((deleteButton as HTMLButtonElement).disabled).toBe(true);
    });

    rerender(
      <ManageLaneDialog
        {...makeProps({
          deleteConfirmText: "delete Manage tabs",
          onDelete,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Delete" }));
    await waitFor(() => {
      expect((screen.getByRole("button", { name: /delete lane/i }) as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("button", { name: /delete lane/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
