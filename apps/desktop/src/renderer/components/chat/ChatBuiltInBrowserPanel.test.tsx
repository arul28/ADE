/* @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBuiltInBrowserPanel } from "./ChatBuiltInBrowserPanel";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../lib/workSidebarBrowserResize";

const browserStatus = {
  attached: true,
  partition: "persist:ade-browser",
  visible: true,
  bounds: { x: 10, y: 20, width: 640, height: 360 },
  activeTabId: "tab-1",
  tabs: [
    {
      id: "tab-1",
      url: "https://example.test/",
      title: "Example",
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
    },
  ],
  url: "https://example.test/",
  title: "Example",
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  isInspecting: false,
  hasSelection: false,
};

class MockResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

let nextFrameId = 0;
let nextFrameNow = 0;
const frameTimers = new Map<number, ReturnType<typeof setTimeout>>();

function makeRect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function stubElementFromPoint(impl: (x: number, y: number) => Element | null): () => void {
  const original = document.elementFromPoint;
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(impl),
  });
  return () => {
    if (original) {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: original,
      });
      return;
    }
    delete (document as unknown as { elementFromPoint?: unknown }).elementFromPoint;
  };
}

const REMOTE_PIN = {
  kind: "remote",
  key: "remote:target-studio:project-a",
  targetId: "target-studio",
  runtimeName: "Mac Studio",
  projectId: "project-a",
  rootPath: "/remote/repo-a",
  displayName: "repo-a",
} as const;

function installBrowserApi() {
  let eventListener: ((event: unknown) => void) | null = null;
  let remoteRequestListener: ((event: unknown) => void) | null = null;
  const api = {
    getStatus: vi.fn().mockResolvedValue(browserStatus),
    getProfileDiagnostics: vi.fn().mockResolvedValue({
      partition: "persist:ade-browser",
      storageProfileKey: "global",
      persistentProfile: true,
      cookieCount: 4,
      persistentCookieCount: 3,
      sessionCookieCount: 1,
      cookieDomains: ["github.com", "aws.amazon.com"],
      cacheSizeBytes: 2048,
      persistedPermissionDecisionCount: 1,
      tabRestorationEnabled: true,
      lastStorageFlushAt: "2026-05-12T00:00:00.000Z",
    }),
    listPermissions: vi.fn().mockResolvedValue({
      permissions: [{
        permission: "geolocation",
        origin: "https://example.test",
        embeddingOrigin: null,
        decision: "block",
        updatedAt: "2026-05-12T00:00:00.000Z",
      }],
    }),
    clearPermissions: vi.fn().mockResolvedValue({ removed: 1, permissions: [] }),
    setBounds: vi.fn().mockResolvedValue(browserStatus),
    attachWebview: vi.fn().mockResolvedValue(browserStatus),
    navigate: vi.fn().mockResolvedValue(browserStatus),
    createTab: vi.fn().mockResolvedValue(browserStatus),
    switchTab: vi.fn().mockResolvedValue(browserStatus),
    closeTab: vi.fn().mockResolvedValue(browserStatus),
    reload: vi.fn().mockResolvedValue(browserStatus),
    goBack: vi.fn().mockResolvedValue(browserStatus),
    goForward: vi.fn().mockResolvedValue(browserStatus),
    stop: vi.fn().mockResolvedValue(browserStatus),
    startInspect: vi.fn().mockResolvedValue(browserStatus),
    stopInspect: vi.fn().mockResolvedValue(browserStatus),
    captureScreenshot: vi.fn(),
    selectPoint: vi.fn(),
    selectCurrent: vi.fn(),
    clearSelection: vi.fn().mockResolvedValue(undefined),
    setEmulation: vi.fn().mockResolvedValue({
      tabId: "tab-1",
      emulation: null,
      presets: [],
      status: browserStatus,
    }),
    setZoom: vi.fn().mockResolvedValue({ tabId: "tab-1", zoomFactor: 1.1, status: browserStatus }),
    findInPage: vi.fn().mockResolvedValue({
      tabId: "tab-1",
      text: "widget",
      requestId: 1,
      activeMatchOrdinal: 1,
      matches: 12,
      finalUpdate: false,
      status: browserStatus,
    }),
    stopFindInPage: vi.fn().mockResolvedValue({ tabId: "tab-1", stopped: true, status: browserStatus }),
    setDevTools: vi.fn().mockResolvedValue({
      tabId: "tab-1",
      devToolsOpen: true,
      mode: "right",
      status: browserStatus,
    }),
    setNetworkLogging: vi.fn().mockResolvedValue({
      tabId: "tab-1",
      enabled: true,
      entryCount: 0,
      status: browserStatus,
    }),
    exportHar: vi.fn(),
    startRecording: vi.fn(),
    stopRecording: vi.fn().mockResolvedValue({
      tabId: "tab-1",
      path: "/tmp/ade/browser-recording-1.mp4",
      relativePath: ".ade/artifacts/browser-recording-1.mp4",
      durationMs: 42_000,
      fps: 60,
      frameCount: 2520,
      format: "mp4",
      mimeType: "video/mp4",
      caption: null,
      manifestPath: null,
      status: browserStatus,
    }),
    loginImport: {
      capabilities: vi.fn(),
      listSources: vi.fn().mockResolvedValue({
        platform: "darwin",
        sources: [
          {
            id: "chrome:default",
            browserId: "chrome",
            browserName: "Chrome",
            engine: "chromium",
            profileId: "Default",
            profileName: "Default",
            status: "ready",
            reason: null,
            settingsPaneUrl: null,
          },
          {
            id: "safari:main",
            browserId: "safari",
            browserName: "Safari",
            engine: "safari",
            profileId: "main",
            profileName: "Main",
            status: "needs_full_disk_access",
            reason: "Let ADE read Safari's cookies by granting Full Disk Access.",
            settingsPaneUrl: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
          },
        ],
        capabilities: { platform: "darwin", anySupported: true, browsers: [] },
      }),
      listDomains: vi.fn().mockResolvedValue({
        ok: true,
        sourceId: "chrome:default",
        domains: [{ domain: "github.com", cookieCount: 12, expiredCount: 0, sessionCookieCount: 2 }],
        unreadableCount: 0,
      }),
      import: vi.fn(),
    },
    onEvent: vi.fn((listener: (event: unknown) => void) => {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    }),
    localizeRemoteUrl: vi.fn(async ({ url }: { url: string }) => ({
      url: url.replace(/\/\/[^/]+/, "//127.0.0.1:52413"),
      forward: {
        machineKey: "target-studio",
        machineLabel: "Mac Studio",
        remotePort: Number(new URL(url).port),
        remoteOrigin: new URL(url).origin,
        localPort: 52413,
        localOrigin: "http://127.0.0.1:52413",
      },
    })),
    acknowledgeRemoteRequest: vi.fn().mockResolvedValue({ ok: true }),
    onRemoteRequest: vi.fn((listener: (event: unknown) => void) => {
      remoteRequestListener = listener;
      return () => {
        remoteRequestListener = null;
      };
    }),
    emitRemoteRequest: (event: unknown) => remoteRequestListener?.(event),
  };
  Object.defineProperty(window, "ade", {
    configurable: true,
    value: {
      builtInBrowser: api,
      zoom: {
        getFactor: vi.fn(() => 1),
      },
      agentChat: {
        saveTempAttachment: vi.fn(),
      },
      app: {
        openExternal: vi.fn(),
        revealPath: vi.fn().mockResolvedValue(undefined),
        readClipboardText: vi.fn().mockResolvedValue(""),
      },
      projectConfig: {
        get: vi.fn().mockResolvedValue({
          shared: {},
          local: {},
          effective: { browser: { linkOpenMode: "in-app" } },
        }),
        save: vi.fn().mockResolvedValue(undefined),
      },
      iosSimulator: {
        getStatus: vi.fn().mockResolvedValue({
          platform: "darwin",
          supported: true,
          tools: [],
          activeDevice: {
            udid: "sim-1",
            name: "iPhone 17 Pro",
            runtime: "iOS 19.0",
            state: "Booted",
            isAvailable: true,
          },
          activeSession: null,
        }),
      },
      localhost: {
        probePort: vi.fn().mockResolvedValue(false),
      },
    },
  });
  return {
    api,
    emit: (event: unknown) => eventListener?.(event),
  };
}

/** Radix opens menus on pointerdown, and jsdom has none of the pointer plumbing. */
function installRadixDomShims(): void {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture = vi.fn(() => false);
  proto.setPointerCapture = vi.fn();
  proto.releasePointerCapture = vi.fn();
  proto.scrollIntoView = vi.fn();
}

/**
 * Open a Radix dropdown by its trigger's accessible name.
 *
 * Keyboard rather than pointer: jsdom has no PointerEvent, so Radix's
 * `button === 0` guard on pointerdown never passes there.
 */
async function openMenu(label: string): Promise<void> {
  fireEvent.keyDown(await screen.findByLabelText(label), { key: "Enter" });
}

beforeEach(() => {
  nextFrameId = 0;
  nextFrameNow = 0;
  installRadixDomShims();
  vi.stubGlobal("ResizeObserver", MockResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    const timer = setTimeout(() => {
      frameTimers.delete(id);
      nextFrameNow += 100;
      callback(nextFrameNow);
    }, 0);
    frameTimers.set(id, timer);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    const timer = frameTimers.get(id);
    if (timer) clearTimeout(timer);
    frameTimers.delete(id);
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    x: 10,
    y: 20,
    left: 10,
    top: 20,
    right: 650,
    bottom: 380,
    width: 640,
    height: 360,
    toJSON: () => ({}),
  } as DOMRect));
});

afterEach(() => {
  cleanup();
  for (const timer of frameTimers.values()) clearTimeout(timer);
  frameTimers.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as unknown as { ade?: unknown }).ade;
});

describe("ChatBuiltInBrowserPanel", () => {
  it("exposes global profile diagnostics and permission removal only through the trusted renderer", async () => {
    const { api } = installBrowserApi();
    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Profile…"));

    expect(await screen.findByText("Global authenticated profile")).toBeTruthy();
    expect(await screen.findByText(/4 cookies · 3 persistent · 1 session/)).toBeTruthy();
    expect(screen.getByText(/github\.com, aws\.amazon\.com/)).toBeTruthy();
    expect(screen.getByText(/https:\/\/example\.test · geolocation/)).toBeTruthy();

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => {
      expect(api.clearPermissions).toHaveBeenCalledWith({
        origin: "https://example.test",
        permission: "geolocation",
      });
    });
    expect(await screen.findByText("No remembered allow or block decisions.")).toBeTruthy();
  });

  it("keeps tab webContents owned by the main browser service across panel mounts", async () => {
    const { api } = installBrowserApi();

    const firstMount = render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());
    firstMount.unmount();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => expect(api.getStatus).toHaveBeenCalledTimes(2));

    expect(api.attachWebview).not.toHaveBeenCalled();
    expect(api.createTab).not.toHaveBeenCalled();
    expect(document.querySelector("webview")).toBeNull();
  });

  it("mounts for a chat on another machine and tunnels its loopback URLs", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" runtimePin={REMOTE_PIN} />);

    // The pane no longer refuses a remote pin: the browser is this desktop's,
    // and it is driven normally.
    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());
    expect(api.onEvent).toHaveBeenCalled();
    expect(api.onRemoteRequest).toHaveBeenCalled();

    const urlInput = screen.getByLabelText("ADE browser URL") as HTMLInputElement;
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: "http://localhost:3000/app" } });
    fireEvent.blur(urlInput);
    fireEvent.click(screen.getByLabelText("Open URL"));

    await waitFor(() => {
      // The ORIGINAL loopback URL crosses the bridge; preload localizes it onto
      // the forward, so the renderer must not pre-rewrite it (that would tunnel
      // the forward port itself).
      expect(api.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://localhost:3000/app" }),
        REMOTE_PIN,
      );
    });
    expect(api.localizeRemoteUrl).toHaveBeenCalledWith(
      { url: "http://localhost:3000/app" },
      REMOTE_PIN,
    );
    // A human-typed URL is its own approval, so no bar appears.
    expect(screen.queryByText(/Agent wants to reach port/)).toBeNull();
  });

  it("asks for a human grant before an agent's forwarded open reaches a new port", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" runtimePin={REMOTE_PIN} />);
    await waitFor(() => expect(api.onRemoteRequest).toHaveBeenCalled());

    api.emitRemoteRequest({
      requestId: "bbr-1",
      url: "http://127.0.0.1:8080/admin",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      openPanel: true,
      requestedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(await screen.findByText("Agent wants to reach port 8080 on Mac Studio")).toBeTruthy();
    // Nothing loads and no forward opens until a person answers.
    expect(api.navigate).not.toHaveBeenCalled();
    expect(api.localizeRemoteUrl).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("Allow once"));

    await waitFor(() => {
      expect(api.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ url: "http://127.0.0.1:8080/admin" }),
        REMOTE_PIN,
      );
    });
    await waitFor(() => {
      expect(api.acknowledgeRemoteRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "bbr-1", accepted: true }),
        REMOTE_PIN,
      );
    });
  });

  it("acknowledges a refusal so the waiting CLI stops guessing", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" runtimePin={REMOTE_PIN} />);
    await waitFor(() => expect(api.onRemoteRequest).toHaveBeenCalled());

    api.emitRemoteRequest({
      requestId: "bbr-2",
      url: "http://localhost:5432/",
      laneId: null,
      chatSessionId: null,
      openPanel: true,
      requestedAt: "2026-09-07T00:00:00.000Z",
    });

    fireEvent.click(await screen.findByText("Deny"));

    await waitFor(() => {
      expect(api.acknowledgeRemoteRequest).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "bbr-2", accepted: false }),
        REMOTE_PIN,
      );
    });
    expect(api.navigate).not.toHaveBeenCalled();
  });

  it("routes personal chat browser calls to the personal tab collection", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="personal-chat-1" projectRootOverride={null} />);

    await waitFor(() => {
      expect(api.getStatus).toHaveBeenCalledWith({ tabCollection: "personal" }, null);
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        tabCollection: "personal",
      }), null);
    });
  });

  it("temporarily hides the browser while the Work sidebar splitter is being dragged", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });

    window.dispatchEvent(new Event(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }), null);
    });

    window.dispatchEvent(new Event(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });
  });

  it("keeps the native browser hidden while overlay occlusions are active", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }), null);
    });

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));

    expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      width: 640,
      height: 360,
      visible: false,
    }), null);

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });
  });

  it("hides the native browser while ADE overlays overlap the browser surface", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });

    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.style.position = "fixed";
    overlay.style.zIndex = "9999";
    overlay.style.width = "320px";
    overlay.style.height = "180px";
    document.body.appendChild(overlay);

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }), null);
    });

    overlay.remove();

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });
  });

  it("hides positioned ADE overlays even when their z-index is low", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }), null);
    });

    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.zIndex = "1";
    overlay.style.width = "320px";
    overlay.style.height = "180px";
    document.body.appendChild(overlay);

    try {
      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: false,
        }), null);
      });
    } finally {
      overlay.remove();
    }
  });

  it("does not hide the native browser for overlay candidates painted behind other ADE UI", async () => {
    const restoreElementFromPoint = stubElementFromPoint(() => document.body);
    let overlay: HTMLDivElement | null = null;
    try {
      const { api } = installBrowserApi();

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: true,
        }), null);
      });

      overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.style.position = "fixed";
      overlay.style.zIndex = "9999";
      overlay.style.width = "320px";
      overlay.style.height = "180px";
      document.body.appendChild(overlay);

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: true,
        }), null);
      });

      expect(api.setBounds).not.toHaveBeenCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }));
    } finally {
      overlay?.remove();
      restoreElementFromPoint();
    }
  });

  it("rechecks overlays that move over the browser during transitions", async () => {
    let overlay: HTMLDivElement | null = null;
    let overlayOverlapsBrowser = false;
    const restoreElementFromPoint = stubElementFromPoint(() => overlayOverlapsBrowser ? overlay : document.body);
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function getBoundingClientRect(this: HTMLElement) {
      if (this === overlay) {
        return overlayOverlapsBrowser ? makeRect(30, 40, 320, 180) : makeRect(900, 40, 320, 180);
      }
      return makeRect(10, 20, 640, 360);
    });
    try {
      const { api } = installBrowserApi();

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: true,
        }), null);
      });

      overlay = document.createElement("div");
      overlay.setAttribute("role", "dialog");
      overlay.style.position = "fixed";
      overlay.style.width = "320px";
      overlay.style.height = "180px";
      document.body.appendChild(overlay);

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: true,
        }), null);
      });
      expect(api.setBounds).not.toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      overlayOverlapsBrowser = true;
      overlay.dispatchEvent(new Event("transitionend", { bubbles: true }));

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: false,
        }), null);
      });
    } finally {
      overlay?.remove();
      restoreElementFromPoint();
    }
  });

  it("starts and cancels screenshot crop mode when chat context is available", async () => {
    const { api } = installBrowserApi();
    api.captureScreenshot.mockResolvedValue({
      dataUrl: "data:image/png;base64,iVBORw0KGgo=",
      width: 640,
      height: 360,
      capturedAt: "2026-05-12T00:00:00.000Z",
    });

    const onAddContext = vi.fn();
    render(<ChatBuiltInBrowserPanel sessionId="chat-1" onAddContext={onAddContext} />);

    fireEvent.click(await screen.findByLabelText("Screenshot · Shift-click to record"));

    await waitFor(() => expect(api.captureScreenshot).toHaveBeenCalled());
    expect(await screen.findByText("Drag a browser region to attach the screenshot crop and nearby page context.")).toBeTruthy();
    expect(await screen.findByLabelText("Cancel screenshot")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Cancel screenshot"));

    expect(await screen.findByText("Browser screenshot capture cancelled.")).toBeTruthy();
    expect(await screen.findByLabelText("Screenshot · Shift-click to record")).toBeTruthy();
    expect(onAddContext).not.toHaveBeenCalled();
  });

  it("attaches the selected browser element through the visible Attach control", async () => {
    const { api } = installBrowserApi();
    const onAddContext = vi.fn();
    const selectedItem = {
      kind: "built_in_browser_element",
      id: "browser-selection-1",
      sessionId: "chat-1",
      label: "Submit button",
      text: "Submit",
      role: "button",
      tagName: "button",
      selector: "button.submit",
      frame: { x: 10, y: 20, width: 80, height: 24 },
      metadata: {},
      selectedAt: "2026-05-12T00:00:00.000Z",
    };
    api.getStatus.mockResolvedValue({ ...browserStatus, selectedItem });
    api.selectCurrent.mockResolvedValue({ item: selectedItem });

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" onAddContext={onAddContext} />);

    const attachButton = await screen.findByTitle("Insert the selected browser element as context");
    expect(attachButton.textContent).toContain("Attach");
    fireEvent.click(attachButton);

    await waitFor(() => {
      expect(api.selectCurrent).toHaveBeenCalled();
    });
    expect(onAddContext).toHaveBeenCalledWith(expect.objectContaining({
      id: "browser-selection-1",
      selector: "button.submit",
    }));
  });

  it("applies a device preset from the device menu", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("Browser device preset — Desktop");
    fireEvent.click(await screen.findByText("iPhone 17 Pro"));

    await waitFor(() => {
      expect(api.setEmulation).toHaveBeenCalledWith(
        expect.objectContaining({ preset: "iphone-17-pro" }),
        null,
      );
    });
  });

  it("offers the booted simulator only when its device maps onto known metrics", async () => {
    installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("Browser device preset — Desktop");

    expect(await screen.findByText("Booted simulator: iPhone 17 Pro")).toBeTruthy();
  });

  it("shows find counts from found-in-page events and stops the find on close", async () => {
    const { api, emit } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Find on page"));

    const findInput = await screen.findByLabelText("Find on page");
    fireEvent.change(findInput, { target: { value: "widget" } });

    await waitFor(() => expect(api.findInPage).toHaveBeenCalled());

    emit({
      type: "found-in-page",
      tabId: "tab-1",
      requestId: 1,
      activeMatchOrdinal: 3,
      matches: 12,
      finalUpdate: true,
      foundAt: "2026-09-07T00:00:00.000Z",
    });

    expect(await screen.findByText("3 of 12")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close find bar"));

    await waitFor(() => {
      expect(api.stopFindInPage).toHaveBeenCalledWith(
        expect.objectContaining({ action: "clearSelection" }),
        null,
      );
    });
  });

  it("shows a REC pill from the tab state and stops the recording when it is clicked", async () => {
    const { api } = installBrowserApi();
    const recordingStatus = {
      ...browserStatus,
      tabs: [{
        ...browserStatus.tabs[0],
        recording: { startedAt: new Date(Date.now() - 42_000).toISOString(), fps: 60 },
      }],
    };
    api.getStatus.mockResolvedValue(recordingStatus);

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    const pill = await screen.findByTitle("Stop recording");
    expect(pill.textContent).toContain("REC 0:42");
    expect(pill.textContent).toContain("60 fps");

    fireEvent.click(pill);

    await waitFor(() => expect(api.stopRecording).toHaveBeenCalled());
  });

  it("starts a recording at the chosen frame rate on Shift-click", async () => {
    const { api } = installBrowserApi();
    api.startRecording.mockResolvedValue({
      tabId: "tab-1",
      recording: { startedAt: "2026-09-07T00:00:00.000Z", fps: 60 },
      status: browserStatus,
    });

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("60 fps"));
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    fireEvent.click(
      await screen.findByLabelText("Screenshot · Shift-click to record"),
      { shiftKey: true },
    );

    await waitFor(() => {
      expect(api.startRecording).toHaveBeenCalledWith(
        expect.objectContaining({ fps: 60 }),
        null,
      );
    });
  });

  it("lists import sources and explains the ones it cannot read", async () => {
    installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Import logins…"));

    expect(await screen.findByText("Chrome")).toBeTruthy();
    expect(screen.getByText("Safari")).toBeTruthy();
    expect(
      screen.getByText("Let ADE read Safari's cookies by granting Full Disk Access."),
    ).toBeTruthy();
    // A blocked source offers the fix, never a dead "Choose".
    expect(screen.getByText("Open System Settings")).toBeTruthy();
  });

  it("writes browser.linkOpenMode when the link mode is changed", async () => {
    installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("System browser"));

    await waitFor(() => {
      expect(window.ade.projectConfig.save).toHaveBeenCalledWith(
        expect.objectContaining({
          local: expect.objectContaining({
            browser: expect.objectContaining({ linkOpenMode: "external" }),
          }),
        }),
      );
    });
  });
  describe("login handoff bar", () => {
    const HANDOFF = {
      reason: "sign in to staging",
      startedAt: "2026-05-12T00:00:00.000Z",
      expiresAt: "2026-05-12T00:15:00.000Z",
      requestedByChatSessionId: "chat-1",
      requestedByLaneId: "lane-1",
      startedAtOrigin: "https://login.example.test",
      previousOwner: { laneId: "lane-1", chatSessionId: "chat-1" },
    };

    function handoffStatus(url: string) {
      return {
        ...browserStatus,
        url,
        tabs: [{ ...browserStatus.tabs[0], url, handoff: HANDOFF }],
      };
    }

    it("asks the human to sign in and hands the tab back when they say so", async () => {
      const { api } = installBrowserApi();
      const status = handoffStatus("https://login.example.test/");
      api.getStatus.mockResolvedValue(status);
      const endHandoff = vi.fn().mockResolvedValue({ tabId: "tab-1", handoff: null, status });
      Object.assign(api, { endHandoff });

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      expect(await screen.findByText(/Agent needs you to sign in/)).toBeTruthy();
      expect(screen.getByText(/sign in to staging/)).toBeTruthy();

      fireEvent.click(screen.getByText("Hand back"));

      await waitFor(() => {
        expect(endHandoff.mock.calls[0]?.[0]).toMatchObject({ endedBy: "human" });
      });
    });

    it("offers hand-back once the tab leaves the origin it was handed over on", async () => {
      const { api } = installBrowserApi();
      // The person has been carried through the identity provider and landed
      // somewhere else — that, not a timer, is the signal they are probably done.
      const status = handoffStatus("https://app.example.test/dashboard");
      api.getStatus.mockResolvedValue(status);
      const endHandoff = vi.fn().mockResolvedValue({ tabId: "tab-1", handoff: null, status });
      Object.assign(api, { endHandoff });

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      expect(await screen.findByText("Signed in?")).toBeTruthy();

      fireEvent.click(screen.getByText("Keep control"));

      // Silenced for THIS origin only, and the bar stays up: the tab is still theirs.
      await waitFor(() => {
        expect(screen.queryByText("Signed in?")).toBeNull();
      });
      expect(screen.getByText(/Agent needs you to sign in/)).toBeTruthy();
      expect(endHandoff).not.toHaveBeenCalled();
    });

    it("shows no bar at all when nothing is handed off", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      await waitFor(() => expect(window.ade.builtInBrowser.getStatus).toHaveBeenCalled());
      expect(screen.queryByTestId("browser-handoff-bar")).toBeNull();
    });
  });
});
