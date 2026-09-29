/* @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
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

function renderMenu({
  menuLaneId = "lane-1",
  selectedLaneIds = [] as string[],
}: { menuLaneId?: string; selectedLaneIds?: string[] } = {}) {
  const lanes = ["lane-1", "lane-2", "lane-3"].map(makeLane);
  const props = {
    menu: { laneId: menuLaneId, x: 10, y: 10 },
    lanesById: new Map(lanes.map((lane) => [lane.id, lane])),
    selectedLaneIds,
    onClose: vi.fn(),
    onManage: vi.fn(),
    onBatchManage: vi.fn(),
    selectLane: vi.fn(),
    onAppearanceChanged: vi.fn(),
    onStartChatInLane: vi.fn(),
  };
  render(<LaneSidebarContextMenu {...props} />);
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

describe("LaneSidebarContextMenu batch actions", () => {
  it("offers the batch entry from a row outside the selection when a multi-selection exists", () => {
    // Shift-click selects lane-1 and lane-2; the user right-clicks lane-3.
    renderMenu({ menuLaneId: "lane-3", selectedLaneIds: ["lane-1", "lane-2"] });
    expect(screen.getByRole("menuitem", { name: "Manage 2 Open Lanes..." })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
  });

  it("keeps the batch entry when the menu opens on a selected row", () => {
    renderMenu({ menuLaneId: "lane-2", selectedLaneIds: ["lane-1", "lane-2"] });
    expect(screen.getByRole("menuitem", { name: "Manage 2 Open Lanes..." })).toBeTruthy();
  });

  it("shows no batch entry for a single selected lane", () => {
    renderMenu({ menuLaneId: "lane-1", selectedLaneIds: ["lane-1"] });
    expect(screen.queryByRole("menuitem", { name: /Open Lanes/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Manage Lane" })).toBeTruthy();
  });
});
