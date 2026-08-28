import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginSocketSource } from "./contributionBridge";
import type { PluginContributionRow } from "./contributionBridge";

/**
 * The wiring between a plugin's answer and the place it opens.
 *
 * `pluginNavigateTarget.test.ts` pins the RULE; this pins that the dispatcher
 * reads the live facts off the same caches the UI draws from, and that each of
 * the three outcomes reaches the right host seam — the Work rail reveal, the
 * ordinary navigation target, or a toast that says why neither happened.
 */

const stores = {
  sources: [] as PluginSocketSource[],
  rows: [] as PluginContributionRow[],
};
const registry = { plugins: [] as unknown[], loaded: true };

const navigateToAppTarget = vi.fn();
const revealPluginWorkRailPane = vi.fn();
const showToast = vi.fn();

vi.mock("./contributionStores", async () => {
  const actual = await vi.importActual<typeof import("./contributionStores")>("./contributionStores");
  return {
    ...actual,
    sourcesStore: { getSnapshot: () => ({ status: "ready", sources: stores.sources }) },
    rowsStoreFor: () => ({ getSnapshot: () => ({ status: "ready", rows: stores.rows }) }),
  };
});

vi.mock("../../../state/appStore", () => ({
  rootAppStoreApi: {
    getState: () => ({ installedPlugins: registry.plugins, pluginsLoaded: registry.loaded }),
  },
}));

vi.mock("../../../lib/openExternal", () => ({
  navigateToAppTarget,
  revealPluginWorkRailPane,
}));

vi.mock("../../app/toast/toastStore", () => ({ showToast }));

const { applyPluginActionNavigation } = await import("./pluginActionDispatch");

const MANIFEST = {
  name: "hn",
  panels: [{ id: "stories" }],
  sockets: [
    { socket: "work-rail-pane", surface: "work", id: "stories", label: "HN", panelId: "stories" },
  ],
};

function source(manifest: unknown = MANIFEST): PluginSocketSource {
  return {
    pluginId: "hn",
    displayName: "Hacker News",
    enabled: true,
    accent: null,
    icon: null,
    disabledContributions: [],
    manifest,
  };
}

function installedPlugin(overrides: Record<string, unknown> = {}) {
  return {
    pluginId: "hn",
    displayName: "Hacker News",
    version: "1.0.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [{ id: "stories", title: "Hacker News", kind: "tab", panelId: "stories" }],
    theme: null,
    ...overrides,
  };
}

afterEach(() => {
  stores.sources = [];
  stores.rows = [];
  registry.plugins = [];
  registry.loaded = true;
  navigateToAppTarget.mockReset();
  revealPluginWorkRailPane.mockReset();
  showToast.mockReset();
});

describe("a chat-header press that navigates", () => {
  it("reveals the plugin's Work pane and never leaves the chat", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(resolution.kind).toBe("tools-pane");
    expect(revealPluginWorkRailPane).toHaveBeenCalledWith({
      pluginId: "hn",
      panelId: "stories",
      slotId: "plugin:hn:stories",
    });
    expect(navigateToAppTarget).not.toHaveBeenCalled();
    expect(showToast).not.toHaveBeenCalled();
  });

  it("takes the tab route when the plugin declares no Work pane", () => {
    stores.sources = [source({ name: "hn", panels: [{ id: "stories" }], sockets: [] })];
    registry.plugins = [installedPlugin()];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalledWith({
      kind: "plugin",
      pluginId: "hn",
      panelId: "stories",
      context: null,
    });
  });
});

describe("a navigation that cannot mount", () => {
  it("says so instead of doing nothing, naming the panel", () => {
    stores.sources = [source()];
    registry.plugins = [installedPlugin()];

    const resolution = applyPluginActionNavigation(
      { panelId: "nosuchpanel" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(resolution.kind).toBe("unreachable");
    expect(revealPluginWorkRailPane).not.toHaveBeenCalled();
    expect(navigateToAppTarget).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledTimes(1);
    const toast = showToast.mock.calls[0]?.[0] as { title: string; message: string; tone: string };
    expect(toast.tone).toBe("error");
    expect(toast.title).toContain("Hacker News");
    expect(toast.message).toContain("nosuchpanel");
  });

  it("says so when the plugin was uninstalled between the press and the answer", () => {
    registry.plugins = [];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(navigateToAppTarget).not.toHaveBeenCalled();
  });

  it("stays silent and routes normally before the registry has resolved", () => {
    // What a chat card pressed during startup looks like: nothing is installed
    // yet as far as the store is concerned. Refusing here would be a lie.
    registry.loaded = false;
    registry.plugins = [];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalled();
  });

  it("stays silent and routes normally when no manifest has been read yet", () => {
    // The empty-store case: every surface is unrevealed, so nothing can be
    // judged. Refusing here would break navigation on a cold press.
    registry.plugins = [installedPlugin()];

    applyPluginActionNavigation(
      { panelId: "stories" },
      { pluginId: "hn", context: null, socket: "chat-header-action" },
    );

    expect(showToast).not.toHaveBeenCalled();
    expect(navigateToAppTarget).toHaveBeenCalled();
  });
});
