/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { PluginPageBundle } from "../pageAssets";

const disposed = vi.fn();
const created = vi.fn();
const closedPopover = vi.fn();
const closedOverlay = vi.fn();
const promptStore = {
  token: 0,
  request: null as { onSubmit: (text: string) => void } | null,
  listeners: new Set<() => void>(),
};

/** Clear the standing question the way a dismissal does, then notify. */
function dismissPrompt(): void {
  promptStore.request = null;
  for (const listener of [...promptStore.listeners]) listener();
}
let bundle: PluginPageBundle;
let ensure: () => Promise<{ base: string }>;
let putUrls: string[];

vi.mock("../pageServiceWorkerClient", () => ({
  ensurePluginPageServiceWorker: () => ensure(),
  supportsWebPluginPages: () => true,
}));

vi.mock("../pageAssets", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../pageAssets")>();
  return {
    ...actual,
    loadPluginPageBundle: async () => ({ bundle, stats: { reused: 0, fetched: 1, skipped: 0 } }),
  };
});

vi.mock("../pageBridgeHost", () => ({
  createPluginPageHost: (options: unknown) => {
    created(options);
    return { publish: vi.fn(), booted: true, dispose: disposed };
  },
}));

// Leaf UI the host only forwards to. Stubbed so this test is about the guest's
// lifecycle rather than about the toast stack or the vocabulary renderer.
vi.mock("../../../components/plugins/VocabularyRenderer", () => ({
  PluginFallbackCard: ({ fallback }: { fallback: { title: string } }) => <div>{fallback.title}</div>,
}));
vi.mock("../../../components/shared/InlineDialogs", () => ({
  useConfirmDialog: () => ({ state: null, confirmAsync: async () => true, close: () => undefined }),
  ConfirmDialog: () => null,
}));
vi.mock("../../../components/app/toast/toastStore", () => ({ showToast: () => "id", dismissToast: () => undefined }));
vi.mock("../../../components/plugins/sockets/pluginPromptStore", () => ({
  openPluginPrompt: (request: { onSubmit: (text: string) => void }) => {
    promptStore.request = request;
    promptStore.token += 1;
    return promptStore.token;
  },
  getPluginPrompt: () => (promptStore.request ? { token: promptStore.token } : null),
  subscribePluginPrompt: (listener: () => void) => {
    promptStore.listeners.add(listener);
    return () => promptStore.listeners.delete(listener);
  },
}));
vi.mock("../../../components/plugins/sockets/composerTarget", () => ({ applyPluginComposerEdit: () => true }));
vi.mock("../../../components/plugins/sockets/pluginWebviewPopoverStore", () => ({
  closePluginWebviewPopover: () => closedPopover(),
}));
vi.mock("../../../components/plugins/sockets/pluginWebviewOverlayStore", () => ({
  closePluginWebviewOverlay: () => closedOverlay(),
}));
vi.mock("../../../components/plugins/pluginActionOpenSettings", () => ({ applyPluginActionOpenSettings: () => true }));
vi.mock("../../../lib/pluginRuntimeBridge", () => ({
  invokePluginAction: async () => null,
  openPluginLogs: async () => undefined,
  readPluginCollection: async () => [],
  readPluginConfig: async () => ({}),
  readPluginPanel: async () => null,
  writePluginConfig: async () => undefined,
}));
vi.mock("../../../state/appStore", () => ({
  rootAppStoreApi: { getState: () => ({ installedPlugins: [] }) },
  useRootAppStore: (selector: (state: { installedPlugins: unknown[] }) => unknown) =>
    selector({ installedPlugins: [] }),
}));

import { WebPluginPageHost, askPrompt, closeSurfaceFor } from "../WebPluginPageHost";

const BASE = "https://app.ade-app.dev/assets/plugin-pages/";

beforeEach(() => {
  disposed.mockClear();
  created.mockClear();
  closedPopover.mockClear();
  closedOverlay.mockClear();
  promptStore.token = 0;
  promptStore.request = null;
  promptStore.listeners.clear();
  putUrls = [];
  ensure = async () => ({ base: BASE });
  bundle = {
    pluginId: "ade-linear",
    version: "1.0.0",
    revision: 2,
    versionKey: "1.0.0-2",
    entry: "index.html",
    files: [{ path: "index.html", mime: "text/html; charset=utf-8", bytes: new TextEncoder().encode("<html></html>") }],
  };
  (window as unknown as { caches: unknown }).caches = {
    open: async () => ({
      put: async (url: string) => {
        putUrls.push(url);
      },
    }),
  };
  (window as unknown as { ade: unknown }).ade = {
    plugin: { pageAssetsManifest: async () => null, pageAssetsRead: async () => null },
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe("WebPluginPageHost", () => {
  it("opens the guest at the versioned path, carrying a fresh nonce", async () => {
    const { container } = render(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />);
    await settle();

    const frame = container.querySelector("iframe") as HTMLIFrameElement;
    expect(frame.src.startsWith(`${BASE}ade-linear/1.0.0-2/index.html`)).toBe(true);
    const url = new URL(frame.src);
    expect(url.searchParams.get("ade_n")).toBeTruthy();
    expect(url.searchParams.get("ade_csp")).toBeTruthy();
    expect(url.searchParams.get("ade_n")).not.toBe(url.searchParams.get("ade_csp"));
    // The bootstrap document was parked under the exact URL the frame asks for,
    // which is what makes the worker a pass-through.
    expect(putUrls).toEqual([frame.src]);
  });

  it("carries no sandbox attribute, because the response's own policy is the sandbox", async () => {
    const { container } = render(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />);
    await settle();
    // A sandboxed ELEMENT is never controlled by a service worker, so the
    // attribute would mean the frame could not be served its document at all.
    // See `pageDocument.ts`.
    expect(container.querySelector("iframe")?.hasAttribute("sandbox")).toBe(false);
  });

  it("destroys the guest when the surface is hidden, and builds a fresh one on return", async () => {
    const { rerender, container } = render(
      <WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />,
    );
    await settle();
    expect(created).toHaveBeenCalledTimes(1);
    expect(disposed).not.toHaveBeenCalled();

    rerender(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active={false} />);
    await settle();
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(container.querySelector("iframe")).toBeNull();

    rerender(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />);
    await settle();
    expect(created).toHaveBeenCalledTimes(2);
    expect(container.querySelector("iframe")).not.toBeNull();
  });

  it("disposes the guest on unmount", async () => {
    const { unmount } = render(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />);
    await settle();
    unmount();
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("draws the failure card, not an empty frame, when the worker never starts", async () => {
    ensure = async () => {
      throw new Error("no worker");
    };
    const { findByRole, findByText } = render(
      <WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />,
    );
    expect(await findByRole("alert")).toBeTruthy();
    expect(await findByText("The page didn’t load.")).toBeTruthy();
    expect(await findByText("ade-linear")).toBeTruthy();
    expect(await findByText("Reload")).toBeTruthy();
    expect(await findByText("Open logs")).toBeTruthy();
  });

  it("binds the plugin id and the placement at creation, never off a message", async () => {
    render(
      <WebPluginPageHost
        pluginId="ade-linear"
        entryHtml="index.html"
        active
        context={{
          subject: { kind: "session", id: "chat-1", title: "Chat", provider: null, status: null },
          placement: "popover",
        }}
      />,
    );
    await settle();
    const options = created.mock.calls[0][0] as {
      pluginId: string;
      context: { placement: string; subject: unknown };
      ui: { pick?: unknown };
    };
    expect(options.pluginId).toBe("ade-linear");
    expect(options.context.placement).toBe("popover");
    expect(options.context.subject).toMatchObject({ kind: "session", id: "chat-1" });
    expect(typeof options.ui.pick).toBe("function");
  });
});

describe("closeSurfaceFor", () => {
  it("closes the PAGE popover, never the vocabulary panel's quick view", () => {
    closeSurfaceFor("popover");
    closeSurfaceFor("composer-picker");
    expect(closedPopover).toHaveBeenCalledTimes(2);
    expect(closedOverlay).not.toHaveBeenCalled();
  });

  it("closes the overlay for an overlay", () => {
    closeSurfaceFor("overlay");
    expect(closedOverlay).toHaveBeenCalledTimes(1);
    expect(closedPopover).not.toHaveBeenCalled();
  });

  it("does nothing for a placement that IS the view", () => {
    // A tab, a pane and a drawer tab have nothing above them; a settings
    // section is part of a scrolling page. Closing an overlay for any of these
    // would dismiss something the reader opened for another reason.
    for (const placement of ["tab", "pane", "drawer", "settings-section"] as const) {
      closeSurfaceFor(placement);
    }
    expect(closedOverlay).not.toHaveBeenCalled();
    expect(closedPopover).not.toHaveBeenCalled();
  });
});

describe("askPrompt", () => {
  it("answers with the reader's words when they submit", async () => {
    const pending = askPrompt("ade-linear", { id: "q" });
    promptStore.request?.onSubmit("typed");
    await expect(pending).resolves.toMatchObject({ id: "q", text: "typed" });
  });

  it("answers null when the reader walks away, rather than hanging", async () => {
    const pending = askPrompt("ade-linear", { id: "q" });
    dismissPrompt();
    // Waiting for the guest's teardown instead would leave this pending for as
    // long as the reader stays on the surface, which reads as a button that
    // never comes back.
    await expect(pending).resolves.toBeNull();
  });

  it("lets a submit win the race against the store clearing", async () => {
    const pending = askPrompt("ade-linear", { id: "q" });
    const submit = promptStore.request?.onSubmit;
    // `submitPluginPrompt` clears the request BEFORE it calls `onSubmit`, which
    // is the exact order that would answer null for an answered question.
    dismissPrompt();
    submit?.("typed");
    await expect(pending).resolves.toMatchObject({ text: "typed" });
  });
});
