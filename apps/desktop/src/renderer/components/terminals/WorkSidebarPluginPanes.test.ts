import { describe, expect, it } from "vitest";

import { allowWorkRailPluginPane, buildWorkSidebarTabItems, isAvailableWorkSidebarTab, remapWorkRailTabAfterPolarity } from "./WorkSidebar";
import { pluginPanelSlotId } from "../plugins/sockets/panelSlotId";
import type { PluginPanelSlot } from "../plugins/sockets";
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

describe("allowWorkRailPluginPane", () => {
  it("hides Control and Simulator contributions on a remote project", () => {
    expect(allowWorkRailPluginPane({ pluginId: "ade-app-control" }, { isRemoteProject: true, supportsIosSimulator: true })).toBe(false);
    expect(allowWorkRailPluginPane({ pluginId: "ade-ios-sim" }, { isRemoteProject: true, supportsIosSimulator: true })).toBe(false);
    expect(allowWorkRailPluginPane({ pluginId: "ade-history" }, { isRemoteProject: true, supportsIosSimulator: true })).toBe(true);
  });

  it("still requires a Mac for the Simulator contribution", () => {
    expect(allowWorkRailPluginPane({ pluginId: "ade-ios-sim" }, { isRemoteProject: false, supportsIosSimulator: false })).toBe(false);
    expect(allowWorkRailPluginPane({ pluginId: "ade-ios-sim" }, { isRemoteProject: false, supportsIosSimulator: true })).toBe(true);
    expect(allowWorkRailPluginPane({ pluginId: "ade-app-control" }, { isRemoteProject: false, supportsIosSimulator: false })).toBe(true);
  });
});

describe("remapWorkRailTabAfterPolarity", () => {
  const simPane = { id: pluginPanelSlotId("ade-ios-sim", "main"), pluginId: "ade-ios-sim" };
  const controlPane = { id: pluginPanelSlotId("ade-app-control", "main"), pluginId: "ade-app-control" };

  it("moves a compiled Control/Sim tab onto the plugin pane once the owner hides it", () => {
    const visible = (id: string) => id !== "ios";
    expect(remapWorkRailTabAfterPolarity("ios", {
      pluginPanes: [simPane, controlPane],
      builtinSurfaceVisible: visible,
    })).toBe(simPane.id);
    expect(remapWorkRailTabAfterPolarity("app-control", {
      pluginPanes: [simPane, controlPane],
      builtinSurfaceVisible: visible,
    })).toBe("app-control");
  });

  it("waits on the compiled id when the contribution has not landed yet", () => {
    expect(remapWorkRailTabAfterPolarity("ios", {
      pluginPanes: [],
      builtinSurfaceVisible: () => false,
    })).toBe("ios");
  });

  it("moves a Control/Sim plugin pane back onto the compiled tab once the owner is gone", () => {
    expect(remapWorkRailTabAfterPolarity(simPane.id as WorkSidebarTab, {
      pluginPanes: [],
      builtinSurfaceVisible: () => true,
    })).toBe("ios");
    expect(remapWorkRailTabAfterPolarity(controlPane.id as WorkSidebarTab, {
      pluginPanes: [],
      builtinSurfaceVisible: () => true,
    })).toBe("app-control");
  });

  it("leaves an ordinary plugin pane alone", () => {
    const other = pluginPanelSlotId("ade-log-viewer", "viewer");
    expect(remapWorkRailTabAfterPolarity(other as WorkSidebarTab, {
      pluginPanes: [],
      builtinSurfaceVisible: () => true,
    })).toBe(other);
  });
});

describe("buildWorkSidebarTabItems", () => {
  function slot(pluginId: string, panelId: string, label: string): PluginPanelSlot {
    return {
      id: pluginPanelSlotId(pluginId, panelId),
      key: `${pluginId}:${panelId}`,
      pluginId,
      panelId,
      label,
      icon: (() => null) as PluginPanelSlot["icon"],
      displayName: label,
    };
  }

  it("seats Control and Simulator plugin panes in the compiled slots, not after Browser", () => {
    const sim = slot("ade-ios-sim", "main", "iOS Sim");
    const control = slot("ade-app-control", "main", "Electron Control");
    const other = slot("ade-log-viewer", "viewer", "Logs");
    const items = buildWorkSidebarTabItems([other, control, sim], {
      isRemoteProject: false,
      supportsIosSimulator: true,
      builtinSurfaceVisible: () => false,
      pluginPaneIds: new Set([sim.id, control.id, other.id]),
    });
    expect(items.map((item) => item.label)).toEqual([
      "Terminal",
      "Git",
      "Files",
      "iOS Sim",
      "Electron Control",
      "Browser",
      "Logs",
    ]);
    expect(items[3]?.id).toBe(sim.id);
    expect(items[4]?.id).toBe(control.id);
  });
});
