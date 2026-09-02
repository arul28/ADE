/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import type { InstalledPlugin } from "../../lib/pluginRuntimeBridge";

/**
 * What a plugin's own tab draws on a client that is not the desktop app.
 *
 * The hosted web client mounts this exact page — same route, same component —
 * so the states below are the ones a browser reader actually meets, and the two
 * that matter are the two the page could get wrong silently. A `webview`
 * surface has no browser equivalent (its `ade-plugin://` protocol is registered
 * by the Electron main process), and a plugin installed on one machine is not
 * installed on the one this browser happens to be connected to.
 */

const registry = {
  plugins: [] as InstalledPlugin[],
  loaded: true,
  /** What the store remembers per plugin, which outlives the manifest that set it. */
  lastPanelByPlugin: {} as Record<string, string>,
};

let webviewsSupported = true;

vi.mock("../../state/appStore", () => ({
  useRootAppStore: (select: (state: unknown) => unknown) =>
    select({
      installedPlugins: registry.plugins,
      pluginsLoaded: registry.loaded,
      pluginViewState: { lastPanelByPlugin: registry.lastPanelByPlugin },
      setLastPluginPanel: () => {},
      refreshInstalledPlugins: async () => {},
    }),
}));

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  openPluginLogs: async () => {},
  restartPlugin: async () => {},
}));

vi.mock("./PluginPanelHost", () => ({
  PluginPanelHost: ({ panelId }: { panelId: string }) => (
    <div data-testid="panel-host">{panelId}</div>
  ),
  // Renders nothing in the app; stubbed as a marker so the webview branch can
  // be asserted to carry the viewed lifecycle the panel host would have owned.
  PluginSurfaceViewedLifecycle: ({ panelId }: { panelId: string }) => (
    <div data-testid="viewed-lifecycle">{panelId}</div>
  ),
}));

vi.mock("./PluginWebviewHost", () => ({
  PluginWebviewHost: () => <div data-testid="webview-host" />,
  supportsPluginWebviews: () => webviewsSupported,
}));

const { PluginTabPage } = await import("./PluginTabPage");

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    pluginId: "acme-notes",
    displayName: "Notes",
    version: "1.2.0",
    enabled: true,
    icon: null,
    accent: null,
    status: "running",
    tabs: [{ id: "main", title: "Overview", kind: "tab", panelId: "overview" }],
    theme: null,
    ...overrides,
  };
}

function mount(search = "?panel=overview") {
  return render(
    <MemoryRouter initialEntries={[`/plugin/acme-notes${search}`]}>
      <Routes>
        <Route path="/plugin/:pluginId" element={<PluginTabPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  registry.plugins = [];
  registry.loaded = true;
  registry.lastPanelByPlugin = {};
  webviewsSupported = true;
});

describe("plugin tab page", () => {
  it("hosts the guest where a guest can run", () => {
    registry.plugins = [installed({
      tabs: [{ id: "main", title: "Overview", kind: "webview", panelId: "overview", entryHtml: "ui/index.html" }],
    })];
    mount();

    expect(screen.getByTestId("webview-host")).toBeTruthy();
    // The page wins outright: the declared panel is the fallback, not a second
    // thing to draw beside a working guest.
    expect(screen.queryByTestId("panel-host")).toBeNull();
  });

  it("offers the desktop app for a webview surface a browser cannot host, and still draws the panel", () => {
    webviewsSupported = false;
    registry.plugins = [installed({
      tabs: [{ id: "main", title: "Overview", kind: "webview", panelId: "overview", entryHtml: "ui/index.html" }],
    })];
    mount("?panel=overview&ctx=%7B%22issue%22%3A%22ISS-14%22%7D");

    // The panel is what the manifest promised would be shown instead, so it
    // renders — dropping it would make the surface blank on every non-desktop
    // client.
    expect(screen.getByTestId("panel-host").textContent).toBe("overview");

    // …and the reader is told there is more, with the address of THIS panel,
    // context included, rather than the plugin's front page.
    const link = screen.getByRole("link", { name: "Open on desktop" }) as HTMLAnchorElement;
    expect(link.getAttribute("href"))
      .toBe("ade://plugin/acme-notes/overview?ctx=%7B%22issue%22%3A%22ISS-14%22%7D");
  });

  it("says nothing about the desktop app for an ordinary panel surface", () => {
    webviewsSupported = false;
    registry.plugins = [installed()];
    mount();

    expect(screen.getByTestId("panel-host")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open on desktop" })).toBeNull();
  });

  it("answers a route into a plugin this machine does not have", () => {
    // The state a shared web link lands in when the reader's browser is
    // connected to a different machine than the sender's. It must say so —
    // a blank page or a redirect to the Marketplace both read as a dead link.
    registry.plugins = [];
    mount();

    expect(screen.getByText("Not installed here")).toBeTruthy();
    expect(screen.queryByTestId("panel-host")).toBeNull();
  });

  it("waits rather than claiming a plugin is missing before the registry has loaded", () => {
    registry.plugins = [];
    registry.loaded = false;
    mount();

    expect(screen.queryByText("Not installed here")).toBeNull();
  });

  /**
   * The restored-route case, which is what made `/plugin` a storable root
   * questionable in the first place.
   *
   * A project tab remembers its last route (`app/projectRouteStorage.ts`) and
   * replays it on the next launch, unvalidated — by design, because the registry
   * has not resolved when the replay happens. So the route can name a plugin the
   * reader has since uninstalled or switched off, arriving with no `?panel=`
   * because that is how the rail's own click writes it.
   *
   * Both must state the case. A blank tab on launch is the failure this whole
   * round is about, and it is also what the compiled surfaces answer with
   * (`BuiltinSurfaceUnavailable`), so the two agree.
   */
  it("states the case when a restored route names a plugin that is gone", () => {
    registry.plugins = [];
    mount("");

    expect(screen.getByText("Not installed here")).toBeTruthy();
    expect(screen.queryByTestId("panel-host")).toBeNull();
  });

  it("states the case when a restored route names a plugin that is switched off", () => {
    registry.plugins = [installed({ enabled: false })];
    mount("");

    expect(screen.getByText("Turned off")).toBeTruthy();
    expect(screen.queryByTestId("panel-host")).toBeNull();
  });
});

/**
 * Which panel a rail click opens, when the store remembers one.
 *
 * The remembered id outlives the manifest that earned it, and the page used to
 * prefer it over anything the plugin currently declares. A plugin that publishes
 * only `dashboard` therefore opened at a remembered `main`, matched no surface,
 * and hosted a panel it had never published — a tab that looks like it does
 * nothing (docs/reports/ade-plugins-agent-diagnostic-2026-08-26.md §4).
 */
describe("plugin tab page panel resolution", () => {
  it("ignores a remembered panel the current manifest does not declare", () => {
    registry.lastPanelByPlugin = { "acme-notes": "main" };
    registry.plugins = [installed({
      tabs: [{ id: "dashboard", title: "Dashboard", kind: "webview", panelId: "dashboard", entryHtml: "web/index.html" }],
    })];
    mount("");

    // The plugin's own first surface wins, so the guest mounts instead of the
    // page hosting an unpublished `main`.
    expect(screen.getByTestId("webview-host")).toBeTruthy();
  });

  it("falls back to the first declared tab rather than to a literal main", () => {
    registry.plugins = [installed({
      tabs: [{ id: "dashboard", title: "Dashboard", kind: "tab", panelId: "dashboard" }],
    })];
    mount("");

    expect(screen.getByTestId("panel-host").textContent).toBe("dashboard");
  });

  it("still restores a remembered panel the manifest does declare", () => {
    registry.lastPanelByPlugin = { "acme-notes": "archive" };
    registry.plugins = [installed({
      tabs: [
        { id: "overview", title: "Overview", kind: "tab", panelId: "overview" },
        { id: "archive", title: "Archive", kind: "tab", panelId: "archive" },
      ],
    })];
    mount("");

    expect(screen.getByTestId("panel-host").textContent).toBe("archive");
  });

  it("lets an explicit ?panel= win over both the memory and the first tab", () => {
    registry.lastPanelByPlugin = { "acme-notes": "archive" };
    registry.plugins = [installed({
      tabs: [
        { id: "overview", title: "Overview", kind: "tab", panelId: "overview" },
        { id: "archive", title: "Archive", kind: "tab", panelId: "archive" },
      ],
    })];
    mount("?panel=overview");

    expect(screen.getByTestId("panel-host").textContent).toBe("overview");
  });
});
