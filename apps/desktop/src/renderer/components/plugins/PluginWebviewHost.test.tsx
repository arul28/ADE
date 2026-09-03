/* @vitest-environment jsdom */

import React from "react";
import { render, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  decodePluginWebviewContext,
  PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM,
  PLUGIN_WEBVIEW_MAX_HEIGHT_PX,
} from "../../../shared/plugins/webviewBridge";
import {
  PLUGIN_WEBVIEW_RESIZE_CHANNEL,
  PluginWebviewHost,
  supportsPluginWebviews,
} from "./PluginWebviewHost";
import { getPluginWebviewGuest, resetPluginWebviewGuests } from "./sockets/pluginWebviewGuestRegistry";
import {
  applyPluginWebviewReload,
  resetPluginWebviewReloads,
} from "./sockets/pluginWebviewReloadStore";

/**
 * The three rules a page host has to keep, and none of them are visual.
 *
 * A guest is a whole renderer process, so the questions worth pinning are when
 * one is created, when it is destroyed, and what the host tells it about itself.
 * JSDOM has no `<webview>`, which is exactly right for these: the element is a
 * plain unknown element with the attributes the host set, and the attributes
 * are the contract.
 */

const setSurfaceState = vi.fn();

vi.mock("../../lib/pluginRuntimeBridge", () => ({
  pluginWebviewRelayBridge: () => ({
    onUiRequest: () => () => undefined,
    respondUi: () => undefined,
    publishTheme: () => undefined,
    setSurfaceState: (state: unknown) => setSurfaceState(state),
    onReload: () => () => undefined,
  }),
}));

const { client } = vi.hoisted(() => ({ client: { web: false, webPages: true } }));
vi.mock("../../lib/webClientMode", () => ({ isWebClientMode: () => client.web }));
vi.mock("../../webclient/plugins/pageServiceWorkerClient", () => ({
  supportsWebPluginPages: () => client.web && client.webPages,
}));
vi.mock("../../webclient/plugins/WebPluginPageHost", () => ({
  WebPluginPageHost: ({ pluginId, context }: { pluginId: string; context: unknown }) => (
    <div data-testid="web-page-host" data-plugin={pluginId}>{JSON.stringify(context)}</div>
  ),
}));

/** Every guest currently in the document, whatever host put it there. */
function guests(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll("webview"));
}

/**
 * Bring a guest to `dom-ready` with a `webContents` id, the way Electron does.
 *
 * The id is what the registry and the relay key on, and JSDOM never supplies
 * one, so the test does — which is also what makes "the guest registered" a
 * thing this file can assert at all.
 */
function readyGuest(guest: HTMLElement, webContentsId: number): void {
  Object.assign(guest, { getWebContentsId: () => webContentsId });
  act(() => {
    guest.dispatchEvent(new Event("dom-ready"));
  });
}

beforeEach(() => {
  resetPluginWebviewGuests();
  resetPluginWebviewReloads();
  setSurfaceState.mockClear();
  client.web = false;
  client.webPages = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the injected context", () => {
  it("carries the surface id and the placement into __adeCtx", () => {
    const view = render(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active
        placement="composer-picker"
        surfaceId="issues"
        context={{ subject: { kind: "surface", surface: "work" }, pointer: { issue: "ADE-1" } }}
      />,
    );
    const src = guests(view.container)[0]?.getAttribute("src") ?? "";
    const raw = new URL(src).searchParams.get(PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM);
    const decoded = decodePluginWebviewContext(raw);
    expect(decoded).toMatchObject({
      subject: { kind: "surface", surface: "work" },
      pointer: { issue: "ADE-1" },
    });
    // `surfaceId` and `placement` survive the encode/decode round trip the host
    // performs, which is how main learns where a relayed request came from.
    const parsed = JSON.parse(decodeURIComponent(raw ?? "")) as Record<string, unknown>;
    expect(parsed.surfaceId).toBe("issues");
    expect(parsed.placement).toBe("composer-picker");
  });

  it("defaults to the tab placement when no host names one", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    const src = guests(view.container)[0]?.getAttribute("src") ?? "";
    const raw = new URL(src).searchParams.get(PLUGIN_WEBVIEW_CONTEXT_QUERY_PARAM);
    expect(JSON.parse(decodeURIComponent(raw ?? "")).placement).toBe("tab");
  });
});

describe("destroy when hidden", () => {
  it("creates nothing until the surface is first shown", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active={false} />,
    );
    expect(guests(view.container)).toHaveLength(0);
  });

  it("removes the guest element when the surface is hidden", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    expect(guests(view.container)).toHaveLength(1);
    view.rerender(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active={false} />,
    );
    expect(guests(view.container)).toHaveLength(0);
  });

  it("keeps exactly one guest across a hide and a show", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    view.rerender(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active={false} />,
    );
    view.rerender(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    expect(guests(view.container)).toHaveLength(1);
  });

  it("holds a popover's guest for the grace window and no longer", () => {
    vi.useFakeTimers();
    const view = render(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active
        placement="popover"
        hideGraceMs={250}
      />,
    );
    view.rerender(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active={false}
        placement="popover"
        hideGraceMs={250}
      />,
    );
    expect(guests(view.container)).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(guests(view.container)).toHaveLength(0);
  });
});

describe("the guest registry", () => {
  it("registers on dom-ready and unregisters when the surface hides", () => {
    const close = vi.fn();
    const view = render(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active
        placement="popover"
        surfaceId="issues"
        onRequestClose={close}
      />,
    );
    readyGuest(guests(view.container)[0]!, 42);
    expect(getPluginWebviewGuest("guest-42")).toMatchObject({
      pluginId: "acme",
      surfaceId: "issues",
      placement: "popover",
    });
    expect(setSurfaceState).toHaveBeenCalledWith({ guestKey: "guest-42", attached: true });

    view.rerender(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active={false}
        placement="popover"
        surfaceId="issues"
        onRequestClose={close}
      />,
    );
    expect(getPluginWebviewGuest("guest-42")).toBeNull();
    // Detached BEFORE the element goes, so a request already in flight from a
    // page on its way out is refused rather than acted on.
    expect(setSurfaceState).toHaveBeenLastCalledWith({ guestKey: "guest-42", attached: false });
  });
});

describe("hot reload", () => {
  it("recreates the guest when the plugin's bytes move", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    const first = guests(view.container)[0];
    act(() => {
      applyPluginWebviewReload({ pluginId: "acme", version: "1.0.1", revision: 2 });
    });
    const second = guests(view.container)[0];
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
    expect(guests(view.container)).toHaveLength(1);
  });

  it("leaves another plugin's guest alone", () => {
    const view = render(
      <PluginWebviewHost pluginId="acme" entryHtml="dist/index.html" active />,
    );
    const first = guests(view.container)[0];
    act(() => {
      applyPluginWebviewReload({ pluginId: "other", version: "9.9.9", revision: 3 });
    });
    expect(guests(view.container)[0]).toBe(first);
  });
});

describe("ui.resize", () => {
  it("reports the page's height, capped, and only to a host that asked", () => {
    const onContentHeight = vi.fn();
    const view = render(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active
        placement="settings-section"
        surfaceId="settings"
        onContentHeight={onContentHeight}
      />,
    );
    const guest = guests(view.container)[0]!;
    const send = (height: unknown) => {
      const event = new Event("ipc-message") as Event & { channel?: string; args?: unknown[] };
      event.channel = PLUGIN_WEBVIEW_RESIZE_CHANNEL;
      event.args = [{ height }];
      act(() => {
        guest.dispatchEvent(event);
      });
    };
    send(320);
    expect(onContentHeight).toHaveBeenLastCalledWith(320);
    send(99_000);
    expect(onContentHeight).toHaveBeenLastCalledWith(PLUGIN_WEBVIEW_MAX_HEIGHT_PX);
    // Null is not zero: a height that is not a finite positive number is
    // dropped, so the section keeps the last good one rather than collapsing.
    send(-1);
    send(0);
    send(Number.NaN);
    expect(onContentHeight).toHaveBeenCalledTimes(2);
  });
});

describe("the hosted web client", () => {
  it("draws the web page host, never an Electron guest", () => {
    client.web = true;
    const view = render(
      <PluginWebviewHost
        pluginId="acme"
        entryHtml="dist/index.html"
        active
        placement="popover"
        surfaceId="issues"
      />,
    );
    expect(view.container.querySelectorAll("webview")).toHaveLength(0);
    const host = view.getByTestId("web-page-host");
    expect(host.getAttribute("data-plugin")).toBe("acme");
    // The envelope is handed over whole, so a page in the browser reads the
    // same `surfaceId` and `placement` a desktop guest reads off `__adeCtx`.
    expect(JSON.parse(host.textContent ?? "{}")).toMatchObject({
      subject: null,
      surfaceId: "issues",
      placement: "popover",
    });
  });

  it("reports support from the web host rather than assuming there is none", () => {
    client.web = true;
    expect(supportsPluginWebviews()).toBe(true);
    client.webPages = false;
    expect(supportsPluginWebviews()).toBe(false);
    client.web = false;
    expect(supportsPluginWebviews()).toBe(true);
  });
});
