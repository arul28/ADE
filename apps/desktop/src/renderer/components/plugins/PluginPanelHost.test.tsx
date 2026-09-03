/* @vitest-environment jsdom */

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * What the host does with a plugin action's ANSWER.
 *
 * The panel's own rendering is `VocabularyRenderer.test.tsx`'s subject. These
 * cover the three response verbs the desktop and web clients used to drop on
 * the floor while iOS and the TUI honoured them, which is the failure mode a
 * type system cannot see: a plugin writes one line, and two of its four clients
 * do nothing with it.
 */

const bridge = {
  invoke: vi.fn(async (_args: unknown): Promise<unknown> => null),
  panel: null as unknown,
};

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  invokePluginAction: (pluginId: string, action: string, args?: Record<string, unknown>) =>
    bridge.invoke({ pluginId, action, args }),
  readPluginPanel: async () => bridge.panel,
  readPluginCollection: async () => [],
  subscribeToPluginChanges: () => () => {},
}));

const openExternalUrl = vi.fn();
vi.mock("../../lib/openExternal", () => ({
  openExternalUrl: (url: string) => openExternalUrl(url),
  navigateToAppTarget: () => {},
}));

vi.mock("./sockets/dialogTarget", () => ({ applyPluginDialogEdit: () => {} }));

const { PluginPanelHost, PluginSurfaceViewedLifecycle } = await import("./PluginPanelHost");

function panelWith(body: unknown[], schemaExtra: Record<string, unknown> = {}) {
  return {
    pluginId: "ade-cursor-cloud",
    panelId: "fleet",
    title: "Fleet",
    schema: { v: 1, fallback: { title: "Fleet", text: "Open ADE." }, body, ...schemaExtra },
    vocabVersion: 1,
    updatedAt: null,
  };
}

const RUN_BUTTON = [{ component: "button", label: "Run", onPress: { action: "pull" } }];

async function mountPanel(body: unknown[] = RUN_BUTTON) {
  bridge.panel = panelWith(body);
  const view = render(
    <PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />,
  );
  await screen.findByRole("button");
  return view;
}

beforeEach(() => {
  bridge.invoke.mockReset();
  bridge.invoke.mockResolvedValue(null);
  openExternalUrl.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("the action-result banner", () => {
  it("shows what the action said, on the client that used to discard it", async () => {
    bridge.invoke.mockResolvedValue({ message: "Created lane 'x' and merged y." });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Created lane 'x' and merged y.");
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("reads the message out of the sync envelope too, not only the bare return", async () => {
    // The web client reaches the host over sync, which wraps every handler
    // return as `{ok, message?, result}`. One line of plugin copy, one banner,
    // whichever transport carried it.
    bridge.invoke.mockResolvedValue({ ok: true, message: "Stopped bc-1.", result: null });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Stopped bc-1.");
  });

  it("says nothing when the action said nothing", async () => {
    bridge.invoke.mockResolvedValue({ result: null });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("dismisses itself rather than becoming part of the panel", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    bridge.invoke.mockResolvedValue({ message: "Pulled." });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Pulled.");

    await act(async () => {
      vi.advanceTimersByTime(6_001);
    });
    expect(screen.queryByText("Pulled.")).toBeNull();
  });

  it("never leaves the previous press's outcome standing over a new one", async () => {
    bridge.invoke.mockResolvedValue({ message: "First." });
    await mountPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("First.");

    bridge.invoke.mockResolvedValue({ message: "Second." });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Second.");
    expect(screen.queryByText("First.")).toBeNull();
  });
});

describe("the openUrl verb", () => {
  it("opens an https link the action asked for", async () => {
    bridge.invoke.mockResolvedValue({ openUrl: "https://cursor.com/agents" });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith("https://cursor.com/agents"));
  });

  it("refuses a scheme that would make a link a file read or a script", async () => {
    for (const refused of ["file:///etc/passwd", "javascript:alert(1)", "ade://lane/abc", "http://x.com"]) {
      bridge.invoke.mockResolvedValue({ openUrl: refused });
      const view = await mountPanel();
      fireEvent.click(screen.getByRole("button", { name: "Run" }));
      await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
      expect(openExternalUrl, `${refused} was opened`).not.toHaveBeenCalled();
      view.unmount();
      bridge.invoke.mockClear();
    }
  });
});

/**
 * The panel half of `{authSession}`.
 *
 * The socket half is `sockets/pluginActionDispatch.test.ts`. The verb was
 * dropped on BOTH paths, so both are pinned: a Connect button on a plugin's own
 * panel is the commonest place this is pressed, and the machine that owns the
 * plugin is the only one whose loopback listener the flow can redirect to.
 */
describe("the sign-in verb", () => {
  const PRESENTATION = {
    authSession: {
      sessionId: "linear",
      url: "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
      transport: "loopback" as const,
    },
  };

  it("opens the URL the host stamped", async () => {
    bridge.invoke.mockResolvedValue(PRESENTATION);
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(openExternalUrl).toHaveBeenCalledWith(
      "https://linear.app/oauth/authorize?client_id=abc&state=xyz",
    ));
  });

  it("still draws the action's own sentence inline", async () => {
    bridge.invoke.mockResolvedValue({ ...PRESENTATION, message: "Finish in your browser." });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await screen.findByText("Finish in your browser.");
    expect(openExternalUrl).toHaveBeenCalledTimes(1);
  });

  it("opens nothing for a session the host dropped", async () => {
    // The host REMOVES an `authSession` naming no live flow rather than passing
    // a half-built instruction, so this is what reaches the panel.
    bridge.invoke.mockResolvedValue({ authSession: { sessionId: "linear" } });
    await mountPanel();

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
    expect(openExternalUrl).not.toHaveBeenCalled();
  });
});

/**
 * The same pair, on the panel path.
 *
 * A `settings-section` panel's own gear is where this is actually pressed, so
 * the panel host has to apply the rule the socket dispatcher does: the client
 * that honours `{openSettings}` drops the `{navigate}` beside it.
 */
describe("openSettings beside a navigate", () => {
  it("does not also move the panel when the settings page opened", async () => {
    const navigations: unknown[] = [];
    bridge.panel = panelWith(RUN_BUTTON);
    bridge.invoke.mockResolvedValue({
      openSettings: "secrets.secrets",
      navigate: { panelId: "settings" },
    });
    render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="fleet"
        active
        onNavigate={(navigation) => navigations.push(navigation)}
      />,
    );
    await screen.findByRole("button");

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
    expect(navigations).toEqual([]);
  });

  it("takes the navigation when the settings request was refused", async () => {
    const navigations: unknown[] = [];
    bridge.panel = panelWith(RUN_BUTTON);
    bridge.invoke.mockResolvedValue({
      openSettings: "billing.plans",
      navigate: { panelId: "settings" },
    });
    render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="fleet"
        active
        onNavigate={(navigation) => navigations.push(navigation)}
      />,
    );
    await screen.findByRole("button");

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(navigations).toEqual([{ panelId: "settings" }]));
  });
});

describe("the panel refresh contract", () => {
  it("offers no refresh gesture for a panel that did not declare one", async () => {
    await mountPanel();
    expect(screen.queryByRole("button", { name: "Refresh this panel" })).toBeNull();
  });

  it("dispatches the declared action and refetches", async () => {
    // The gesture means "go and get new data", which is why the action runs
    // BEFORE the refetch. A panel backed by the plugin's own collections needs
    // none of this — the host republishes and the panel refetches on its own.
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet" });
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />);

    const refresh = await screen.findByRole("button", { name: "Refresh this panel" });
    fireEvent.click(refresh);

    await waitFor(() => expect(bridge.invoke).toHaveBeenCalledTimes(1));
    expect(bridge.invoke).toHaveBeenCalledWith(
      expect.objectContaining({ action: "refresh-fleet" }),
    );
  });

  it("still refetches when the refresh action failed, and says why", async () => {
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet" });
    bridge.invoke.mockRejectedValue(new Error("Cursor is unreachable."));
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />);

    const refresh = await screen.findByRole("button", { name: "Refresh this panel" });
    fireEvent.click(refresh);

    // The failure reaches the reader in the banner: a refresh gesture has no
    // control of its own to hang an inline error on.
    await screen.findByText("Cursor is unreachable.");
    // And the button comes back rather than stranding in its pending state.
    await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  });
});

/**
 * The viewed acknowledgement — the only thing that clears a tab badge.
 *
 * A published badge stays until the plugin unpublishes it, so `viewAction` is
 * the whole durable-clear story: the host says `{viewed: true}` while the panel
 * is on screen and `{viewed: false}` when it leaves. Two failures are equally
 * bad and neither shows on screen. Firing twice for one reveal breaks the
 * refcount the plugin keeps, so a second host going idle clears a badge the
 * reader is still looking at; never firing the hidden half leaves the plugin
 * believing the panel is open forever.
 */
describe("the viewed lifecycle", () => {
  const viewedCalls = () =>
    bridge.invoke.mock.calls
      .map(([args]) => args as { action: string; args?: { viewed?: boolean } })
      .filter((call) => call.action === "markRead")
      .map((call) => call.args?.viewed);

  async function mountViewed(active = true) {
    bridge.panel = panelWith(RUN_BUTTON, { viewAction: "markRead" });
    const view = render(
      <PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active={active} />,
    );
    if (active) await screen.findByRole("button");
    return view;
  }

  it("acknowledges once when the panel is visible", async () => {
    const view = await mountViewed();
    await waitFor(() => expect(viewedCalls()).toEqual([true]));

    // A re-render is not a second reveal. The effect keys on the plugin, the
    // panel and the visibility, so nothing about redrawing the same panel may
    // spend another acknowledgement.
    view.rerender(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />);
    view.rerender(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />);
    await waitFor(() => expect(viewedCalls()).toEqual([true]));
  });

  it("says the panel is hidden when it unmounts", async () => {
    const view = await mountViewed();
    await waitFor(() => expect(viewedCalls()).toEqual([true]));
    view.unmount();
    await waitFor(() => expect(viewedCalls()).toEqual([true, false]));
  });

  it("says the panel is hidden when it stops being active", async () => {
    const view = await mountViewed();
    await waitFor(() => expect(viewedCalls()).toEqual([true]));

    view.rerender(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active={false} />);
    await waitFor(() => expect(viewedCalls()).toEqual([true, false]));

    // Back on screen is a new reveal and does earn a second acknowledgement.
    view.rerender(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="fleet" active />);
    await waitFor(() => expect(viewedCalls()).toEqual([true, false, true]));
  });

  it("stays silent for a panel that declares no view action", async () => {
    await mountPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(bridge.invoke).toHaveBeenCalled());
    expect(viewedCalls()).toEqual([]);
  });

  /**
   * A rejected invoke must not reach the user.
   *
   * A plugin that declares `viewAction` and ships no handler answers
   * `unsupported_method`, and most plugins declare none at all — a toast for
   * either would be the host reporting its own bookkeeping as the reader's
   * problem.
   */
  it("swallows a failing acknowledgement instead of surfacing it", async () => {
    bridge.invoke.mockRejectedValue(new Error("unsupported_method"));
    await mountViewed();
    await waitFor(() => expect(viewedCalls()).toEqual([true]));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/**
 * The same lifecycle for a surface that draws no panel.
 *
 * A webview tab returns its guest before the panel host is ever reached, so
 * this component is what carries the acknowledgement there. Without it a plugin
 * whose only rail surface is a webview could publish a tab badge and never be
 * told it had been read.
 */
describe("the webview surface's viewed lifecycle", () => {
  const viewedCalls = () =>
    bridge.invoke.mock.calls
      .map(([args]) => args as { action: string; args?: { viewed?: boolean } })
      .filter((call) => call.action === "markRead")
      .map((call) => call.args?.viewed);

  it("reads the stamped action off the panel record and acknowledges once", async () => {
    bridge.panel = panelWith(RUN_BUTTON, { viewAction: "markRead" });
    const view = render(
      <PluginSurfaceViewedLifecycle pluginId="ade-cursor-cloud" panelId="fleet" active />,
    );
    await waitFor(() => expect(viewedCalls()).toEqual([true]));
    view.unmount();
    await waitFor(() => expect(viewedCalls()).toEqual([true, false]));
  });

  it("stays silent when the panel stamps no view action", async () => {
    bridge.panel = panelWith(RUN_BUTTON);
    render(<PluginSurfaceViewedLifecycle pluginId="ade-cursor-cloud" panelId="fleet" active />);
    await waitFor(() => expect(bridge.panel).toBeTruthy());
    expect(viewedCalls()).toEqual([]);
  });
});

/**
 * The first refresh, which nothing used to run.
 *
 * A manifest-declared panel is materialized as a placeholder — the seeded
 * "Loading…" card — and the thing that fills it is the panel's own
 * `refreshAction`. Nothing ran that until the reader found the Refresh control,
 * so Graph and Review opened on the loading card and stayed there. The host
 * stamps `seeded` while the row is still that shipped default and the plugin's
 * own `panels.update` clears it, so it is the one signal that says "nobody has
 * filled this yet".
 */
describe("the seeded panel's first refresh", () => {
  const refreshCalls = () =>
    bridge.invoke.mock.calls
      .map(([args]) => args as { action: string })
      .filter((call) => call.action === "refresh-fleet");

  it("runs the declared refresh once, for the reader rather than after them", async () => {
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet", seeded: true });
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="seeded-first" active />);

    await waitFor(() => expect(refreshCalls()).toHaveLength(1));

    // Silent: the host's own bookkeeping owns no spinner on the reader's
    // control and reports no success.
    const refresh = await screen.findByRole("button", { name: "Refresh this panel" });
    expect((refresh as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("invokes nothing for a seeded row that declares no refresh action", async () => {
    bridge.panel = panelWith(RUN_BUTTON, { seeded: true });
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="seeded-none" active />);

    await screen.findByRole("button", { name: "Run" });
    expect(bridge.invoke).not.toHaveBeenCalled();
  });

  it("invokes nothing once the plugin has published real content", async () => {
    // The same panel with the same refresh action, no longer seeded. Priming it
    // on every reveal would poll the plugin's API for a row that is already the
    // plugin's own.
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet" });
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="published" active />);

    await screen.findByRole("button", { name: "Refresh this panel" });
    expect(refreshCalls()).toHaveLength(0);
  });

  it("does not spend a second refresh when the same seeded row is mounted again", async () => {
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet", seeded: true });
    const first = render(
      <PluginPanelHost pluginId="ade-cursor-cloud" panelId="seeded-remount" active />,
    );
    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    first.unmount();

    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="seeded-remount" active />);
    await screen.findByRole("button", { name: "Refresh this panel" });
    expect(refreshCalls()).toHaveLength(1);
  });

  it("leaves the card and the reader's own control alone when the first refresh fails", async () => {
    bridge.invoke.mockRejectedValue(new Error("Cursor is unreachable."));
    bridge.panel = panelWith(RUN_BUTTON, { refreshAction: "refresh-fleet", seeded: true });
    render(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="seeded-failing" active />);

    await waitFor(() => expect(refreshCalls()).toHaveLength(1));
    // No banner for a press nobody made, and the panel still draws.
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Refresh this panel" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

/**
 * The half of the back stack that lives in the panel.
 *
 * The page owns the addresses; this owns what the reader had ON one — the
 * filters, the ticks, the folds and the pages. A Back that restored the address
 * alone would feel like a reload rather than a return, which is the reduction
 * iOS closed with `PluginPanelStackEntry`.
 */
describe("the panel's back-stack half", () => {
  const SEGMENTED = [
    {
      component: "segmented",
      stateKey: "status",
      label: "Status",
      options: [{ value: "open", label: "Open" }, { value: "all", label: "All" }],
    },
    { component: "button", label: "Open detail", onPress: { action: "open" } },
  ];

  it("hands the reader's own state to the navigation that leaves the panel", async () => {
    const onNavigate = vi.fn();
    bridge.invoke.mockResolvedValue({ navigate: { panelId: "detail" } });
    bridge.panel = panelWith(SEGMENTED);
    render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="fleet"
        active
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(await screen.findByRole("radio", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Open detail" }));

    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    const [navigation, snapshot] = onNavigate.mock.calls[0] as [
      { panelId: string },
      { panelState: { signature: string; values: Record<string, string> } },
    ];
    expect(navigation.panelId).toBe("detail");
    expect(snapshot.panelState.values).toEqual({ status: "all" });
    // The signature rides along, because that is what makes the restore stick.
    expect(snapshot.panelState.signature).not.toBe("");
  });

  it("adopts a popped snapshot instead of rebuilding the panel from its defaults", async () => {
    const onNavigate = vi.fn();
    bridge.invoke.mockResolvedValue({ navigate: { panelId: "detail" } });
    bridge.panel = panelWith(SEGMENTED);
    const view = render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="fleet"
        active
        onNavigate={onNavigate}
      />,
    );

    // Take a real snapshot the way a `{navigate}` does, so the signature under
    // test is the host's own rather than one the test invented.
    fireEvent.click(await screen.findByRole("radio", { name: "All" }));
    fireEvent.click(screen.getByRole("button", { name: "Open detail" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalled());
    const snapshot = onNavigate.mock.calls[0]?.[1] as unknown;

    // Walk away, which clears everything the reader had on the panel…
    view.rerender(<PluginPanelHost pluginId="ade-cursor-cloud" panelId="detail" active />);
    await waitFor(() =>
      expect(screen.queryByRole("radio", { name: "All" })?.getAttribute("aria-checked"))
        .not.toBe("true"));

    // …and come back with what a pop hands over.
    view.rerender(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="fleet"
        active
        restoreState={snapshot as never}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "All" }).getAttribute("aria-checked")).toBe("true"));
  });

  it("draws no Back control for a host that has no stack", async () => {
    await mountPanel();
    expect(screen.queryByRole("button", { name: /^Back/ })).toBeNull();
  });

  it("draws Back in the panel chrome when the host offers a pop", async () => {
    const onBack = vi.fn();
    bridge.panel = panelWith(RUN_BUTTON);
    render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="detail"
        active
        onBack={onBack}
        backLabel="Fleet"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back to Fleet" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("still offers the way out when the panel a plugin navigated to is missing", async () => {
    const onBack = vi.fn();
    bridge.panel = null;
    render(
      <PluginPanelHost
        pluginId="ade-cursor-cloud"
        panelId="gone"
        active
        onBack={onBack}
        backLabel="Fleet"
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back to Fleet" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
