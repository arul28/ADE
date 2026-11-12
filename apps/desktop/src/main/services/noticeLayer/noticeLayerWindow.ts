/**
 * The notice layer's window, main-process side (see `shared/noticeLayer.ts`).
 *
 * The ADE window's renderer opens it with `window.open`, because only a window
 * it opens itself shares its process and DOM: React portals the corner cards
 * straight into it, so they keep their state, handlers and animations. This
 * module is the gate and the placement:
 *
 * - the app renderer may open exactly one window, an `about:blank` under the
 *   layer's name; every other `window.open` is denied, as before;
 * - the layer is a borderless, see-through child of the ADE window that never
 *   takes focus, so a click on a card leaves typing where it was;
 * - the renderer says where the cards are, in its own pixels, and the layer is
 *   placed over that box in screen pixels, again whenever the ADE window
 *   moves or resizes.
 */
import type { BrowserWindow, BrowserWindowConstructorOptions, HandlerDetails } from "electron";
import { NOTICE_LAYER_FRAME_NAME, type NoticeLayerRect } from "../../../shared/noticeLayer";

type LayerState = {
  layer: BrowserWindow | null;
  /** The last box the renderer asked for, reapplied when the ADE window moves. */
  rect: NoticeLayerRect | null;
};

const layers = new WeakMap<BrowserWindow, LayerState>();

/** The largest box the renderer may ask for; the corner stack is far smaller. */
const MAX_LAYER_SIDE_PX = 4_000;

function layerOptions(parent: BrowserWindow): BrowserWindowConstructorOptions {
  return {
    parent,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // Never key: a click on a card must not pull typing out of the page or
    // the composer. `acceptFirstMouse` lets that first click press the button.
    focusable: false,
    acceptFirstMouse: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
}

function isLayerRequest(details: Pick<HandlerDetails, "frameName" | "url">): boolean {
  return details.frameName === NOTICE_LAYER_FRAME_NAME && (details.url === "" || details.url === "about:blank");
}

function clampRect(rect: NoticeLayerRect | null): NoticeLayerRect | null {
  if (!rect) return null;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  const width = Math.round(Math.min(MAX_LAYER_SIDE_PX, rect.width));
  const height = Math.round(Math.min(MAX_LAYER_SIDE_PX, rect.height));
  if (width < 1 || height < 1) return null;
  return { x: Math.round(rect.x), y: Math.round(rect.y), width, height };
}

function applyPlacement(parent: BrowserWindow, state: LayerState): void {
  const layer = state.layer;
  if (!layer || layer.isDestroyed()) return;
  const rect = state.rect;
  const parentShown = !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized();
  if (!rect || !parentShown) {
    if (layer.isVisible()) layer.hide();
    return;
  }
  // The renderer measures in its own pixels; its zoom is folded in already.
  const content = parent.getContentBounds();
  const zoom = parent.webContents.getZoomFactor();
  if (layer.webContents.getZoomFactor() !== zoom) layer.webContents.setZoomFactor(zoom);
  layer.setBounds({
    x: content.x + rect.x,
    y: content.y + rect.y,
    width: rect.width,
    height: rect.height,
  });
  if (!layer.isVisible()) layer.showInactive();
}

/**
 * Replace the ADE window's "deny every window" handler with one that also
 * lets the notice layer through, and keep the layer placed.
 */
export function installNoticeLayer(parent: BrowserWindow): void {
  const state: LayerState = { layer: null, rect: null };
  layers.set(parent, state);

  parent.webContents.setWindowOpenHandler((details) => {
    if (!isLayerRequest(details)) return { action: "deny" };
    return { action: "allow", outlivesOpener: false, overrideBrowserWindowOptions: layerOptions(parent) };
  });

  parent.webContents.on("did-create-window", (child, details) => {
    if (!isLayerRequest(details)) {
      child.destroy();
      return;
    }
    // One layer per window: a new one (the renderer closed the old one and
    // opened another before the old one was gone) replaces it.
    const previous = state.layer;
    if (previous && previous !== child && !previous.isDestroyed()) previous.destroy();
    state.layer = child;
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event) => event.preventDefault());
    child.on("closed", () => {
      if (state.layer === child) state.layer = null;
    });
    applyPlacement(parent, state);
  });

  const replace = () => applyPlacement(parent, state);
  for (const event of ["move", "resize", "show", "hide", "minimize", "restore", "enter-full-screen", "leave-full-screen"] as const) {
    parent.on(event as "move", replace);
  }
  // A reload drops the opener's portal; the next render opens the layer again.
  parent.webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    const layer = state.layer;
    state.layer = null;
    state.rect = null;
    if (layer && !layer.isDestroyed()) layer.destroy();
  });
}

/** Place the sender window's layer over `rect`, or hide it. False when it has none. */
export function placeNoticeLayer(parent: BrowserWindow, rect: NoticeLayerRect | null): boolean {
  const state = layers.get(parent);
  if (!state) return false;
  state.rect = clampRect(rect);
  applyPlacement(parent, state);
  return Boolean(state.layer && !state.layer.isDestroyed());
}
