/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneDeleteRisk, LaneReclaimRisk, LaneSummary } from "../../../shared/types";
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
  activeChatCount: 0,
  activePtyCount: 0,
  activeWatcherCount: 0,
  envInitialized: true,
};
const reclaimRisk: LaneReclaimRisk = {
  ...deleteRisk,
  laneName: "Manage tabs",
  worktreePath: "/tmp/ade/manage-tabs",
  worktreeBytes: 2 * 1024 ** 3,
  generatedBytes: 100 * 1024 ** 2,
  reclaimableBytes: 2 * 1024 ** 3 + 100 * 1024 ** 2,
  worktreeAvailable: true,
  blockedReasons: [],
  lastFailure: null,
  retryCount: 0,
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
        getReclaimRisk: vi.fn().mockResolvedValue(reclaimRisk),
        archiveAndReclaim: vi.fn().mockResolvedValue({
          laneId: "lane-1",
          reclaimedBytes: reclaimRisk.reclaimableBytes,
          worktreeRemoved: true,
          generatedDataRemoved: true,
          warnings: [],
        }),
        onDeleteEvent: vi.fn(() => vi.fn()),
        updateAppearance: vi.fn().mockResolvedValue(undefined),
        reparent: vi.fn().mockResolvedValue(undefined),
        rename: vi.fn().mockResolvedValue(undefined),
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

  it("explains Archive & Reclaim and requires the typed confirmation", async () => {
    render(<ManageLaneDialog {...makeProps()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));

    expect(await screen.findByText(/files stay on disk/i)).toBeTruthy();
    expect(screen.getByText(/restoring the lane recreates its worktree/i)).toBeTruthy();
    const reclaimButton = screen.getByRole("button", { name: /reclaim 2\.1 GB/i });
    expect((reclaimButton as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "RECLAIM" } });
    expect((reclaimButton as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps reclaim disabled until the risk preview is available", async () => {
    let resolveRisk!: (risk: LaneReclaimRisk) => void;
    (globalThis.window as any).ade.lanes.getReclaimRisk.mockReturnValue(
      new Promise<LaneReclaimRisk>((resolve) => {
        resolveRisk = resolve;
      }),
    );
    render(<ManageLaneDialog {...makeProps()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "RECLAIM" } });

    const measuring = screen.getByRole("button", { name: /measuring/i });
    expect((measuring as HTMLButtonElement).disabled).toBe(true);

    resolveRisk(reclaimRisk);
    expect(await screen.findByRole("button", { name: /reclaim 2\.1 GB/i })).toBeTruthy();
  });

  it("requires an explicit acknowledgement before discarding dirty changes", async () => {
    (globalThis.window as any).ade.lanes.getReclaimRisk.mockResolvedValue({
      ...reclaimRisk,
      dirty: true,
      blockedReasons: [{
        code: "dirty_worktree",
        disposition: "confirmation_required",
        message: "This lane has uncommitted changes.",
      }],
    });
    render(<ManageLaneDialog {...makeProps()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Archive" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "RECLAIM" } });

    const checkbox = await screen.findByRole("checkbox", { name: /discard uncommitted changes/i });
    const blockedButton = screen.getByRole("button", { name: /confirm discarded changes/i });
    expect((blockedButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(checkbox);
    const reclaimButton = screen.getByRole("button", { name: /reclaim 2\.1 GB/i });
    expect((reclaimButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(reclaimButton);

    await waitFor(() => {
      expect((globalThis.window as any).ade.lanes.archiveAndReclaim).toHaveBeenCalledWith({
        laneId: "lane-1",
        confirmation: "RECLAIM",
        forceDirty: true,
      });
    });
  });

  // Delete is real for every lane type now — an attached lane is deleted, not
  // "unlinked" — so the checklist must not promise the folder survives.
  it("describes deleting an attached lane's worktree the same as any other", async () => {
    const attached = makeLane({ laneType: "attached", attachedRootPath: "/elsewhere/checkout" });
    render(
      <ManageLaneDialog
        {...makeProps({
          managedLane: attached,
          allLanes: [attached],
          deleteSelection: { worktree: true, localBranch: false, remoteBranch: false },
        })}
      />,
    );

    await screen.findByRole("button", { name: /delete lane/i });
    expect(screen.getByText("Removes the working folder and ADE registration.")).toBeTruthy();
    expect(screen.queryByText(/unlink from ade/i)).toBeNull();
    expect(screen.queryByText(/keeps the folder/i)).toBeNull();
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

  it("renames a lane from the header pencil control", async () => {
    const onAppearanceChanged = vi.fn().mockResolvedValue(undefined);
    const lane = makeLane({ name: "Old lane name" });
    const otherLane = makeLane({ id: "lane-2", name: "Other lane" });
    render(
      <ManageLaneDialog
        {...makeProps({
          managedLane: lane,
          allLanes: [lane, otherLane],
          onAppearanceChanged,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename lane" }));
    const input = screen.getByRole("textbox", { name: "Lane name" });
    fireEvent.change(input, { target: { value: "Renamed lane" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect((globalThis.window as any).ade.lanes.rename).toHaveBeenCalledWith({
        laneId: "lane-1",
        name: "Renamed lane",
      });
      expect(onAppearanceChanged).toHaveBeenCalled();
    });
  });

  it("blocks rename when another lane already uses the name", async () => {
    const lane = makeLane({ name: "Old lane name" });
    const otherLane = makeLane({ id: "lane-2", name: "Taken name" });
    render(
      <ManageLaneDialog
        {...makeProps({
          managedLane: lane,
          allLanes: [lane, otherLane],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Rename lane" }));
    const input = screen.getByRole("textbox", { name: "Lane name" });
    fireEvent.change(input, { target: { value: "Taken name" } });

    expect(screen.getByText('A lane named "Taken name" already exists.')).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
