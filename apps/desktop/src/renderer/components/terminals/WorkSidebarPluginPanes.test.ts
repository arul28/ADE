import { describe, expect, it } from "vitest";

import {
  allowWorkRailPluginPane,
  buildWorkSidebarTabItems,
  hostEngineForPluginPane,
  isAvailableWorkSidebarTab,
  remapWorkRailTabAfterPolarity,
  shouldWaitForWorkRailPluginPane,
  workRailItemForPluginPane,
  workRailSlotForPluginPane,
} from "./WorkSidebar";
import { DEFAULT_PLUGIN_ICON } from "../plugins/pluginIcons";
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
      // The real resolved Phosphor component, not a cast: `pluginIcon` returns
      // this exact value for an unknown name, so the slot carries what the host
      // would actually hand `GlowMenu`.
      icon: DEFAULT_PLUGIN_ICON,
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

describe("the install/disable window, when both the compiled tab and the pane exist", () => {
  function slot(pluginId: string, panelId: string, label: string): PluginPanelSlot {
    return {
      id: pluginPanelSlotId(pluginId, panelId),
      key: `${pluginId}:${panelId}`,
      pluginId,
      panelId,
      label,
      icon: DEFAULT_PLUGIN_ICON,
      displayName: label,
    };
  }

  /**
   * The gate reads `installedPlugins` and the panes read the contribution
   * store, and the two resolve a tick apart on every install and every disable.
   * In that window the rail was handed a visible compiled tab AND its plugin's
   * pane, and drew both — under the same label, the same icon and the same
   * colour, because `workRailItemForPluginPane` deliberately borrows the
   * compiled ones. Two identical buttons is not a cosmetic defect: neither one
   * says which is which, and pressing them lands on different tab ids.
   */
  it("draws one button, not two, while the compiled tab is still visible", () => {
    const sim = slot("ade-ios-sim", "main", "iOS Sim");
    const control = slot("ade-app-control", "main", "Electron Control");
    const items = buildWorkSidebarTabItems([sim, control], {
      isRemoteProject: false,
      supportsIosSimulator: true,
      // The install half of the window: the compiled tabs have not been taken
      // away yet, and the contributions have already landed.
      builtinSurfaceVisible: () => true,
      pluginPaneIds: new Set([sim.id, control.id]),
    });
    expect(items.map((item) => item.label)).toEqual([
      "Terminal",
      "Git",
      "Files",
      "iOS Sim",
      "Electron Control",
      "Browser",
    ]);
    // And it is the compiled tab that holds the slot, since that is the id the
    // rail's own persisted selection names.
    expect(items[3]?.id).toBe("ios");
    expect(items[4]?.id).toBe("app-control");
  });

  it("draws the pane, not the compiled tab, once the gate catches up", () => {
    const sim = slot("ade-ios-sim", "main", "iOS Sim");
    const items = buildWorkSidebarTabItems([sim], {
      isRemoteProject: false,
      supportsIosSimulator: true,
      builtinSurfaceVisible: (id) => id !== "ios",
      pluginPaneIds: new Set([sim.id]),
    });
    expect(items.filter((item) => item.label === "iOS Sim")).toHaveLength(1);
    expect(items[3]?.id).toBe(sim.id);
  });

  it("still seats an ordinary plugin pane after Browser", () => {
    const other = slot("ade-log-viewer", "viewer", "Logs");
    const items = buildWorkSidebarTabItems([other], {
      isRemoteProject: false,
      supportsIosSimulator: true,
      builtinSurfaceVisible: () => true,
      pluginPaneIds: new Set([other.id]),
    });
    expect(items.at(-1)?.id).toBe(other.id);
  });
});

describe("a persisted compiled selection that cannot heal", () => {
  /**
   * The rail waits before writing Git so that installing the owner does not
   * erase a Control/Sim selection the plugin's pane is about to restore. On a
   * machine where that pane can never arrive, waiting is forever: the reader
   * sat on Git under a stored `ios` that nothing would overwrite.
   */
  it("stops waiting on a host that can never contribute the pane", () => {
    const hidden = { builtinSurfaceVisible: (id: string) => id !== "ios" && id !== "app-control" };
    // A Mac with a local checkout: the Simulator pane is coming, so wait.
    expect(shouldWaitForWorkRailPluginPane("ios", {
      ...hidden,
      isRemoteProject: false,
      supportsIosSimulator: true,
    })).toBe(true);
    // Not a Mac: `allowWorkRailPluginPane` refuses the Simulator pane here, so
    // the wait would never end.
    expect(shouldWaitForWorkRailPluginPane("ios", {
      ...hidden,
      isRemoteProject: false,
      supportsIosSimulator: false,
    })).toBe(false);
    // A remote checkout refuses both.
    expect(shouldWaitForWorkRailPluginPane("app-control", {
      ...hidden,
      isRemoteProject: true,
      supportsIosSimulator: true,
    })).toBe(false);
    expect(shouldWaitForWorkRailPluginPane("app-control", {
      ...hidden,
      isRemoteProject: false,
      supportsIosSimulator: true,
    })).toBe(true);
  });

  it("never waits on a tab that has no plugin behind it", () => {
    const base = { isRemoteProject: false, supportsIosSimulator: true, builtinSurfaceVisible: () => false };
    expect(shouldWaitForWorkRailPluginPane("git", base)).toBe(false);
    expect(shouldWaitForWorkRailPluginPane("browser", base)).toBe(false);
  });

  it("never waits while the compiled tab is still on screen", () => {
    expect(shouldWaitForWorkRailPluginPane("ios", {
      isRemoteProject: false,
      supportsIosSimulator: true,
      builtinSurfaceVisible: () => true,
    })).toBe(false);
  });
});

describe("the cold-launch flip", () => {
  const simPane = { id: pluginPanelSlotId("ade-ios-sim", "main"), pluginId: "ade-ios-sim" };

  /**
   * A superseded surface reads as VISIBLE before the registry resolves, which
   * is the right default for the compiled product. It is the wrong input for
   * this remap: on every cold launch a persisted plugin pane was rewritten to
   * the compiled id, persisted, and flipped back a tick later when the
   * contribution landed — a visible flash and two writes for one selection.
   */
  it("leaves a persisted plugin pane alone until the registry answers", () => {
    expect(remapWorkRailTabAfterPolarity(simPane.id as WorkSidebarTab, {
      pluginPanes: [],
      builtinSurfaceVisible: () => true,
      pluginsResolved: false,
    })).toBe(simPane.id);
  });

  it("falls back to the compiled tab once the registry says the plugin is gone", () => {
    expect(remapWorkRailTabAfterPolarity(simPane.id as WorkSidebarTab, {
      pluginPanes: [],
      builtinSurfaceVisible: () => true,
      pluginsResolved: true,
    })).toBe("ios");
  });

  it("still moves a compiled tab onto a landed pane before the registry answers", () => {
    // This direction needs no wait: `builtinSurfaceVisible` only answers false
    // for a superseded surface once the registry has resolved, so reaching here
    // already means the answer is known.
    expect(remapWorkRailTabAfterPolarity("ios", {
      pluginPanes: [simPane],
      builtinSurfaceVisible: (id) => id !== "ios",
      pluginsResolved: false,
    })).toBe(simPane.id);
  });
});

/**
 * The seat and the body are two questions.
 *
 * Conflating them is what kept both plugin pages off the screen: the rail
 * matched the plugin id, decided the pane WAS the compiled engine, and drew
 * ADE's old panel — so `ade-app-control` and `ade-ios-sim` shipped a whole page
 * each that no reader could reach. The seat still has to be the plugin-id
 * match, though, or a plugin gaining a page would move its button.
 */
describe("which pane draws a page and which draws the compiled panel", () => {
  function pane(pluginId: string, entryHtml?: string): PluginPanelSlot {
    return {
      id: pluginPanelSlotId(pluginId, "main"),
      key: `${pluginId}:main`,
      pluginId,
      panelId: "main",
      label: pluginId,
      icon: DEFAULT_PLUGIN_ICON,
      displayName: pluginId,
      ...(entryHtml ? { entryHtml } : {}),
    };
  }

  it("mounts the page when the pane resolved one", () => {
    expect(hostEngineForPluginPane(pane("ade-app-control", "dist/index.html"))).toBeNull();
    expect(hostEngineForPluginPane(pane("ade-ios-sim", "dist/index.html"))).toBeNull();
  });

  it("falls back to the compiled panel when the pane has no page", () => {
    // A client that cannot host a guest resolves no `entryHtml`, and the
    // webview surface's own declared fallback is the panel.
    expect(hostEngineForPluginPane(pane("ade-app-control"))).toBe("app-control");
    expect(hostEngineForPluginPane(pane("ade-ios-sim"))).toBe("ios");
  });

  it("keeps the seat, the label and the icon whichever way the pane draws", () => {
    const withPage = pane("ade-app-control", "dist/index.html");
    expect(workRailSlotForPluginPane(withPage)).toBe("app-control");
    expect(workRailItemForPluginPane(withPage).label).toBe("Electron Control");

    const items = buildWorkSidebarTabItems([withPage], {
      isRemoteProject: false,
      supportsIosSimulator: true,
      builtinSurfaceVisible: (id) => id !== "app-control",
      pluginPaneIds: new Set([withPage.id]),
    });
    expect(items[4]?.id).toBe(withPage.id);
    expect(items[4]?.label).toBe("Electron Control");
  });

  it("never claims an engine for a plugin that owns none", () => {
    expect(hostEngineForPluginPane(pane("ade-log-viewer", "dist/index.html"))).toBeNull();
    expect(hostEngineForPluginPane(pane("ade-log-viewer"))).toBeNull();
    expect(hostEngineForPluginPane(null)).toBeNull();
  });
});
