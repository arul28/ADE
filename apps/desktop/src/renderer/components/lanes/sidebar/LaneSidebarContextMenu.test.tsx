/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import { LaneSidebarBulkContextMenu } from "./LaneSidebarBulkContextMenu";
import { LaneSidebarContextMenu } from "./LaneSidebarContextMenu";

vi.mock("../../../state/appStore", async () => {
  const actual = await vi.importActual<typeof import("../../../state/appStore")>("../../../state/appStore");
  return {
    ...actual,
    useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ projectBinding: { kind: "local" } }),
  };
});

function makeLane(id: string): LaneSummary {
  return {
    id,
    name: `Lane ${id}`,
    description: null,
    laneType: "worktree",
    baseRef: "main",
    branchRef: `refs/heads/${id}`,
    worktreePath: `/tmp/${id}`,
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
    createdAt: "2026-09-01T00:00:00.000Z",
    archivedAt: null,
  };
}

const lanes = ["lane-1", "lane-2", "lane-3"].map(makeLane);
const lanesById = new Map(lanes.map((lane) => [lane.id, lane]));

function renderSingleLaneMenu() {
  const props = {
    menu: { laneId: "lane-1", x: 10, y: 10 },
    lanesById,
    onClose: vi.fn(),
    onManage: vi.fn(),
    selectLane: vi.fn(),
    onAppearanceChanged: vi.fn(),
    onStartChatInLane: vi.fn(),
  };
  render(<LaneSidebarContextMenu {...props} />);
  return props;
}

function renderBulkMenu(actionableLaneIds = ["lane-1", "lane-2"]) {
  const props = {
    point: { x: 10, y: 10 },
    laneIds: ["lane-1", "lane-2", "lane-3"],
    actionableLaneIds,
    lanesById,
    onClose: vi.fn(),
    onManage: vi.fn(),
    onBulkAction: vi.fn(),
    onClearSelection: vi.fn(),
  };
  render(<LaneSidebarBulkContextMenu {...props} />);
  return props;
}

beforeEach(() => {
  (window as unknown as { ade: unknown }).ade = {
    app: { writeClipboardText: vi.fn().mockResolvedValue(undefined) },
    prs: { getForLane: vi.fn().mockResolvedValue(null) },
    github: { getRemoteStatus: vi.fn().mockResolvedValue({ repo: null }) },
    lanes: { updateAppearance: vi.fn().mockResolvedValue(undefined) },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("LaneSidebarContextMenu single-lane actions", () => {
  it("acts on the right-clicked lane", () => {
    const props = renderSingleLaneMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Manage Lane" }));

    expect(props.onManage).toHaveBeenCalledWith("lane-1");
    expect(props.onClose).toHaveBeenCalled();
  });
});

describe("LaneSidebarBulkContextMenu", () => {
  it("offers manage, rebase, archive and delete for the actionable lanes", () => {
    const props = renderBulkMenu();

    expect(screen.getByText("3 lanes selected")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage 2 lanes…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Rebase 2" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Archive 2…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Delete 2…" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy lane names" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Copy branches" })).toBeTruthy();

    fireEvent.click(screen.getByRole("menuitem", { name: "Manage 2 lanes…" }));

    // Only the actionable lanes are handed to the dialogs, and the menu closes.
    expect(props.onManage).toHaveBeenCalledWith(["lane-1", "lane-2"]);
    expect(props.onClose).toHaveBeenCalled();
  });

  it("routes archive and rebase through the bulk action handler", () => {
    const props = renderBulkMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Archive 2…" }));
    expect(props.onBulkAction).toHaveBeenCalledWith("archive", ["lane-1", "lane-2"]);

    fireEvent.click(screen.getByRole("menuitem", { name: "Rebase 2" }));
    expect(props.onBulkAction).toHaveBeenCalledWith("rebase", ["lane-1", "lane-2"]);
  });

  it("keeps copy and clear available when no lane is actionable", () => {
    const props = renderBulkMenu([]);

    expect(screen.queryByRole("menuitem", { name: /Manage/ })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /Rebase|Archive|Delete/ })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear selection" }));
    expect(props.onClearSelection).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalled();
  });
});
