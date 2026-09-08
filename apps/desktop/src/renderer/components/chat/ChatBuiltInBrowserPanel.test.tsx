/* @vitest-environment jsdom */

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBuiltInBrowserPanel } from "./ChatBuiltInBrowserPanel";
import {
  ADE_BROWSER_VIEW_OCCLUSION_END_EVENT,
  ADE_BROWSER_VIEW_OCCLUSION_START_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT,
  ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT,
} from "../../lib/workSidebarBrowserResize";
import type { BuiltInBrowserStatus } from "../../../shared/types/builtInBrowser";
import { makeBuiltInBrowserStatus, makeBuiltInBrowserTab } from "./__fixtures__/builtInBrowserStatus";

const browserStatus: BuiltInBrowserStatus = makeBuiltInBrowserStatus();

/**
 * A ResizeObserver the test can actually resize.
 *
 * The toolbar decides what it can afford from its own measured width, so a
 * stub that never fires would test every layout at "unmeasured" — which is the
 * one width that was never broken.
 */
const resizeObservers: MockResizeObserver[] = [];

class MockResizeObserver {
  callback: ResizeObserverCallback;
  targets: Element[] = [];
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    resizeObservers.push(this);
  }
  observe = (target: Element) => {
    this.targets.push(target);
  };
  unobserve = vi.fn();
  disconnect = () => {
    const index = resizeObservers.indexOf(this);
    if (index >= 0) resizeObservers.splice(index, 1);
  };
}

/** Drag the pane to `width` and let the toolbar re-decide. */
function setToolbarWidth(width: number): void {
  const row = screen.getByTestId("browser-toolbar-row");
  Object.defineProperty(row, "getBoundingClientRect", {
    configurable: true,
    value: () => makeRect(0, 0, width, 36),
  });
  act(() => {
    for (const observer of [...resizeObservers]) {
      if (observer.targets.includes(row)) {
        observer.callback([], observer as unknown as ResizeObserver);
      }
    }
  });
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

/** The mounted status, with the fields a test needs to vary. */
function statusWith(overrides: Partial<BuiltInBrowserStatus>): BuiltInBrowserStatus {
  return makeBuiltInBrowserStatus(overrides);
}

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
    captureScreenshot: vi.fn().mockResolvedValue({
      dataUrl: "data:image/png;base64,underlay",
      width: 640,
      height: 360,
      capturedAt: "2026-09-07T00:00:00.000Z",
    }),
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
    getDevServers: vi.fn().mockResolvedValue([
      { url: "http://localhost:5173", port: 5173, command: "npm run dev" },
    ]),
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
            settingsPaneId: null,
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
            settingsPaneId: "macos-full-disk-access",
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
        openSystemSettingsPane: vi.fn().mockResolvedValue({ opened: true }),
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
  resizeObservers.length = 0;
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

    expect(api.createTab).not.toHaveBeenCalled();
    // Tabs are the main service's WebContentsViews, never renderer <webview>
    // nodes — a remount must not build a second, renderer-owned browser.
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

  it("hands the OS the loaded URL, not the tunneled origin on display", async () => {
    const { api } = installBrowserApi();
    const openExternal = (window.ade.app as unknown as { openExternal: ReturnType<typeof vi.fn> })
      .openExternal;

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" runtimePin={REMOTE_PIN} />);
    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());

    // What the tab really loads is the local forward; what the omnibox shows is
    // the remote origin the human asked for.
    api.getStatus.mockResolvedValue(statusWith({
      url: "http://127.0.0.1:52413/app",
      tabs: [makeBuiltInBrowserTab({ url: "http://127.0.0.1:52413/app" })],
    }));

    const urlInput = screen.getByLabelText("ADE browser URL") as HTMLInputElement;
    fireEvent.focus(urlInput);
    fireEvent.change(urlInput, { target: { value: "http://localhost:3000/app" } });
    fireEvent.blur(urlInput);
    fireEvent.click(screen.getByLabelText("Open URL"));

    // The pill is the tab admitting it is looking at another machine; from here
    // `currentUrl` is the remote origin while `status.url` is the forward.
    expect(await screen.findByTitle("Tunneled to port 3000 on Mac Studio")).toBeTruthy();
    // And the omnibox never shows the ephemeral forward port, not even for the
    // one status cycle between the navigate and the refresh.
    await waitFor(() => expect(urlInput.value).toBe("http://localhost:3000/app"));

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Open this page in system browser"));

    // Handing over the DISPLAY url would load THIS machine's port 3000 — a
    // different project's dev server — under the belief it is the same page.
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith("http://127.0.0.1:52413/app"));
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

  it("acknowledges the moment the bar goes up, so the 5s CLI wait does not lapse", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" runtimePin={REMOTE_PIN} />);
    await waitFor(() => expect(api.onRemoteRequest).toHaveBeenCalled());

    api.emitRemoteRequest({
      requestId: "bbr-3",
      url: "http://127.0.0.1:9999/",
      laneId: "lane-1",
      chatSessionId: "chat-1",
      openPanel: true,
      requestedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(await screen.findByText("Agent wants to reach port 9999 on Mac Studio")).toBeTruthy();
    // Nobody answers an approval bar inside the requester's 5s ack window, so
    // the desktop says "taken, a person is deciding" and the CLI exits 0.
    await waitFor(() => {
      expect(api.acknowledgeRemoteRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: "bbr-3",
          accepted: true,
          awaitingApproval: true,
        }),
        REMOTE_PIN,
      );
    });
    expect(api.navigate).not.toHaveBeenCalled();
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

  it("drops stale match counts on a navigation and ends the find session on unmount", async () => {
    const { api, emit } = installBrowserApi();

    const view = render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
    await waitFor(() => expect(api.getStatus).toHaveBeenCalled());

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Find on page"));
    fireEvent.change(await screen.findByLabelText("Find on page"), { target: { value: "checkout" } });
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

    // A different page has different matches, and almost certainly not twelve.
    emit({
      type: "status",
      status: statusWith({
        url: "https://other.test/",
        tabs: [makeBuiltInBrowserTab({ url: "https://other.test/" })],
      }),
    });
    await waitFor(() => expect(screen.queryByText("3 of 12")).toBeNull());

    api.stopFindInPage.mockClear();
    view.unmount();

    // Leaving the Browser tool with the bar open used to leave Chromium's find
    // highlight burnt into the tab forever.
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

  it("opens the Full Disk Access pane by id, not through the external-URL opener", async () => {
    installBrowserApi();
    const app = window.ade.app as unknown as {
      openExternal: ReturnType<typeof vi.fn>;
      openSystemSettingsPane: ReturnType<typeof vi.fn>;
    };

    render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

    await openMenu("More browser options");
    fireEvent.click(await screen.findByText("Import logins…"));
    fireEvent.click(await screen.findByText("Open System Settings"));

    await waitFor(() => {
      expect(app.openSystemSettingsPane).toHaveBeenCalledWith("macos-full-disk-access");
    });
    // `x-apple.systempreferences:` is rejected by the external-URL allowlist,
    // so routing it there made the one remediation button a guaranteed no-op.
    expect(app.openExternal).not.toHaveBeenCalled();
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

  describe("launchpad", () => {
    const EMPTY_STATUS = {
      ...browserStatus,
      activeTabId: null,
      tabs: [],
      url: null,
      title: null,
    };

    it("waits for an address instead of opening a search engine nobody asked for", async () => {
      const { api } = installBrowserApi();
      api.getStatus.mockResolvedValue(EMPTY_STATUS);

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      expect(await screen.findByTestId("browser-launchpad")).toBeTruthy();
      // The old panel navigated to Google on its own; closing the last tab then
      // silently opened a new one.
      expect(api.navigate).not.toHaveBeenCalled();
      expect(api.createTab).not.toHaveBeenCalled();
    });

    it("offers the dev servers the machine actually has, named by their command", async () => {
      const { api } = installBrowserApi();
      api.getStatus.mockResolvedValue(EMPTY_STATUS);

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      const chip = await screen.findByText("npm run dev · :5173");
      expect(screen.queryByText("localhost:3000")).toBeNull();

      fireEvent.click(chip);

      await waitFor(() => {
        expect(api.navigate).toHaveBeenCalledWith(
          expect.objectContaining({ url: "http://localhost:5173" }),
          null,
        );
      });
    });

    it("offers Paste a link only when the clipboard holds one", async () => {
      const { api } = installBrowserApi();
      api.getStatus.mockResolvedValue(EMPTY_STATUS);
      vi.mocked(window.ade.app.readClipboardText).mockResolvedValue("fix the login page");

      const { unmount } = render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-launchpad");
      await waitFor(() => expect(window.ade.app.readClipboardText).toHaveBeenCalled());
      expect(screen.queryByText("Paste a link")).toBeNull();
      unmount();

      vi.mocked(window.ade.app.readClipboardText).mockResolvedValue("https://example.com/pr/1");
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      expect(await screen.findByText("Paste a link")).toBeTruthy();
    });

    it("opens an empty tab from +, not a page", async () => {
      const { api } = installBrowserApi();
      api.getStatus.mockResolvedValue(EMPTY_STATUS);

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      fireEvent.click(await screen.findByLabelText("New tab"));

      await waitFor(() => {
        expect(api.createTab).toHaveBeenCalledWith(
          expect.objectContaining({ activate: true }),
          null,
        );
      });
      expect(api.createTab.mock.calls[0]?.[0]).not.toHaveProperty("url");
    });

    it("hides the native view so nothing paints over the launchpad", async () => {
      const { api } = installBrowserApi();
      api.getStatus.mockResolvedValue(EMPTY_STATUS);

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-launchpad");

      // The view is composited above this renderer; leaving it visible would
      // put an unreachable blank page on top of the chips.
      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(
          expect.objectContaining({ visible: false }),
          null,
        );
      });
    });

    it("stays out of the way once a tab has a page", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      await waitFor(() => expect(window.ade.builtInBrowser.getStatus).toHaveBeenCalled());
      expect(screen.queryByTestId("browser-launchpad")).toBeNull();
    });

    it("never flashes over a loaded page and leaves the omnibox blank", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      // The launchpad focuses the URL field; showing it for the frame before the
      // first status lands used to strand an empty, focused omnibox over a page
      // that was in fact loaded.
      const urlInput = await screen.findByLabelText("ADE browser URL");
      await waitFor(() => {
        expect((urlInput as HTMLInputElement).value).toBe("https://example.test/");
      });
      expect(screen.queryByTestId("browser-launchpad")).toBeNull();
    });
  });

  describe("find bar", () => {
    it("focuses and selects the field on ⌘F, and searches after the debounce", async () => {
      const { api } = installBrowserApi();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
        const panel = await screen.findByLabelText("ADE browser URL");

        fireEvent.keyDown(panel, { key: "f", metaKey: true });

        const input = await screen.findByLabelText("Find on page");
        await waitFor(() => expect(document.activeElement).toBe(input));

        fireEvent.change(input, { target: { value: "widget" } });
        // Nothing goes out mid-word.
        expect(api.findInPage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(160);
        await waitFor(() => {
          expect(api.findInPage).toHaveBeenCalledWith(
            expect.objectContaining({ text: "widget", findNext: false }),
            null,
          );
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("steps forward on Enter and backwards on Shift-Enter", async () => {
      const { api } = installBrowserApi();

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await openMenu("More browser options");
      fireEvent.click(await screen.findByText("Find on page"));

      const input = await screen.findByLabelText("Find on page");
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => {
        expect(api.findInPage).toHaveBeenCalledWith(
          expect.objectContaining({ findNext: true, forward: true }),
          null,
        );
      });

      fireEvent.keyDown(input, { key: "Enter", shiftKey: true });

      await waitFor(() => {
        expect(api.findInPage).toHaveBeenLastCalledWith(
          expect.objectContaining({ findNext: true, forward: false }),
          null,
        );
      });
    });

    it("says what went wrong in a sentence, never in the service's words", async () => {
      const { api } = installBrowserApi();
      api.findInPage.mockRejectedValue(new Error(
        "Error invoking remote method 'built-in-browser:find-in-page': TypeError: undefined",
      ));

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await openMenu("More browser options");
      fireEvent.click(await screen.findByText("Find on page"));

      const input = await screen.findByLabelText("Find on page");
      fireEvent.change(input, { target: { value: "widget" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByText("Find is not available on this page.")).toBeTruthy();
      expect(screen.queryByText(/invoking remote method/)).toBeNull();
    });
  });

  describe("popover underlay", () => {
    it("freezes the last frame before hiding the view, and clears it once the view is back", async () => {
      const { api } = installBrowserApi();

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await waitFor(() => {
        expect(api.setBounds).toHaveBeenCalledWith(
          expect.objectContaining({ visible: true }),
          null,
        );
      });

      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));

      // The frozen frame is painted at the view's bounds…
      const underlay = await screen.findByTestId("browser-underlay");
      expect(underlay.getAttribute("src")).toBe("data:image/png;base64,underlay");
      expect(api.captureScreenshot).toHaveBeenCalled();
      // …and only then does the live view go, so no black rectangle appears.
      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(
          expect.objectContaining({ visible: false }),
          null,
        );
      });

      window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(
          expect.objectContaining({ visible: true }),
          null,
        );
      });
      await waitFor(() => {
        expect(screen.queryByTestId("browser-underlay")).toBeNull();
      });
    });
  });

  describe("narrow panes", () => {
    it("never squeezes the URL field out of the toolbar", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");

      // 420px is where the old fixed thresholds left every control in place and
      // the omnibox at zero width.
      setToolbarWidth(420);
      expect(screen.getByLabelText("ADE browser URL")).toBeTruthy();
      expect(screen.getByLabelText("Browser device preset — Desktop")).toBeTruthy();
      // Icon-only from here down: the labels are what paid for the field.
      expect(screen.queryByText("Inspect")).toBeNull();
      expect(screen.queryByText("Open")).toBeNull();

      setToolbarWidth(300);
      expect(screen.getByLabelText("ADE browser URL")).toBeTruthy();
      expect(screen.getByLabelText("More browser options")).toBeTruthy();
      expect(screen.getByLabelText("Go back")).toBeTruthy();
      // Everything shed is still reachable, which is the whole point of ⋮.
      expect(screen.queryByLabelText("Browser device preset — Desktop")).toBeNull();
      expect(screen.queryByLabelText("Select an element in the ADE browser")).toBeNull();
    });

    it("keeps Attach selection reachable from the menu once the button is shed", async () => {
      const { api, emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" onAddContext={vi.fn()} />);
      await screen.findByTestId("browser-toolbar-row");

      // `selectedItem` is a panel-side enrichment of the wire status, not a
      // field of `BuiltInBrowserStatus`, so it rides alongside the fixture.
      emit({
        type: "status",
        status: {
          ...statusWith({ hasSelection: true }),
          selectedItem: {
            id: "sel-1",
            kind: "built_in_browser_element",
            url: "https://example.test/",
            title: "Example",
            selector: "#cta",
            text: "Buy",
            frame: null,
            metadata: {},
            selectedAt: "2026-09-07T00:00:00.000Z",
          },
        },
      });
      await screen.findByText("Attach");

      // Attach is the FIRST control the row sheds, and re-attaching an
      // already-attached selection has no other entry point.
      setToolbarWidth(300);
      expect(screen.queryByText("Attach")).toBeNull();

      await openMenu("More browser options");
      fireEvent.click(await screen.findByText("Attach selection"));

      await waitFor(() => expect(api.selectCurrent).toHaveBeenCalled());
    });

    it("hands the width back as the pane widens again", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");

      setToolbarWidth(300);
      expect(screen.queryByLabelText("Browser device preset — Desktop")).toBeNull();

      setToolbarWidth(760);
      expect(screen.getByLabelText("Browser device preset — Desktop")).toBeTruthy();
      expect(screen.getByText("Inspect")).toBeTruthy();
      expect(screen.getByText("Open")).toBeTruthy();
    });

    it("steps the Open affordance aside while the omnibox is focused", async () => {
      installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");
      setToolbarWidth(760);

      expect(screen.getByTestId("browser-url-submit")).toBeTruthy();

      fireEvent.focus(screen.getByLabelText("ADE browser URL"));
      expect(screen.queryByTestId("browser-url-submit")).toBeNull();

      fireEvent.blur(screen.getByLabelText("ADE browser URL"));
      expect(screen.getByTestId("browser-url-submit")).toBeTruthy();
    });
  });

  describe("find bar", () => {
    it("keeps Escape to itself instead of closing the whole tool", async () => {
      const { api } = installBrowserApi();
      const onKeyDown = vi.fn();
      render(
        <div onKeyDown={onKeyDown}>
          <ChatBuiltInBrowserPanel sessionId="chat-1" />
        </div>,
      );
      await waitFor(() => expect(api.getStatus).toHaveBeenCalled());

      fireEvent.keyDown(screen.getByLabelText("ADE browser URL").closest("div")!, {
        key: "f",
        metaKey: true,
      });
      const bar = await screen.findByTestId("browser-find-bar");
      // The contract the pane's capture-phase handler reads.
      expect(bar.getAttribute("data-ade-escape-scope")).toBe("find");

      onKeyDown.mockClear();
      fireEvent.keyDown(screen.getByLabelText("Find on page"), { key: "Escape" });

      await waitFor(() => expect(screen.queryByTestId("browser-find-bar")).toBeNull());
      // Nothing above the panel ever sees it, so nothing above the panel acts.
      expect(onKeyDown).not.toHaveBeenCalled();
    });
  });

  describe("device menu", () => {
    it("checks the preset that is actually applied", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");

      emit({
        type: "status",
        status: {
          ...browserStatus,
          tabs: [{
            ...browserStatus.tabs[0],
            emulation: {
              presetId: "iphone-17",
              label: "iPhone 17",
              width: 393,
              height: 852,
              deviceScaleFactor: 3,
              mobile: true,
              hasTouch: true,
              userAgent: "iphone",
            },
          }],
        },
      });

      await screen.findByLabelText("Browser device preset — iPhone 17");
      await openMenu("Browser device preset — iPhone 17");

      const checked = (await screen.findAllByRole("menuitemradio"))
        .filter((item) => item.getAttribute("aria-checked") === "true");
      expect(checked).toHaveLength(1);
      expect(checked[0].textContent).toContain("iPhone 17");
    });

    it("still names the device, and keeps it checked, after a rotation", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");

      // What the service sends back after a rotate: a custom size, called
      // responsive, whose numbers are an iPhone 17 lying on its side.
      emit({
        type: "status",
        status: {
          ...browserStatus,
          tabs: [{
            ...browserStatus.tabs[0],
            emulation: {
              presetId: "responsive",
              label: "852×393",
              width: 852,
              height: 393,
              deviceScaleFactor: 3,
              mobile: true,
              hasTouch: true,
              userAgent: "iphone",
            },
          }],
        },
      });

      expect(await screen.findByText("iPhone 17 · landscape")).toBeTruthy();
      expect(screen.getByTestId("browser-emulation-caption").textContent).toContain("852 × 393");

      await openMenu("Browser device preset — iPhone 17 · landscape");
      const checked = (await screen.findAllByRole("menuitemradio"))
        .filter((item) => item.getAttribute("aria-checked") === "true");
      expect(checked).toHaveLength(1);
      expect(checked[0].textContent).toContain("iPhone 17");
    });

    it("rotates with the preset attached so the device keeps its own metrics", async () => {
      const { api, emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");

      emit({
        type: "status",
        status: {
          ...browserStatus,
          tabs: [{
            ...browserStatus.tabs[0],
            emulation: {
              presetId: "iphone-17",
              label: "iPhone 17",
              width: 393,
              height: 852,
              deviceScaleFactor: 3,
              mobile: true,
              hasTouch: true,
              userAgent: "iphone",
            },
          }],
        },
      });

      fireEvent.click(await screen.findByLabelText("Rotate the emulated device"));

      await waitFor(() => {
        expect(api.setEmulation).toHaveBeenCalledWith(
          expect.objectContaining({
            width: 852,
            height: 393,
            preset: "iphone-17",
            mobile: true,
            deviceScaleFactor: 3,
          }),
          null,
        );
      });
    });
  });

  describe("letterbox", () => {
    it("tells main how far it had to shrink the device to fit", async () => {
      const { api, emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await waitFor(() => {
        expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({ scale: 1 }), null);
      });

      emit({
        type: "status",
        status: statusWith({
          tabs: [{
            ...browserStatus.tabs[0],
            emulation: {
              presetId: "iphone-17",
              label: "iPhone 17",
              width: 393,
              height: 852,
              deviceScaleFactor: 3,
              mobile: true,
              hasTouch: true,
              userAgent: "iphone",
            },
          }],
        }),
      });

      // The stage is 640×360 here, so an 852-tall phone cannot be shown at 1:1.
      // Main needs the factor, or it draws the page at full size into a view
      // that is too small and crops it.
      await waitFor(() => {
        const scales = api.setBounds.mock.calls.map(([args]: [{ scale?: number }]) => args.scale);
        expect(scales.some((scale) => scale != null && scale < 1)).toBe(true);
      });
      expect(await screen.findByTestId("browser-emulation-caption")).toHaveProperty(
        "textContent",
        expect.stringContaining("fit "),
      );
    });
  });

  describe("no tabs", () => {
    it("stops describing the page that was closed", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      const urlInput = await screen.findByLabelText("ADE browser URL") as HTMLInputElement;
      await waitFor(() => expect(urlInput.value).toBe("https://example.test/"));

      emit({ type: "status", status: statusWith({ tabs: [], activeTabId: null }) });

      await waitFor(() => expect(urlInput.value).toBe(""));
      expect(urlInput.getAttribute("placeholder")).toBe("Search or enter address");
      // No page, so no claim about its connection and nothing to act on.
      expect(screen.queryByLabelText("Secure connection")).toBeNull();
      expect(screen.getByLabelText("Go back")).toHaveProperty("disabled", true);
      expect(screen.getByLabelText("Reload")).toHaveProperty("disabled", true);
      expect(screen.getByLabelText("Screenshot · Shift-click to record")).toHaveProperty("disabled", true);
      expect(screen.getByLabelText("Select an element in the ADE browser")).toHaveProperty("disabled", true);
      expect(screen.getByLabelText("Browser device preset — Desktop")).toHaveProperty("disabled", true);
      expect(await screen.findByTestId("browser-launchpad")).toBeTruthy();
    });
  });

  describe("load progress", () => {
    it("shows a bar while the tab is loading, from the per-tab flag", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      await screen.findByTestId("browser-toolbar-row");
      expect(screen.queryByTestId("browser-load-progress")).toBeNull();

      // `did-start-loading` updates the tab, not a top-level flag — reading
      // only the latter is why the bar never appeared.
      emit({
        type: "status",
        status: statusWith({ tabs: [{ ...browserStatus.tabs[0], isLoading: true }] }),
      });

      expect(await screen.findByTestId("browser-load-progress")).toBeTruthy();
      expect(screen.getByLabelText("Stop loading")).toBeTruthy();
    });
  });

  describe("launchpad", () => {
    it("does not wear the previous tab's padlock on a blank new tab", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      const urlInput = await screen.findByLabelText("ADE browser URL") as HTMLInputElement;
      await waitFor(() => expect(urlInput.value).toBe("https://example.test/"));
      expect(screen.getByLabelText("Secure connection")).toBeTruthy();

      emit({
        type: "status",
        status: statusWith({
          activeTabId: "tab-2",
          url: null,
          tabs: [
            browserStatus.tabs[0],
            makeBuiltInBrowserTab({ id: "tab-2", url: null, title: null, isLaunchpad: true }),
          ],
        }),
      });

      await waitFor(() => expect(urlInput.value).toBe(""));
      // The address bar is empty, so there is no connection to make a claim about.
      expect(screen.queryByLabelText("Secure connection")).toBeNull();
      expect(await screen.findByTestId("browser-launchpad")).toBeTruthy();
    });

    it("asks for dev servers by lane, which is the only scope the detector filters on", async () => {
      const { api } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);

      // `browserScope` is `{projectRoot} | {tabCollection} | {}` and never
      // carries a laneId, so the registry's lane filter never ran. Discovery is
      // also a fact about THIS machine's PTYs, so it takes no runtime pin.
      await waitFor(() => expect(api.getDevServers).toHaveBeenCalled());
      const [args, ...rest] = api.getDevServers.mock.calls[0];
      expect(args).toHaveProperty("laneId");
      expect(args).not.toHaveProperty("projectRoot");
      expect(rest).toEqual([]);
    });

    it("probes the usual ports when discovery comes back empty", async () => {
      const { api, emit } = installBrowserApi();
      api.getDevServers.mockResolvedValue([]);
      (window as unknown as { ade: { localhost: { probePort: ReturnType<typeof vi.fn> } } })
        .ade.localhost.probePort.mockImplementation(async (port: number) => port === 5173);

      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      // Wait for the mounted status before replacing it, or the initial read
      // lands afterwards and puts the tab back.
      await screen.findByRole("tab");
      emit({ type: "status", status: statusWith({ tabs: [], activeTabId: null }) });

      await screen.findByTestId("browser-launchpad");
      // A dev server the human started outside ADE has no command to name it,
      // so it says what it honestly is.
      expect(await screen.findByText("localhost:5173")).toBeTruthy();
    });

    it("prefers the command that opened the port when discovery knows it", async () => {
      const { emit } = installBrowserApi();
      render(<ChatBuiltInBrowserPanel sessionId="chat-1" />);
      // Wait for the mounted status before replacing it, or the initial read
      // lands afterwards and puts the tab back.
      await screen.findByRole("tab");
      emit({ type: "status", status: statusWith({ tabs: [], activeTabId: null }) });

      await screen.findByTestId("browser-launchpad");
      expect(await screen.findByText("npm run dev · :5173")).toBeTruthy();
    });
  });
});
