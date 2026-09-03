/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  /**
   * Stubbed down to the props the page owns.
   *
   * `panel-host` stays exactly the panel id — the resolution tests below assert
   * it verbatim — so everything the back-stack tests need rides on siblings:
   * the button that stands in for a `{navigate}` verb, the Back the page hands
   * down, and markers for the two values that only travel between these two
   * files (the context the address carries, and the snapshot a pop returns).
   */
  PluginPanelHost: ({
    panelId,
    renderContext,
    onNavigate,
    onBack,
    backLabel,
    restoreState,
  }: {
    panelId: string;
    renderContext: Record<string, unknown> | null;
    onNavigate?: (
      navigation: { panelId: string; context?: Record<string, unknown> },
      snapshot: unknown,
    ) => void;
    onBack?: (() => void) | null;
    backLabel?: string | null;
    restoreState?: { panelState: { values: Record<string, string> } } | null;
  }) => (
    <>
      <div data-testid="panel-host">{panelId}</div>
      <div data-testid="render-context">{JSON.stringify(renderContext)}</div>
      <div data-testid="restore-state">
        {restoreState ? JSON.stringify(restoreState.panelState.values) : "none"}
      </div>
      <button
        type="button"
        onClick={() =>
          onNavigate?.(
            { panelId: "detail", context: { issue: "ISS-9" } },
            {
              panelState: { signature: "status", values: { status: "all" } },
              panelSelection: { signature: "", values: {}, anchor: {} },
              groupOverrides: {},
              listPages: {},
            },
          )}
      >
        navigate
      </button>
      {onBack ? (
        <button type="button" onClick={onBack}>
          {backLabel ? `Back to ${backLabel}` : "Back"}
        </button>
      ) : null}
    </>
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

/**
 * Getting back out of a panel a plugin navigated the reader into.
 *
 * `{navigate}` used to replace the panel with nothing behind it. The desktop
 * app has no browser Back, so a plugin that sent a reader from a list into a
 * detail screen stranded them there — the reduction iOS closed with
 * `PluginPanelStackEntry`, mirrored here with the same semantics: the address
 * comes back verbatim, context included, and the reader's own state comes back
 * with it.
 */
describe("plugin tab page back stack", () => {
  const LISTED: InstalledPlugin["tabs"] = [
    { id: "overview", title: "Overview", kind: "tab", panelId: "overview" },
    { id: "detail", title: "Detail", kind: "tab", panelId: "detail" },
  ];

  const panelText = () => screen.getByTestId("panel-host").textContent ?? "";
  const back = () => screen.queryByRole("button", { name: /^Back/ });

  function navigate() {
    fireEvent.click(screen.getByRole("button", { name: "navigate" }));
  }

  it("draws no Back control until a plugin has navigated", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    expect(back()).toBeNull();
  });

  it("pushes the panel it is leaving and offers the way back to it", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount("?panel=overview&ctx=%7B%22a%22%3A1%7D");

    navigate();

    expect(panelText()).toContain("detail");
    // The control names where it is going, which is the panel's declared title.
    expect(back()?.textContent).toBe("Back to Overview");
  });

  it("pops back to the address the reader left, context included", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount("?panel=overview&ctx=%7B%22a%22%3A1%7D");

    navigate();
    expect(screen.getByTestId("render-context").textContent).toBe('{"issue":"ISS-9"}');

    fireEvent.click(back() as HTMLElement);

    expect(panelText()).toContain("overview");
    // Not the plugin's front door and not a context-less reload: the same
    // address, which is what makes a pop a return.
    expect(screen.getByTestId("render-context").textContent).toBe('{"a":1}');
    // And the way back is gone, because there is nothing left to pop.
    expect(back()).toBeNull();
  });

  it("hands the popped entry's snapshot back to the panel host", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    navigate();
    expect(screen.getByTestId("restore-state").textContent).toBe("none");

    fireEvent.click(back() as HTMLElement);

    // What the reader had on the panel they are returning to — the host is what
    // adopts it, and this is the wire it arrives on.
    expect(screen.getByTestId("restore-state").textContent).toBe('{"status":"all"}');
  });

  it("pops on Escape", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    navigate();
    fireEvent.keyDown(window, { key: "Escape" });

    expect(panelText()).toContain("overview");
  });

  it("leaves Escape to a dialog drawn above the panel", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();
    navigate();

    // A plugin prompt card, a `navigate:popover` panel and a row's overflow menu
    // all close on Escape and all sit above the panel. Popping out from under
    // one of them would answer a key the reader meant for it.
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    try {
      fireEvent.keyDown(window, { key: "Escape" });
      expect(panelText()).toContain("detail");
    } finally {
      dialog.remove();
    }
  });

  it("pops on Ctrl+[ where the platform is not a Mac", () => {
    // Windows and Linux parity is the whole point of resolving the modifier
    // through the renderer's own binding parser rather than testing the
    // platform here: `Mod` is Ctrl everywhere Cmd is not offered.
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    navigate();
    fireEvent.keyDown(window, { key: "[", ctrlKey: true });

    expect(panelText()).toContain("overview");
  });

  it("pops on Cmd+[ on a Mac", () => {
    const platform = Object.getOwnPropertyDescriptor(window.navigator, "platform");
    Object.defineProperty(window.navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
    try {
      registry.plugins = [installed({ tabs: LISTED })];
      mount();

      navigate();
      fireEvent.keyDown(window, { key: "[", metaKey: true });

      expect(panelText()).toContain("overview");
    } finally {
      if (platform) Object.defineProperty(window.navigator, "platform", platform);
    }
  });

  it("claims neither key at depth zero", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    const escape = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    window.dispatchEvent(escape);

    // Nothing to pop, so nothing is consumed — the key still belongs to whatever
    // else in the app wants it.
    expect(escape.defaultPrevented).toBe(false);
    expect(panelText()).toContain("overview");
  });

  it("keeps the stack bounded when a plugin navigates in a loop", () => {
    registry.plugins = [installed({ tabs: LISTED })];
    mount();

    for (let index = 0; index < 12; index += 1) navigate();
    // Eight, the depth iOS keeps. The oldest entries are dropped rather than the
    // newest refused, so the reader always keeps the screens they just walked.
    for (let index = 0; index < 8; index += 1) {
      expect(back()).not.toBeNull();
      fireEvent.click(back() as HTMLElement);
    }
    expect(back()).toBeNull();
  });
});
