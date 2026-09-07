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
      },
    },
  });
  return {
    api,
    emit: (event: unknown) => eventListener?.(event),
  };
}

beforeEach(() => {
  nextFrameId = 0;
  nextFrameNow = 0;
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

    fireEvent.click(await screen.findByText("Profile"));

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

    fireEvent.click(await screen.findByText("Screenshot"));

    await waitFor(() => expect(api.captureScreenshot).toHaveBeenCalled());
    expect(await screen.findByText("Drag a browser region to attach the screenshot crop and nearby page context.")).toBeTruthy();
    expect(screen.getByText("Cancel screenshot")).toBeTruthy();

    fireEvent.click(screen.getByText("Cancel screenshot"));

    expect(await screen.findByText("Browser screenshot capture cancelled.")).toBeTruthy();
    expect(screen.getByText("Screenshot")).toBeTruthy();
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
});
