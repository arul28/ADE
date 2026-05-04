/* @vitest-environment jsdom */

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatBuiltInBrowserPanel } from "./ChatBuiltInBrowserPanel";
import {
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
});
