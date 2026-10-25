import type { BrowserWindow, Rectangle } from "electron";

/**
 * Where the last ADE window sat, so the next launch reopens there instead of
 * at the default size on the primary display.
 *
 * `bounds` are the window's normal (restored) bounds: a maximized or
 * full-screen window still remembers where it goes when un-maximized.
 */
export type MainWindowState = {
  bounds: Rectangle;
  maximized?: boolean;
  fullScreen?: boolean;
};

function finiteInt(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}

/** A saved state, or null when the stored value is missing or malformed. */
export function parseMainWindowState(value: unknown): MainWindowState | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const bounds = record.bounds as Record<string, unknown> | undefined;
  if (!bounds || typeof bounds !== "object") return null;
  const x = finiteInt(bounds.x);
  const y = finiteInt(bounds.y);
  const width = finiteInt(bounds.width);
  const height = finiteInt(bounds.height);
  if (x == null || y == null || width == null || height == null || width <= 0 || height <= 0) return null;
  return {
    bounds: { x, y, width, height },
    ...(record.maximized === true ? { maximized: true } : {}),
    ...(record.fullScreen === true ? { fullScreen: true } : {}),
  };
}

function overlapArea(a: Rectangle, b: Rectangle): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * The saved bounds placed on a display that is still connected, or null to
 * open at the default size.
 *
 * The display is the work area the saved window overlaps most. None at all
 * means that monitor is gone (unplugged, or a laptop now off its dock), and a
 * window restored there would open off screen. The window is then shrunk to
 * fit that work area and moved fully inside it, so a window snapped past an
 * edge, or saved on a larger or since-rescaled display, comes back whole and
 * with its title bar reachable.
 */
export function fitMainWindowBounds(
  saved: Rectangle,
  workAreas: readonly Rectangle[],
  minWidth: number,
): Rectangle | null {
  let best: Rectangle | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const overlap = overlapArea(saved, area);
    if (overlap > bestArea) {
      best = area;
      bestArea = overlap;
    }
  }
  if (!best) return null;
  const width = Math.min(Math.max(saved.width, minWidth), best.width);
  const height = Math.min(saved.height, best.height);
  const x = Math.min(Math.max(saved.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(saved.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}

/** How long a move or resize settles before it is written. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Write the window's state whenever it moves, resizes, maximizes or enters
 * full screen (debounced), and once more as it closes. A minimized window
 * keeps the state it had before.
 */
export function trackMainWindowState(win: BrowserWindow, save: (state: MainWindowState) => void): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const capture = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (win.isDestroyed() || win.isMinimized()) return;
    const fullScreen = win.isFullScreen();
    save({
      bounds: win.getNormalBounds(),
      ...(win.isMaximized() && !fullScreen ? { maximized: true } : {}),
      ...(fullScreen ? { fullScreen: true } : {}),
    });
  };
  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(capture, SAVE_DEBOUNCE_MS);
  };
  win.on("resize", schedule);
  win.on("move", schedule);
  win.on("maximize", schedule);
  win.on("unmaximize", schedule);
  win.on("enter-full-screen", schedule);
  win.on("leave-full-screen", schedule);
  win.on("close", capture);
  win.on("closed", () => {
    if (timer) clearTimeout(timer);
    timer = null;
  });
}
