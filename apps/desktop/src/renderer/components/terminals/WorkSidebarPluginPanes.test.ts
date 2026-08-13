import { describe, expect, it } from "vitest";

import { isAvailableWorkSidebarTab } from "./WorkSidebar";
import { pluginPanelSlotId } from "../plugins/sockets/panelSlotId";
import type { WorkSidebarTab } from "../../state/appStore";

/**
 * The `work-rail-pane` half of the rail's availability rule.
 *
 * This function is the one place three things agree: which entries the strip
 * draws, which tab the rail falls back to, and the effect that moves a user off
 * a pane that disappeared underneath them. A contributed pane has to obey all
 * three, and the failure mode if it does not is a rail with a selected tab that
 * has no matching entry — a blank pane with no way back.
 */

const PANE = pluginPanelSlotId("linter", "findings") as WorkSidebarTab;

const BASE = {
  isRemoteProject: false,
  supportsIosSimulator: true,
  builtinSurfaceVisible: () => true,
};

describe("plugin panes in the Work rail", () => {
  it("is available exactly while its contribution is", () => {
    expect(isAvailableWorkSidebarTab(PANE, { ...BASE, pluginPaneIds: new Set([PANE]) })).toBe(true);
    // The uninstall path: the contribution is gone, so the pane is gone, and
    // `effectiveTab` reads this and renders Git instead. The force-switch
    // effect deliberately does NOT write over a plugin id — contributions land
    // a tick after the rail mounts, so writing on the first render of every
    // launch would erase a selection the plugin was about to restore.
    expect(isAvailableWorkSidebarTab(PANE, { ...BASE, pluginPaneIds: new Set() })).toBe(false);
    // A host that never passes the set at all keeps the six built-ins and
    // offers no plugin pane, rather than trusting an unchecked id.
    expect(isAvailableWorkSidebarTab(PANE, BASE)).toBe(false);
  });

  it("survives a remote project, unlike the panes that need local processes", () => {
    const remote = { ...BASE, isRemoteProject: true, pluginPaneIds: new Set([PANE]) };
    // The remote gate describes host capabilities the built-ins need — a
    // simulator, an Electron app, a browser view. A plugin panel is a
    // vocabulary schema read from the local plugin host, which a remote
    // checkout does not change.
    expect(isAvailableWorkSidebarTab(PANE, remote)).toBe(true);
    expect(isAvailableWorkSidebarTab("ios", remote)).toBe(false);
    expect(isAvailableWorkSidebarTab("browser", remote)).toBe(false);
    expect(isAvailableWorkSidebarTab("git", remote)).toBe(true);
  });

  it("does not disturb the six built-ins", () => {
    const withPane = { ...BASE, pluginPaneIds: new Set([PANE]) };
    for (const tab of ["terminal", "git", "files", "ios", "app-control", "browser"] as const) {
      expect(isAvailableWorkSidebarTab(tab, withPane)).toBe(true);
    }
    // And the plugin gate does not swallow a built-in whose own gate says no.
    expect(isAvailableWorkSidebarTab("ios", {
      ...withPane,
      builtinSurfaceVisible: (id) => id !== "ios",
    })).toBe(false);
  });
});
