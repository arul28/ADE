/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rootAppStoreApi } from "../../state/appStore";
import { resetBuiltinSurfacePlugins, seedBuiltinSurfacePlugins } from "../../../test/builtinSurfaces";
import { laneFixture, laneLinearIssueFixture } from "../../../test/laneFixture";
import { SUBMENU_OPEN_DELAY_MS } from "../ui/MenuSubmenu";
import type { PluginBuiltinSurfaceId } from "../../../shared/plugins/manifest";
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

const linkedLane = laneFixture({
  name: "Linked lane",
  linearIssue: laneLinearIssueFixture(),
});

/**
 * Every surface reads visible here except the ones a case names, so a test that
 * cares about Linear says only that. The builder takes the id rather than a
 * fixed answer because `buildLaneMenuGroups` asks by id, and a stub that
 * ignored the id would pass a builder that gated the wrong row.
 */
function gateHiding(hidden: readonly PluginBuiltinSurfaceId[]) {
  return (builtinId: PluginBuiltinSurfaceId) => !hidden.includes(builtinId);
}

function menuArgs(linearVisible: boolean): LaneMenuArgs {
  return {
    laneId: linkedLane.id,
    lane: linkedLane,
    lanesById: new Map([[linkedLane.id, linkedLane]]),
    visibleLaneIds: [linkedLane.id],
    isRemoteProject: false,
    surfaceVisible: gateHiding(linearVisible ? [] : ["linear"]),
    onClose: vi.fn(),
    onManage: vi.fn(),
    selectLane: vi.fn(),
    onRemoveFromSplit: vi.fn(),
    onCloseOtherSplits: vi.fn(),
    onSelectAll: vi.fn(),
    onBatchManage: vi.fn(),
  };
}

function copyLabels(linearVisible: boolean): string[] {
  const copy = buildLaneMenuGroups(menuArgs(linearVisible))
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
