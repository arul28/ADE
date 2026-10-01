import { BrowserWindow, screen } from "electron";

import type { OpenProjectBinding, ProjectTabAdoptRequest } from "../../../shared/types";

/** The header's height in CSS pixels; the drop band scales it by the target's zoom. */
const HEADER_CSS_PX = 32;
/** Extra room under the tabs, so a release just below them still joins. */
const DROP_BAND_SLACK_PX = 12;
/** How often the dragged window follows the pointer (about 120 Hz). */
const FOLLOW_INTERVAL_MS = 8;
/**
 * A drag that never hears its pointer-up must not pin a window to the pointer
 * forever. The source window's death also ends it; this is the last resort.
 */
const MAX_DRAG_MS = 120_000;

type Point = { x: number; y: number };

type ActiveDrag = {
  win: BrowserWindow;
  binding: OpenProjectBinding;
  /** The pointer's offset from the top-left of the dragged window's content. */
  grab: Point;
  /** Content origin minus frame origin; non-zero on framed (Linux) windows. */
  frameOffset: Point;
  /**
   * The latest pointer position the source window reported. The source window
   * holds pointer capture for the whole drag, so it keeps reporting even when
   * the pointer is over another window. The OS cursor is only the fallback.
   */
  point: Point | null;
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
  detachSource: () => void;
};

export type ProjectTabDragEndResult = { merged: boolean; targetWindowId: number | null };

export type ProjectTabDragService = {
  /**
   * Starts a Chrome-style tab drag out of `source`. With `moveSource`, the
   * source window itself follows the pointer (it held only this tab).
   * Otherwise a new window opens under the pointer with the project, and
   * follows it.
   */
  start(args: {
    source: BrowserWindow;
    binding: unknown;
    grab: Point;
    moveSource: boolean;
    point: Point | null;
  }): Promise<{ windowId: number | null }>;
  /** The pointer moved, in screen coordinates. */
  move(point: Point): void;
  /**
   * Ends the drag. Unless it was cancelled, a release over another window's
   * tab strip makes that window adopt the project, and the dragged window
   * closes.
   */
  end(point: Point | null, opts?: { cancelled?: boolean }): ProjectTabDragEndResult;
  dispose(): void;
};

function frameOffsetOf(win: BrowserWindow): Point {
  const frame = win.getBounds();
  const content = win.getContentBounds();
  return { x: content.x - frame.x, y: content.y - frame.y };
}

export function createProjectTabDragService(deps: {
  /** Rebuilds a renderer-supplied binding, or rejects it with null. */
  sanitizeBinding: (value: unknown) => OpenProjectBinding | null;
  /**
   * Opens a window on the project. `onWindow` fires as soon as the window
   * exists, before the project finishes loading in it, so the window can
   * follow the pointer at once.
   */
  openWindow: (args: {
    binding: OpenProjectBinding;
    bounds: { x: number; y: number; width: number; height: number };
    onWindow: (win: BrowserWindow) => void;
  }) => Promise<unknown>;
  closeWindow: (win: BrowserWindow) => void;
  sendAdopt: (target: BrowserWindow, request: ProjectTabAdoptRequest) => void;
}): ProjectTabDragService {
  let active: ActiveDrag | null = null;
  // A move can arrive while the new window is still opening.
  let pendingPoint: Point | null = null;
  // Bumped by every start and end, so a window that finishes opening after
  // its drag already ended never starts following the pointer.
  let generation = 0;

  const stopFollowing = () => {
    if (!active) return;
    clearInterval(active.timer);
    active.detachSource();
    active = null;
    pendingPoint = null;
  };

  /** Ends the drag in place when the window that owns the pointer goes away. */
  const watchSource = (source: BrowserWindow): (() => void) => {
    const stop = () => stopFollowing();
    const contents = source.webContents;
    source.once("closed", stop);
    contents.once("render-process-gone", stop);
    contents.once("did-navigate", stop);
    return () => {
      source.removeListener("closed", stop);
      if (!contents.isDestroyed()) {
        contents.removeListener("render-process-gone", stop);
        contents.removeListener("did-navigate", stop);
      }
    };
  };

  const follow = (args: {
    win: BrowserWindow;
    source: BrowserWindow;
    binding: OpenProjectBinding;
    grab: Point;
    point: Point | null;
  }) => {
    stopFollowing();
    const { win, grab } = args;
    const frameOffset = frameOffsetOf(win);
    const drag: ActiveDrag = {
      win,
      binding: args.binding,
      grab,
      frameOffset,
      point: args.point,
      startedAt: Date.now(),
      detachSource: watchSource(args.source),
      timer: setInterval(() => {
        if (win.isDestroyed() || Date.now() - drag.startedAt > MAX_DRAG_MS) {
          stopFollowing();
          return;
        }
        const pointer = drag.point ?? screen.getCursorScreenPoint();
        const [x, y] = win.getPosition();
        const nextX = Math.round(pointer.x - grab.x - frameOffset.x);
        const nextY = Math.round(pointer.y - grab.y - frameOffset.y);
        if (x !== nextX || y !== nextY) win.setPosition(nextX, nextY);
      }, FOLLOW_INTERVAL_MS),
    };
    active = drag;
  };

  const findDropTarget = (dragged: BrowserWindow, pointer: Point): BrowserWindow | null => {
    const candidates = BrowserWindow.getAllWindows().filter(
      (win) =>
        win !== dragged
        && !win.isDestroyed()
        && win.isVisible()
        && !win.isMinimized()
        && win.getParentWindow() == null,
    );
    // Electron exposes no z-order, so prefer the focused window when two
    // strips overlap under the pointer.
    const focused = BrowserWindow.getFocusedWindow();
    candidates.sort((a, b) => Number(b === focused) - Number(a === focused));
    for (const win of candidates) {
      const bounds = win.getContentBounds();
      const band = HEADER_CSS_PX * win.webContents.getZoomFactor() + DROP_BAND_SLACK_PX;
      if (
        pointer.x >= bounds.x
        && pointer.x <= bounds.x + bounds.width
        && pointer.y >= bounds.y
        && pointer.y <= bounds.y + band
      ) {
        return win;
      }
    }
    return null;
  };

  return {
    async start({ source, binding: rawBinding, grab, moveSource, point }) {
      const binding = deps.sanitizeBinding(rawBinding);
      if (!binding) return { windowId: null };
      const dragGeneration = ++generation;
      pendingPoint = point;
      if (moveSource) {
        // A fullscreen window cannot be moved; a maximized one must first
        // return to its normal size, as Chrome does.
        if (source.isFullScreen()) return { windowId: null };
        if (source.isMaximized()) source.unmaximize();
        follow({ win: source, source, binding, grab, point });
        return { windowId: source.id };
      }
      const pointer = point ?? screen.getCursorScreenPoint();
      const normal = source.isMaximized() || source.isFullScreen()
        ? source.getNormalBounds()
        : source.getBounds();
      const frameOffset = frameOffsetOf(source);
      const win = await new Promise<BrowserWindow | null>((resolve) => {
        deps
          .openWindow({
            binding,
            bounds: {
              x: Math.round(pointer.x - grab.x - frameOffset.x),
              y: Math.round(pointer.y - grab.y - frameOffset.y),
              width: normal.width,
              height: normal.height,
            },
            onWindow: resolve,
          })
          // A window that never appeared resolves null; one that did already
          // resolved above, and a second resolve is ignored.
          .then(() => resolve(null), () => resolve(null));
      });
      if (!win || win.isDestroyed() || source.isDestroyed()) return { windowId: null };
      // The drag ended while the window was opening: it stays where it opened.
      if (dragGeneration !== generation) return { windowId: win.id };
      follow({ win, source, binding, grab, point: pendingPoint });
      return { windowId: win.id };
    },

    move(point) {
      pendingPoint = point;
      if (active) active.point = point;
    },

    end(point, opts = {}) {
      generation += 1;
      const drag = active;
      stopFollowing();
      if (!drag || drag.win.isDestroyed()) return { merged: false, targetWindowId: null };
      const pointer = point ?? drag.point ?? screen.getCursorScreenPoint();
      const target = opts.cancelled ? null : findDropTarget(drag.win, pointer);
      if (!target) {
        drag.win.focus();
        return { merged: false, targetWindowId: null };
      }
      const bounds = target.getContentBounds();
      deps.sendAdopt(target, { binding: drag.binding, screenOffsetX: pointer.x - bounds.x });
      target.focus();
      deps.closeWindow(drag.win);
      return { merged: true, targetWindowId: target.id };
    },

    dispose() {
      stopFollowing();
    },
  };
}
