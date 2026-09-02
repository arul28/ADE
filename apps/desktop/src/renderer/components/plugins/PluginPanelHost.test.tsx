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
