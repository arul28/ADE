import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { NOTICE_LAYER_FRAME_NAME } from "../../../shared/noticeLayer";
import { installNoticeLayer } from "./noticeLayerWindow";

type OpenHandler = (details: { frameName: string; url: string }) => {
  action: "allow" | "deny";
  overrideBrowserWindowOptions?: Record<string, unknown>;
};

/** The parts of an ADE window the gate touches: its open handler and its events. */
function fakeParentWindow() {
  let openHandler: OpenHandler | null = null;
  const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
  const parent = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    getContentBounds: () => ({ x: 100, y: 50, width: 1200, height: 800 }),
    on: vi.fn(),
    webContents: {
      setWindowOpenHandler: (handler: OpenHandler) => {
        openHandler = handler;
      },
      on: (event: string, listener: (...args: unknown[]) => void) => {
        webContentsListeners.set(event, listener);
      },
      getZoomFactor: () => 1,
    },
  };
  return {
    parent: parent as unknown as BrowserWindow,
    open: (details: { frameName: string; url: string }) => openHandler!(details),
    createWindow: (child: unknown, details: { frameName: string; url: string }) =>
      webContentsListeners.get("did-create-window")!(child, details),
  };
}

function fakeChildWindow() {
  return {
    destroy: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => false,
    on: vi.fn(),
    hide: vi.fn(),
    setBounds: vi.fn(),
    showInactive: vi.fn(),
    webContents: {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      getZoomFactor: () => 1,
      setZoomFactor: vi.fn(),
    },
  };
}

describe("notice layer window gate", () => {
  it("lets the app renderer open only its blank notice layer, as a window that never takes focus", () => {
    const { parent, open, createWindow } = fakeParentWindow();
    installNoticeLayer(parent);

    // Everything the renderer could ask for besides the layer stays denied, as
    // the app's window.open gate always was.
    for (const details of [
      { frameName: "", url: "https://example.test" },
      { frameName: "anything", url: "about:blank" },
      { frameName: NOTICE_LAYER_FRAME_NAME, url: "https://example.test" },
      { frameName: NOTICE_LAYER_FRAME_NAME, url: "file:///etc/passwd" },
    ]) {
      expect(open(details).action, JSON.stringify(details)).toBe("deny");
    }

    const allowed = open({ frameName: NOTICE_LAYER_FRAME_NAME, url: "about:blank" });
    expect(allowed.action).toBe("allow");
    expect(allowed.overrideBrowserWindowOptions).toMatchObject({
      parent,
      focusable: false,
      transparent: true,
      frame: false,
      show: false,
    });

    // A window that is not the layer is destroyed on arrival; the layer itself
    // may open nothing and navigate nowhere.
    const stray = fakeChildWindow();
    createWindow(stray, { frameName: "anything", url: "about:blank" });
    expect(stray.destroy).toHaveBeenCalled();

    const layer = fakeChildWindow();
    createWindow(layer, { frameName: NOTICE_LAYER_FRAME_NAME, url: "about:blank" });
    expect(layer.destroy).not.toHaveBeenCalled();
    const layerOpenHandler = layer.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as (() => { action: string }) | undefined;
    expect(layerOpenHandler?.().action).toBe("deny");
    expect(layer.webContents.on).toHaveBeenCalledWith("will-navigate", expect.any(Function));
  });
});
