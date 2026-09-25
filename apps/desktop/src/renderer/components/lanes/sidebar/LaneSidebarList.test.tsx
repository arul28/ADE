/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../../shared/types";
import { LaneSidebarList, type LaneSidebarListProps } from "./LaneSidebarList";
import { buildLaneSidebarLayout, laneStateGroupSectionId, type LaneStateGroupId } from "./laneSidebarModel";

function makeLane(id: string, overrides: Partial<LaneSummary> = {}): LaneSummary {
  return {
    id,
    name: id,
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
    ...overrides,
  };
}

const lanes = [
  makeLane("primary", { laneType: "primary", name: "Primary" }),
  makeLane("merged-a", { name: "Merged A" }),
  makeLane("merged-b", { name: "Merged B" }),
  makeLane("waiting", { name: "Waiting" }),
];
const states = new Map<string, LaneStateGroupId | "primary">([
  ["primary", "primary"],
  ["merged-a", "done"],
  ["merged-b", "done"],
  ["waiting", "needs-you"],
]);

function renderList(overrides: Partial<LaneSidebarListProps> = {}) {
  const layout = buildLaneSidebarLayout({
    lanes,
    groupBy: "state",
    stateByLaneId: states,
    lanesById: new Map(lanes.map((lane) => [lane.id, lane] as const)),
  });
  const props: LaneSidebarListProps = {
    layout,
    onGroupByChange: vi.fn(),
    collapsedGroupIds: new Set(),
    onToggleGroupCollapsed: vi.fn(),
    onGroupBulkAction: vi.fn(),
    colorIndexByLaneId: new Map(),
    needsYouReasonByLaneId: new Map(),
    selectedLaneId: null,
    multiSelectedLaneIds: new Set(),
    filter: "",
    onFilterChange: vi.fn(),
    canCreateLane: true,
    onCreateLane: vi.fn(),
    loading: false,
    totalLaneCount: lanes.length,
    laneRuntimeById: new Map(),
    laneSnapshotByLaneId: new Map(),
    agentsByLaneId: new Map(),
    lanePrTagsByLaneId: new Map(),
    deleteProgressByLaneId: {},
    creatingLaneIds: new Set(),
    pendingCreatingIssues: [],
    pulsingLaneId: null,
    onSelectRow: vi.fn(),
    onStepSelection: vi.fn(),
    isNextKey: () => false,
    isPrevKey: () => false,
    onContextMenu: vi.fn(),
    onOpenPr: vi.fn(),
    onOpenAgent: vi.fn(),
    onClearMultiSelection: vi.fn(),
    ...overrides,
  };
  render(<LaneSidebarList {...props} />);
  return props;
}

afterEach(() => cleanup());

describe("LaneSidebarList by State", () => {
  it("pins Primary above the groups and shows each group with its count", () => {
    renderList();
    const rows = screen.getAllByTestId("lane-sidebar-row").map((row) => row.getAttribute("data-lane-id"));
    expect(rows).toEqual(["primary", "waiting", "merged-a", "merged-b"]);
    const headers = screen.getAllByTestId("lane-sidebar-group-header");
    expect(headers.map((header) => header.getAttribute("data-group-id"))).toEqual(["needs-you", "done"]);
    expect(within(headers[1]!).getByRole("button", { name: "Done (2)" })).toBeTruthy();
  });

  it("offers Archive all from the Done header and hands over the lanes", () => {
    const props = renderList();
    const done = screen.getAllByTestId("lane-sidebar-group-header")[1]!;
    // Groups without bulk actions have no menu button.
    expect(within(screen.getAllByTestId("lane-sidebar-group-header")[0]!).queryByTestId("lane-sidebar-group-menu-button")).toBeNull();
    fireEvent.click(within(done).getByTestId("lane-sidebar-group-menu-button"));
    fireEvent.click(within(screen.getByTestId("lane-sidebar-group-menu")).getByText("Archive all 2"));
    expect(props.onGroupBulkAction).toHaveBeenCalledWith("archive", ["merged-a", "merged-b"]);
    expect(screen.queryByTestId("lane-sidebar-group-menu")).toBeNull();
  });

  it("hides a collapsed group's rows and toggles it from the header", () => {
    const props = renderList({ collapsedGroupIds: new Set([laneStateGroupSectionId("done")]) });
    expect(screen.queryByText("Merged A")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done (2)" }));
    expect(props.onToggleGroupCollapsed).toHaveBeenCalledWith("lanes-state:done");
  });

  it("switches the grouping", () => {
    const props = renderList();
    fireEvent.click(screen.getByTestId("lane-sidebar-group-by-stack"));
    expect(props.onGroupByChange).toHaveBeenCalledWith("stack");
  });
});
