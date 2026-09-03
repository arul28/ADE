/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { rootAppStoreApi } from "../../../state/appStore";
import { PluginWebviewPopoverHost } from "./PluginWebviewPopoverHost";
import {
  getPluginWebviewPopover,
  openPluginWebviewPopover,
  resetPluginWebviewPopover,
} from "./pluginWebviewPopoverStore";
import { closePluginWebviewGuest, resetPluginWebviewGuests } from "./pluginWebviewGuestRegistry";

/**
 * The anchored page host, and the one thing it must never do.
 *
 * A client that cannot draw a plugin's page draws the surface's `panelId` — the
 * vocabulary panel the manifest already promised every client would render.
 * It does NOT draw a card telling the reader to open a different application,
 * which is what the tab page did before the page tier and what this pins
 * against for the anchored placements.
 */

vi.mock("../../../lib/pluginRuntimeBridge", () => ({
  pluginWebviewRelayBridge: () => null,
  openPluginLogs: () => Promise.resolve([]),
  restartPlugin: () => Promise.resolve(),
}));

// Hoisted, because `vi.mock` factories run before the module body: a plain
// `const` here is still in its temporal dead zone when `appStore` imports pull
// the mocked module in.
const { webClientMode } = vi.hoisted(() => ({ webClientMode: { web: false } }));
vi.mock("../../../lib/webClientMode", () => ({ isWebClientMode: () => webClientMode.web }));

vi.mock("../PluginPanelHost", () => ({
  PluginPanelHost: ({ pluginId, panelId }: { pluginId: string; panelId: string }) => (
    <div data-testid="panel-fallback">{`${pluginId}:${panelId}`}</div>
  ),
}));

function installPlugin(popover?: { width: number; height: number }) {
  rootAppStoreApi.setState({
    installedPlugins: [
      {
        pluginId: "acme",
        displayName: "Acme",
        version: "1.0.0",
        enabled: true,
        icon: "puzzle",
        accent: "#fff",
        status: "running",
        tabs: [
          {
            id: "issues",
            title: "Issues",
            kind: "webview",
            panelId: "issues-panel",
            entryHtml: "dist/index.html",
            ...(popover ? { popover } : {}),
          },
        ],
        theme: null,
      },
    ],
  } as never);
}

beforeEach(() => {
  resetPluginWebviewPopover();
  resetPluginWebviewGuests();
  webClientMode.web = false;
  installPlugin();
});

afterEach(() => {
  cleanup();
});

const request = {
  pluginId: "acme",
  surfaceId: "issues",
  kind: "popover" as const,
  subject: null,
  anchor: { x: 100, y: 40, width: 40, height: 24 },
};

describe("PluginWebviewPopoverHost", () => {
  it("draws the plugin's own page when the client can host a guest", () => {
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    expect(view.container.querySelectorAll("webview")).toHaveLength(1);
    expect(view.queryByTestId("panel-fallback")).toBeNull();
  });

  it("draws exactly one card however many opens arrive", () => {
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
      openPluginWebviewPopover({ ...request, surfaceId: "issues", pluginId: "other" });
      openPluginWebviewPopover(request);
    });
    expect(view.container.querySelectorAll("[role='dialog']")).toHaveLength(1);
    expect(view.container.querySelectorAll("webview")).toHaveLength(1);
  });

  it("closes on Escape", () => {
    render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(getPluginWebviewPopover()).toBeNull();
  });

  it("closes on a click outside and not on a click inside", () => {
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    const card = view.container.querySelector("[role='dialog']") as HTMLElement;
    act(() => {
      fireEvent.mouseDown(card);
    });
    expect(getPluginWebviewPopover()).not.toBeNull();
    act(() => {
      fireEvent.mouseDown(card.parentElement as HTMLElement);
    });
    expect(getPluginWebviewPopover()).toBeNull();
  });

  it("closes when the page itself asks through surface.close", () => {
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    const guest = view.container.querySelector("webview") as HTMLElement;
    Object.assign(guest, { getWebContentsId: () => 11 });
    act(() => {
      guest.dispatchEvent(new Event("dom-ready"));
    });
    act(() => {
      expect(closePluginWebviewGuest("guest-11")).toBe("closed");
    });
    expect(getPluginWebviewPopover()).toBeNull();
  });

  it("sizes the card from the manifest surface", () => {
    installPlugin({ width: 340, height: 280 });
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    const card = view.container.querySelector("[role='dialog']") as HTMLElement;
    expect(card.style.width).toBe("340px");
    expect(card.style.height).toBe("280px");
  });

  it("falls back to the vocabulary panel, never an open-elsewhere card", () => {
    webClientMode.web = true;
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    expect(view.container.querySelectorAll("webview")).toHaveLength(0);
    expect(view.getByTestId("panel-fallback").textContent).toBe("acme:issues-panel");
    expect(view.container.textContent).not.toMatch(/desktop/i);
  });

  it("closes itself when the plugin it belongs to is switched off", () => {
    const view = render(<PluginWebviewPopoverHost />);
    act(() => {
      openPluginWebviewPopover(request);
    });
    act(() => {
      rootAppStoreApi.setState({
        installedPlugins: rootAppStoreApi.getState().installedPlugins
          .map((plugin) => ({ ...plugin, enabled: false })),
      } as never);
    });
    expect(getPluginWebviewPopover()).toBeNull();
    expect(view.container.querySelectorAll("[role='dialog']")).toHaveLength(0);
  });
});
