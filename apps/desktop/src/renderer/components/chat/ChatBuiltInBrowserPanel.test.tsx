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

function installBrowserApi() {
  let eventListener: ((event: unknown) => void) | null = null;
  const api = {
    getStatus: vi.fn().mockResolvedValue(browserStatus),
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

  it("routes personal chat browser calls to the personal tab collection", async () => {
    const { api } = installBrowserApi();

    render(<ChatBuiltInBrowserPanel sessionId="personal-chat-1" projectRootOverride={null} />);

    await waitFor(() => {
      expect(api.getStatus).toHaveBeenCalledWith({ tabCollection: "personal" });
      expect(api.setBounds).toHaveBeenCalledWith(expect.objectContaining({
        tabCollection: "personal",
      }));
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
      }));
    });

    window.dispatchEvent(new Event(ADE_WORK_SIDEBAR_BROWSER_RESIZE_START_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }));
    });

    window.dispatchEvent(new Event(ADE_WORK_SIDEBAR_BROWSER_RESIZE_END_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }));
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
      }));
    });

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: false,
      }));
    });

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_START_EVENT));
    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));

    expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
      width: 640,
      height: 360,
      visible: false,
    }));

    window.dispatchEvent(new Event(ADE_BROWSER_VIEW_OCCLUSION_END_EVENT));

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }));
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
      }));
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
      }));
    });

    overlay.remove();

    await waitFor(() => {
      expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
        width: 640,
        height: 360,
        visible: true,
      }));
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
      }));
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
        }));
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
        }));
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
        }));
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
        }));
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
        }));
      });
      expect(api.setBounds).not.toHaveBeenLastCalledWith(expect.objectContaining({ visible: false }));

      overlayOverlapsBrowser = true;
      overlay.dispatchEvent(new Event("transitionend", { bubbles: true }));

      await waitFor(() => {
        expect(api.setBounds).toHaveBeenLastCalledWith(expect.objectContaining({
          width: 640,
          height: 360,
          visible: false,
        }));
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
