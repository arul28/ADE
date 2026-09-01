/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LaneSummary } from "../../../shared/types";
import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { SUBMENU_OPEN_DELAY_MS } from "../ui/MenuSubmenu";
import { buildLaneMenuGroups, type LaneMenuArgs } from "./laneContextMenuItems";
import { LaneContextMenu } from "./LaneContextMenu";

/**
 * "Copy Linear Issue Link" in the lane menu, against the plugin that owns Linear.
 *
 * Two layers, because the gate spans two files. `buildLaneMenuGroups` is pure
 * and takes the answer as an argument, so its own case is the argument; the
 * lane divider's menu is the React caller that has to ask, so its case is the
 * rendered menu with the registry seeded. Testing only the builder would pass
 * on a caller that never threads the flag.
 *
 * The issue link itself stays on the lane either way. What the gate removes is
 * this way of reaching it, because the plugin offers the same row in its own
 * menus and two of them is how the two disagree.
 */

const COPY_LINEAR = "Copy Linear Issue Link";

const linkedLane = {
  id: "lane-1",
  name: "Linked lane",
  laneType: "worktree",
  baseRef: "main",
  branchRef: "refs/heads/ade-123",
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
  createdAt: "2026-07-10T10:00:00.000Z",
  linearIssue: {
    id: "issue-1",
    identifier: "ADE-123",
    title: "Copy the issue link",
    description: null,
    url: "https://linear.app/ade/issue/ADE-123/copy-the-issue-link",
    projectId: null,
    projectSlug: null,
    projectName: null,
    teamId: "team-1",
    teamKey: "ADE",
    teamName: "ADE",
    stateId: "state-1",
    stateName: "In Progress",
    stateType: "started",
    priority: 2,
    priorityLabel: "high",
    labels: [],
    assigneeId: null,
    assigneeName: null,
    creatorId: null,
    creatorName: null,
    dueDate: null,
    estimate: null,
    branchName: "ade-123",
    createdAt: "2026-07-10T10:00:00.000Z",
    updatedAt: "2026-07-10T10:00:00.000Z",
  },
} as unknown as LaneSummary;

function menuArgs(linearSurfaceVisible: boolean): LaneMenuArgs {
  return {
    laneId: linkedLane.id,
    lane: linkedLane,
    lanesById: new Map([[linkedLane.id, linkedLane]]),
    visibleLaneIds: [linkedLane.id],
    isRemoteProject: false,
    linearSurfaceVisible,
    onClose: vi.fn(),
    onManage: vi.fn(),
    selectLane: vi.fn(),
    onRemoveFromSplit: vi.fn(),
    onCloseOtherSplits: vi.fn(),
    onSelectAll: vi.fn(),
    onBatchManage: vi.fn(),
  };
}

function copyLabels(linearSurfaceVisible: boolean): string[] {
  const copy = buildLaneMenuGroups(menuArgs(linearSurfaceVisible))
    .find((group) => group.key === "copy");
  return (copy?.entries ?? []).map((entry) => ("label" in entry ? entry.label : entry.key));
}

describe("buildLaneMenuGroups and the Linear surface", () => {
  it("offers the copy row when ADE still draws Linear", () => {
    expect(copyLabels(true)).toContain(COPY_LINEAR);
  });

  it("drops only that row when the plugin owns Linear", () => {
    const withLinear = copyLabels(true);
    const withoutLinear = copyLabels(false);
    expect(withoutLinear).toEqual(withLinear.filter((label) => label !== COPY_LINEAR));
    // The rest of the Copy group is untouched, so the group itself survives.
    expect(withoutLinear.length).toBeGreaterThan(0);
  });
});

/** Open the Copy submenu, which mounts its rows on hover intent. */
async function openCopySubmenu(): Promise<void> {
  const trigger = await screen.findByRole("menuitem", { name: /^Copy/ });
  fireEvent.pointerOver(trigger);
  await act(async () => {
    vi.advanceTimersByTime(SUBMENU_OPEN_DELAY_MS + 20);
  });
}

function renderLaneMenu() {
  render(
    <LaneContextMenu
      laneContextMenu={{ laneId: linkedLane.id, x: 10, y: 10 }}
      lanesById={new Map([[linkedLane.id, linkedLane]])}
      visibleLaneIds={[linkedLane.id]}
      onClose={vi.fn()}
      onManage={vi.fn()}
      selectLane={vi.fn()}
      onRemoveFromSplit={vi.fn()}
      onCloseOtherSplits={vi.fn()}
      onSelectAll={vi.fn()}
      onBatchManage={vi.fn()}
    />,
  );
}

describe("the lane divider's menu asking about the Linear surface", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    resetBuiltinSurfacePlugins();
  });

  it("offers the row on a machine without the plugin", async () => {
    renderLaneMenu();
    await openCopySubmenu();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: COPY_LINEAR })).toBeTruthy());
  });

  it("offers the row while the plugin registry has not resolved", async () => {
    Object.defineProperty(window, "ade", {
      configurable: true,
      writable: true,
      value: { ...(window as never as { ade?: Record<string, unknown> }).ade, plugins: {} },
    });
    rootAppStoreApi.setState({ installedPlugins: [], pluginsLoaded: false });

    renderLaneMenu();
    await openCopySubmenu();
    await waitFor(() => expect(screen.getByRole("menuitem", { name: COPY_LINEAR })).toBeTruthy());
  });

  it("drops the row once ade-linear is installed", async () => {
    seedBuiltinSurfacePlugins(["linear"]);

    renderLaneMenu();
    await openCopySubmenu();
    // The other Copy rows prove the submenu opened, so an absent Linear row is
    // the gate rather than a submenu that never mounted.
    await waitFor(() => expect(screen.getByRole("menuitem", { name: /Copy ADE Lane Link/i })).toBeTruthy());
    expect(screen.queryByRole("menuitem", { name: COPY_LINEAR })).toBeNull();
  });
});
