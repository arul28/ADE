/**
 * The ADE Cloud iPhone's picture, rendered on this desktop.
 *
 * The account server gives a control-view link whose page paints the running
 * phone into one canvas and accepts mouse input: NoMac's page, or ADE's own
 * viewer page for a Revyl phone (`/cloud/phone/viewer`, the same canvas,
 * "Home" button and "not running" text). That page is a normal web page, so this host
 * keeps one OFFSCREEN `BrowserWindow` per open view: the page paints at 30 Hz
 * even when idle, and each painted frame is cropped to the canvas and sent to
 * the renderer that asked. Nothing is ever shown, focused or logged with its
 * URL: the link carries a viewer token and is a credential.
 *
 * The crop is measured, never assumed. The page moves its phone up once the
 * viewer takes control, so the canvas rect is re-read after the control click
 * and on a slow interval. Input travels the other way in DEVICE POINTS (the
 * phone's own coordinate space) and is mapped through the current rect.
 */

import { randomUUID } from "node:crypto";
import { app, BrowserWindow, type NativeImage, type Rectangle, type WebContents } from "electron";

import { IPC } from "../../../shared/ipc";
import type {
  CloudPhoneViewDeviceFamily,
  CloudPhoneViewFrame,
  CloudPhoneViewInputArgs,
  CloudPhoneViewKeyArgs,
  CloudPhoneViewOpenArgs,
  CloudPhoneViewScrollArgs,
  CloudPhoneViewState,
  CloudPhoneViewStateEvent,
} from "../../../shared/types/cloudPhoneView";
import type { Logger } from "../logging/logger";
import { CLOUD_PHONE_MODELS } from "../../../shared/cloudPhone";
import { DEFAULT_ADE_ACCOUNT_DIRECTORY_URL, DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL } from "../../../shared/accountDirectory";
import { isLoopbackHost } from "../../../shared/passwordFillTarget";
import { CLOUD_PATHS } from "../../../../../account-directory/src/cloud/contract";

type Point = { width: number; height: number };

/** The canvas's CSS rect, plus the viewport it was measured in. */
type CanvasMeasure = {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
};

type View = {
  id: string;
  window: BrowserWindow;
  /** The renderer that opened this view; frames and states go only to it. */
  sender: WebContents;
  /** Removed when the view closes, so re-opening views does not stack listeners. */
  onSenderDestroyed: () => void;
  /** The screen in points, which input arrives in. */
  points: Point;
  /** Painted frames in a row that matched the last one sent: past a threshold the page paints slower. */
  unchanged: number;
  /** The page paints at the idle rate (`IDLE_FPS`) until something changes. */
  slowed: boolean;
  /** Input goes through the page's own debugger (`Input.dispatch*`, CSS pixels) once it is attached. */
  debuggerAttached: boolean;
  /** A press is down: moves carry the left button. */
  pressed: boolean;
  /** Null until the page's canvas has been measured. */
  canvas: CanvasMeasure | null;
  /** The last frame sent, for the sampled-hash dedupe. */
  lastFrame: { width: number; height: number; samples: Uint8Array } | null;
  lastSentAt: number;
  firstFrameSent: boolean;
  hidden: boolean;
  closed: boolean;
  state: CloudPhoneViewState | null;
  timers: Set<NodeJS.Timeout>;
};

export type CloudPhoneViewHost = {
  open: (args: CloudPhoneViewOpenArgs & { sender: WebContents }) => { viewId: string };
  close: (args: { viewId: string }) => void;
  input: (args: CloudPhoneViewInputArgs) => void;
  scroll: (args: CloudPhoneViewScrollArgs) => void;
  key: (args: CloudPhoneViewKeyArgs) => void;
  home: (args: { viewId: string }) => void;
  setHidden: (args: { viewId: string; hidden: boolean }) => void;
  /** App quit: no offscreen page outlives ADE. */
  closeAll: () => void;
};

/**
 * Only these pages are a control view; everything else is refused before a
 * window is made: NoMac's view page, and ADE's own viewer page (Revyl's phone),
 * served by ADE's account server (a local one only in a development build).
 */
const CONTROL_VIEW_PREFIX = "https://nomac.app/simulator-use/view/";
const CONTROL_VIEW_PATH = "/simulator-use/view/";
const NOMAC_HOST = "nomac.app";
const ADE_VIEWER_ORIGINS = new Set([DEFAULT_ADE_ACCOUNT_DIRECTORY_URL, DEVELOPMENT_ADE_ACCOUNT_DIRECTORY_URL].map((raw) => new URL(raw).origin));

/** 1.5× the page's 402×874 layout, so the texture is sharp on a 3D body. */
const WINDOW_SIZE: Record<CloudPhoneViewDeviceFamily, Point> = {
  iphone: { width: 603, height: 1311 },
  ipad: { width: 1001, height: 1452 },
};

/** The phone's own coordinate space when the opener names none (`CLOUD_PHONE_MODELS`). */
const DEVICE_POINTS: Record<CloudPhoneViewDeviceFamily, Point> = {
  iphone: CLOUD_PHONE_MODELS.iphone.points,
  ipad: CLOUD_PHONE_MODELS.ipad.points,
};

const OFFSCREEN_FPS = 30;
/**
 * The page repaints its canvas every frame even when nothing moved, and each
 * paint is cropped and hashed here. After this many unchanged paints in a row
 * (about 2 s) it paints at `IDLE_FPS` until a frame changes or input arrives,
 * so an idle phone costs a few paints a second instead of 30.
 */
const UNCHANGED_BEFORE_IDLE = 60;
const IDLE_FPS = 4;
/** One 30 Hz tick. A paint that lands a hair early is skipped once, then the cadence catches up. */
const FRAME_INTERVAL_MS = 1_000 / OFFSCREEN_FPS;
/** The page moves its phone up when the viewer takes control; re-measure after that. */
const CONTROL_SETTLE_MS = 1_200;
const CONTROL_RETRY_MS = 500;
const CONTROL_ATTEMPTS = 20;
/** The canvas moves when the page relayouts, so never trust the first measurement. */
const RECT_POLL_MS = 2_000;
/** How often the page text is read for "the phone ended". */
const END_POLL_MS = 5_000;
/**
 * Dedupe samples one byte in this many of the cropped bitmap, each with its
 * low 3 bits dropped: the phone arrives as H.264, and a still screen decodes
 * with small noise that must not count as a change.
 */
const HASH_STRIDE = 31;
/** A still picture is sent again this often anyway, so a change too small for the hash shows within a second. */
const KEYFRAME_MS = 1_000;
/** A sampled byte moved by more than this is a real change, not decoding noise. */
const NOISE_LEVEL = 24;
/** More than this many moved samples is a changed picture (a caret, a tap highlight). */
const CHANGED_SAMPLES = 6;
const JPEG_QUALITY = 82;

const MEASURE_CANVAS_JS = `(() => {
  const canvas = document.querySelector("canvas");
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return null;
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
})()`;

/** Clicks the control button, or reports that the viewer already has control. */
const TAKE_CONTROL_JS = `(() => {
  const buttons = Array.from(document.querySelectorAll("button"));
  const text = (button) => (button.textContent || "").trim().toLowerCase();
  const control = buttons.find((button) => text(button) === "take control");
  if (control) { control.click(); return "clicked"; }
  if (buttons.some((button) => text(button) === "let go")) return "controlled";
  return "missing";
})()`;

const PAGE_TEXT_JS = `(() => (document.body ? document.body.innerText : ""))()`;

function buttonScript(label: string): string {
  return `(() => {
    const wanted = ${JSON.stringify(label)};
    const button = Array.from(document.querySelectorAll("button"))
      .find((element) => (element.textContent || "").trim().toLowerCase() === wanted);
    if (!button) return false;
    button.click();
    return true;
  })()`;
}

/** ADE's own viewer page on ADE's account server (a local server only in a development build). */
function isAdeViewerPage(url: URL): boolean {
  if (url.pathname !== CLOUD_PATHS.phoneViewer || url.username || url.password) return false;
  if (url.protocol === "https:" && ADE_VIEWER_ORIGINS.has(url.origin)) return true;
  return !app.isPackaged && url.protocol === "http:" && isLoopbackHost(url.hostname);
}

/** The control link, normalized, or null when it is anything else. Never log the result. */
function readControlViewUrl(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    if (isAdeViewerPage(url)) return url.toString();
    if (!trimmed.startsWith(CONTROL_VIEW_PREFIX)) return null;
    return url.protocol === "https:" && url.hostname === NOMAC_HOST && url.pathname.startsWith(CONTROL_VIEW_PATH)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/** A page the viewer may navigate to: the control site, or ADE's viewer page. */
function isControlPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "https:" && url.hostname === NOMAC_HOST) || isAdeViewerPage(url);
  } catch {
    return false;
  }
}

/** A point size the renderer sent, when it is a sane one. */
function readPoints(raw: unknown): Point | null {
  if (!raw || typeof raw !== "object") return null;
  const { width, height } = raw as Record<string, unknown>;
  return typeof width === "number" && typeof height === "number" && width >= 100 && width <= 2000 && height >= 100 && height <= 3000
    ? { width, height }
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function readMeasure(raw: unknown): CanvasMeasure | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const numbers = ["x", "y", "width", "height", "viewportWidth", "viewportHeight"] as const;
  for (const key of numbers) {
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) return null;
  }
  const measure = record as CanvasMeasure;
  return measure.width > 0 && measure.height > 0 && measure.viewportWidth > 0 && measure.viewportHeight > 0
    ? measure
    : null;
}

/** Every `HASH_STRIDE`th byte of the cropped bitmap: what the next paint is compared with. */
function sampleBitmap(bytes: Buffer): Uint8Array {
  const samples = new Uint8Array(Math.ceil(bytes.length / HASH_STRIDE));
  for (let index = 0, out = 0; index < bytes.length; index += HASH_STRIDE, out += 1) samples[out] = bytes[index]!;
  return samples;
}

/**
 * Whether two samplings show the same picture: H.264 decodes a still screen
 * with small noise, so only bytes that moved by more than `NOISE_LEVEL` count,
 * and only more than `CHANGED_SAMPLES` of them make a change.
 */
function samePicture(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let moved = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (Math.abs(left[index]! - right[index]!) > NOISE_LEVEL && ++moved > CHANGED_SAMPLES) return false;
  }
  return true;
}

/** The crop in the painted image's pixels, clamped so `NativeImage.crop` never throws. */
function cropFor(measure: CanvasMeasure, imageSize: { width: number; height: number }): Rectangle | null {
  const scaleX = imageSize.width / measure.viewportWidth;
  const scaleY = imageSize.height / measure.viewportHeight;
  const left = clamp(Math.round(measure.x * scaleX), 0, imageSize.width - 1);
  const top = clamp(Math.round(measure.y * scaleY), 0, imageSize.height - 1);
  const right = clamp(Math.round((measure.x + measure.width) * scaleX), left + 1, imageSize.width);
  const bottom = clamp(Math.round((measure.y + measure.height) * scaleY), top + 1, imageSize.height);
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { x: left, y: top, width, height } : null;
}

/** The hidden offscreen windows that paint phones: never an ADE window. */
const phoneWindows = new WeakSet<BrowserWindow>();

/**
 * True for a window that only paints a cloud iPhone offscreen. `main.ts`
 * leaves these out wherever it counts or picks ADE's own windows.
 */
export function isCloudPhoneViewWindow(win: BrowserWindow): boolean {
  return phoneWindows.has(win);
}

export function createCloudPhoneViewHost(args: { logger: Logger }): CloudPhoneViewHost {
  const { logger } = args;
  const views = new Map<string, View>();

  const clearTimers = (view: View): void => {
    for (const timer of view.timers) clearInterval(timer);
    view.timers.clear();
  };

  const schedule = (view: View, run: () => void, delayMs: number): void => {
    const timer = setTimeout(() => {
      view.timers.delete(timer);
      if (!view.closed) run();
    }, delayMs);
    view.timers.add(timer);
  };

  const repeat = (view: View, run: () => void, everyMs: number): void => {
    const timer = setInterval(() => {
      if (!view.closed) run();
    }, everyMs);
    view.timers.add(timer);
  };

  const emitState = (view: View, state: CloudPhoneViewState, message?: string): void => {
    if (view.closed || view.sender.isDestroyed()) return;
    view.state = state;
    const event: CloudPhoneViewStateEvent = {
      viewId: view.id,
      state,
      ...(message ? { message } : {}),
    };
    try {
      view.sender.send(IPC.cloudPhoneViewState, event);
    } catch {
      // The renderer went away between the check and the send.
    }
  };

  const dispose = (view: View): void => {
    if (view.closed) return;
    view.closed = true;
    clearTimers(view);
    if (view.debuggerAttached && !view.window.isDestroyed()) {
      try { view.window.webContents.debugger.detach(); } catch { /* already gone */ }
    }
    try {
      view.sender.removeListener("destroyed", view.onSenderDestroyed);
    } catch {
      // The renderer is already gone; there is no listener left to remove.
    }
    views.delete(view.id);
    if (!view.window.isDestroyed()) view.window.destroy();
  };

  const closeView = (viewId: string): void => {
    const view = views.get(viewId);
    if (view) dispose(view);
  };

  const fail = (view: View, message: string): void => {
    if (view.closed || view.state === "error" || view.state === "ended") return;
    logger.warn("cloud.phone_view_failed", { viewId: view.id, reason: message });
    emitState(view, "error", message);
    clearTimers(view);
    if (!view.window.isDestroyed()) view.window.webContents.stopPainting();
  };

  const measureCanvas = (view: View): void => {
    if (view.closed || view.window.isDestroyed()) return;
    void view.window.webContents
      .executeJavaScript(MEASURE_CANVAS_JS, false)
      .then((raw: unknown) => {
        const measure = readMeasure(raw);
        // A page that has not drawn its canvas yet is measured by the next poll.
        if (measure) view.canvas = measure;
      })
      .catch(() => {});
  };

  const pollEnded = (view: View): void => {
    if (view.closed || view.window.isDestroyed() || view.state === "ended") return;
    void view.window.webContents
      .executeJavaScript(PAGE_TEXT_JS, false)
      .then((raw: unknown) => {
        if (view.closed || view.state === "ended" || typeof raw !== "string") return;
        // NoMac's page says "The phone is not running any more" (also "ended" / "stopped" in other states).
        if (!/not running|ended|stopped/i.test(raw)) return;
        emitState(view, "ended");
        clearTimers(view);
        if (!view.window.isDestroyed()) view.window.webContents.stopPainting();
      })
      .catch(() => {});
  };

  /**
   * Click "Take control" once the page has one. The button is not always there
   * immediately, and it says "Let go" when this viewer already has control, so
   * the script reports either state and a miss is retried briefly.
   */
  const takeControl = (view: View, attempt = 0): void => {
    if (view.closed || view.window.isDestroyed()) return;
    void view.window.webContents
      .executeJavaScript(TAKE_CONTROL_JS, true)
      .then((result: unknown) => {
        if (view.closed) return;
        if (result === "clicked" || result === "controlled") {
          measureCanvas(view);
          schedule(view, () => measureCanvas(view), CONTROL_SETTLE_MS);
          return;
        }
        if (attempt < CONTROL_ATTEMPTS) {
          schedule(view, () => takeControl(view, attempt + 1), CONTROL_RETRY_MS);
        }
      })
      .catch(() => {});
  };

  /** A change or input: paint at the full rate again. */
  const wake = (view: View): void => {
    view.unchanged = 0;
    if (!view.slowed || view.window.isDestroyed()) return;
    view.slowed = false;
    view.window.webContents.setFrameRate(OFFSCREEN_FPS);
  };

  const handlePaint = (view: View, image: NativeImage): void => {
    if (view.closed || view.state === "ended" || view.hidden) return;
    if (view.sender.isDestroyed()) {
      // The window that asked for this picture is gone: nothing to stream to.
      dispose(view);
      return;
    }
    const now = Date.now();
    if (now - view.lastSentAt < FRAME_INTERVAL_MS) return;
    if (!view.canvas) return;
    const rect = cropFor(view.canvas, image.getSize());
    if (!rect) return;

    let cropped: NativeImage;
    try {
      cropped = image.crop(rect);
    } catch {
      return;
    }
    if (cropped.isEmpty()) return;

    // The page repaints its canvas every frame even when nothing moved, so the
    // sampled comparison is what keeps an idle phone from sending 30 JPEGs a second.
    const samples = sampleBitmap(cropped.toBitmap());
    const last = view.lastFrame;
    const still = Boolean(last && last.width === rect.width && last.height === rect.height && samePicture(last.samples, samples));
    if (still && now - view.lastSentAt < KEYFRAME_MS) {
      view.unchanged += 1;
      if (!view.slowed && view.unchanged >= UNCHANGED_BEFORE_IDLE) {
        view.slowed = true;
        view.window.webContents.setFrameRate(IDLE_FPS);
      }
      return;
    }
    if (!still) wake(view);

    const jpeg = cropped.toJPEG(JPEG_QUALITY);
    if (jpeg.length === 0) return;

    view.lastSentAt += FRAME_INTERVAL_MS;
    if (now - view.lastSentAt >= FRAME_INTERVAL_MS) {
      // A pause (hidden, or a view just opened) is not a burst to catch up on.
      view.lastSentAt = now;
    }
    // A keyframe of a still picture keeps the reference it was compared with, so slow drift still adds up to a change.
    if (!still || !last) view.lastFrame = { width: rect.width, height: rect.height, samples };
    const frame: CloudPhoneViewFrame = {
      viewId: view.id,
      jpeg,
      width: rect.width,
      height: rect.height,
    };
    try {
      view.sender.send(IPC.cloudPhoneViewFrame, frame);
    } catch {
      dispose(view);
      return;
    }
    if (!view.firstFrameSent) {
      view.firstFrameSent = true;
      emitState(view, "live");
    }
  };

  const mapPoint = (view: View, x: number, y: number): { x: number; y: number } | null => {
    const rect = view.canvas;
    if (!rect || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Input means the picture is about to move: back to the full rate.
    wake(view);
    const points = view.points;
    const fractionX = clamp(x / points.width, 0, 1);
    const fractionY = clamp(y / points.height, 0, 1);
    return {
      x: Math.round(rect.x + fractionX * rect.width),
      y: Math.round(rect.y + fractionY * rect.height),
    };
  };

  const open = (openArgs: CloudPhoneViewOpenArgs & { sender: WebContents }): { viewId: string } => {
    const url = readControlViewUrl(openArgs.url);
    if (!url) throw new Error("That link isn't an ADE Cloud iPhone view link.");
    if (openArgs.deviceFamily !== "iphone" && openArgs.deviceFamily !== "ipad") {
      throw new Error("That device type can't be shown here.");
    }
    const size = WINDOW_SIZE[openArgs.deviceFamily];

    const id = randomUUID();
    const window = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      webPreferences: {
        // In-memory only: a viewer token is a credential and nothing about the
        // page should outlive the view.
        partition: "cloud-phone-view",
        offscreen: true,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    phoneWindows.add(window);
    const view: View = {
      id,
      window,
      sender: openArgs.sender,
      onSenderDestroyed: () => closeView(id),
      points: readPoints(openArgs.pointSize) ?? DEVICE_POINTS[openArgs.deviceFamily],
      unchanged: 0,
      slowed: false,
      debuggerAttached: false,
      pressed: false,
      canvas: null,
      lastFrame: null,
      lastSentAt: 0,
      firstFrameSent: false,
      hidden: false,
      closed: false,
      state: null,
      timers: new Set(),
    };
    views.set(id, view);

    const contents = window.webContents;
    contents.setFrameRate(OFFSCREEN_FPS);
    // `sendInputEvent` on an offscreen window lands off target on a scaled
    // display (measured: aimed at 294,469, arrived at 447,544). The page's own
    // debugger takes CSS pixels, the space the canvas is measured in.
    try {
      contents.debugger.attach("1.3");
      view.debuggerAttached = true;
    } catch (error) {
      logger.warn("cloud.phone_view_debugger_unavailable", { viewId: id, error: error instanceof Error ? error.message : String(error) });
    }
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    contents.on("will-navigate", (event, next) => {
      if (!isControlPage(next)) event.preventDefault();
    });
    contents.on("will-redirect", (event, next) => {
      if (!isControlPage(next)) event.preventDefault();
    });
    contents.on("paint", (_details, _dirty, image) => handlePaint(view, image));
    contents.on("did-finish-load", () => {
      measureCanvas(view);
      takeControl(view);
    });
    contents.on("did-fail-load", (_event, errorCode, description, _validatedUrl, isMainFrame) => {
      // -3 is ERR_ABORTED, which a close or a redirect produces.
      if (!isMainFrame || errorCode === -3) return;
      fail(view, description || "The phone's page didn't load.");
    });
    contents.on("render-process-gone", (_event, details) => {
      fail(view, `The phone's page stopped (${details.reason}).`);
    });
    contents.once("destroyed", () => dispose(view));
    // The window that asked for this view went away: stop painting its phone.
    openArgs.sender.once("destroyed", view.onSenderDestroyed);

    repeat(view, () => measureCanvas(view), RECT_POLL_MS);
    repeat(view, () => pollEnded(view), END_POLL_MS);

    emitState(view, "loading");
    logger.info("cloud.phone_view_opened", { viewId: id, deviceFamily: openArgs.deviceFamily });
    void contents.loadURL(url).catch(() => {
      fail(view, "The phone's page didn't open.");
    });
    return { viewId: id };
  };

  /** One debugger command; a failure falls back to `sendInputEvent` once and is logged. */
  const dispatch = (view: View, method: string, params: Record<string, unknown>, fallback: () => void): void => {
    if (!view.debuggerAttached) {
      fallback();
      return;
    }
    void view.window.webContents.debugger.sendCommand(method, params).catch((error: unknown) => {
      logger.warn("cloud.phone_view_input_failed", { viewId: view.id, method, error: error instanceof Error ? error.message : String(error) });
    });
  };

  const input = (inputArgs: CloudPhoneViewInputArgs): void => {
    const view = views.get(inputArgs.viewId);
    if (!view || view.closed || view.window.isDestroyed()) {
      if (inputArgs.phase === "begin") logger.info("cloud.phone_view_press_no_view", { viewId: inputArgs.viewId, open: views.size });
      return;
    }
    const point = mapPoint(view, inputArgs.x, inputArgs.y);
    if (!point) {
      if (inputArgs.phase === "begin") logger.info("cloud.phone_view_press_unmapped", { viewId: view.id, measured: view.canvas != null });
      return;
    }
    const contents = view.window.webContents;
    if (inputArgs.phase === "begin") {
      view.pressed = true;
      dispatch(view, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 },
        () => contents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 }));
    } else if (inputArgs.phase === "move") {
      dispatch(view, "Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: view.pressed ? "left" : "none", buttons: view.pressed ? 1 : 0 },
        () => contents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y, button: "left" }));
    } else if (inputArgs.phase === "end") {
      view.pressed = false;
      dispatch(view, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 },
        () => contents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 }));
    }
  };

  const scroll = (scrollArgs: CloudPhoneViewScrollArgs): void => {
    const view = views.get(scrollArgs.viewId);
    if (!view || view.closed || view.window.isDestroyed()) return;
    const point = mapPoint(view, scrollArgs.x, scrollArgs.y);
    if (!point) return;
    const deltaX = Math.round(scrollArgs.deltaX);
    const deltaY = Math.round(scrollArgs.deltaY);
    dispatch(view, "Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY },
      () => view.window.webContents.sendInputEvent({ type: "mouseWheel", x: point.x, y: point.y, deltaX, deltaY, canScroll: true }));
  };

  const key = (keyArgs: CloudPhoneViewKeyArgs): void => {
    const view = views.get(keyArgs.viewId);
    if (!view || view.closed || view.window.isDestroyed()) return;
    wake(view);
    const contents = view.window.webContents;
    const named = NAMED_KEYS.get(keyArgs.key);
    if (named) {
      const vk = VIRTUAL_KEY_CODES.get(named) ?? 0;
      dispatch(view, "Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyArgs.key, windowsVirtualKeyCode: vk, ...(named === "Enter" ? { text: String.fromCharCode(13) } : {}) },
        () => contents.sendInputEvent({ type: "keyDown", keyCode: named }));
      dispatch(view, "Input.dispatchKeyEvent", { type: "keyUp", key: keyArgs.key, windowsVirtualKeyCode: vk }, () => contents.sendInputEvent({ type: "keyUp", keyCode: named }));
      return;
    }
    // One printable character (a surrogate pair is still one character).
    if (Array.from(keyArgs.key).length !== 1) return;
    dispatch(view, "Input.dispatchKeyEvent", { type: "keyDown", key: keyArgs.key, text: keyArgs.key }, () => {
      contents.sendInputEvent({ type: "keyDown", keyCode: keyArgs.key });
      contents.sendInputEvent({ type: "char", keyCode: keyArgs.key });
    });
    dispatch(view, "Input.dispatchKeyEvent", { type: "keyUp", key: keyArgs.key }, () => contents.sendInputEvent({ type: "keyUp", keyCode: keyArgs.key }));
  };

  const home = (homeArgs: { viewId: string }): void => {
    const view = views.get(homeArgs.viewId);
    if (!view || view.closed || view.window.isDestroyed()) return;
    void view.window.webContents.executeJavaScript(buttonScript("home"), true).catch(() => {});
  };

  const setHidden = (hiddenArgs: { viewId: string; hidden: boolean }): void => {
    const view = views.get(hiddenArgs.viewId);
    if (!view || view.closed || view.window.isDestroyed()) return;
    if (view.hidden === hiddenArgs.hidden) return;
    view.hidden = hiddenArgs.hidden;
    if (hiddenArgs.hidden) {
      view.window.webContents.stopPainting();
    } else if (view.state !== "ended" && view.state !== "error") {
      // The rect may have moved while the page was not painting.
      measureCanvas(view);
      view.window.webContents.startPainting();
    }
  };

  return {
    open,
    close: (closeArgs) => closeView(closeArgs.viewId),
    input,
    scroll,
    key,
    home,
    setHidden,
    closeAll: () => {
      for (const view of [...views.values()]) dispose(view);
    },
  };
}

/**
 * Electron's names for the keys the 3D surface forwards. Arrow keys arrive as
 * "ArrowUp" and friends from the DOM; both spellings are accepted.
 *
 * A Map, not an object literal: a key named `constructor` would otherwise find
 * `Object.prototype.constructor` and send a function as Electron's keyCode.
 */
const NAMED_KEYS = new Map<string, string>([
  ["Enter", "Enter"],
  ["Backspace", "Backspace"],
  ["Escape", "Escape"],
  ["Tab", "Tab"],
  ["ArrowUp", "Up"],
  ["ArrowDown", "Down"],
  ["ArrowLeft", "Left"],
  ["ArrowRight", "Right"],
  ["Up", "Up"],
  ["Down", "Down"],
  ["Left", "Left"],
  ["Right", "Right"],
]);

/** Windows virtual-key codes the debugger's key events carry for the named keys. */
const VIRTUAL_KEY_CODES = new Map<string, number>([
  ["Enter", 13], ["Backspace", 8], ["Escape", 27], ["Tab", 9], ["Up", 38], ["Down", 40], ["Left", 37], ["Right", 39],
]);
