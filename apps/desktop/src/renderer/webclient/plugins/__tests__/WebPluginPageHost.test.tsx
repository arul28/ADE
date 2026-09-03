/* @vitest-environment jsdom */
// @vitest-environment-options {"url":"https://app.ade-app.dev/"}

import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";

import type { PluginPageBundle } from "../pageAssets";

const disposed = vi.fn();
const created = vi.fn();
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
vi.mock("../../../components/plugins/sockets/pluginPromptStore", () => ({ openPluginPrompt: () => 1 }));
vi.mock("../../../components/plugins/sockets/composerTarget", () => ({ applyPluginComposerEdit: () => true }));
vi.mock("../../../components/plugins/sockets/pluginPanelPopoverStore", () => ({ closePluginPanelPopover: () => undefined }));
vi.mock("../../../components/plugins/sockets/pluginWebviewOverlayStore", () => ({ closePluginWebviewOverlay: () => undefined }));
vi.mock("../../../components/plugins/pluginActionOpenSettings", () => ({ applyPluginActionOpenSettings: () => true }));
vi.mock("../../../lib/pluginRuntimeBridge", () => ({
  invokePluginAction: async () => null,
  readPluginCollection: async () => [],
  readPluginConfig: async () => ({}),
  readPluginPanel: async () => null,
  writePluginConfig: async () => undefined,
}));
vi.mock("../../../state/appStore", () => ({
  rootAppStoreApi: { getState: () => ({ installedPlugins: [] }) },
}));

import { WebPluginPageHost } from "../WebPluginPageHost";

const BASE = "https://app.ade-app.dev/assets/plugin-pages/";

beforeEach(() => {
  disposed.mockClear();
  created.mockClear();
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
    const { findByText } = render(<WebPluginPageHost pluginId="ade-linear" entryHtml="index.html" active />);
    expect(await findByText("This page didn’t open")).toBeTruthy();
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
    const options = created.mock.calls[0][0] as { pluginId: string; context: { placement: string; subject: unknown } };
    expect(options.pluginId).toBe("ade-linear");
    expect(options.context.placement).toBe("popover");
    expect(options.context.subject).toMatchObject({ kind: "session", id: "chat-1" });
  });
});
