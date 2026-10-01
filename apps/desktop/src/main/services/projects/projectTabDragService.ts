import { BrowserWindow, screen } from "electron";

import type { OpenProjectBinding, ProjectTabAdoptRequest } from "../../../shared/types";

/**
 * The height of the header band that counts as "the tab strip" when a dragged
 * tab is released over another window. The header is 32 CSS px; the band is a
 * little taller so a release just under the tabs still joins them.
 */
const TAB_STRIP_DROP_BAND_PX = 44;
/** How often the dragged window follows the cursor (about 120 Hz). */
const FOLLOW_INTERVAL_MS = 8;
/**
 * A drag that never hears its pointer-up (the renderer crashed, the window
 * closed) must not pin a window to the cursor forever.
 */
const MAX_DRAG_MS = 120_000;

type ActiveDrag = {
  win: BrowserWindow;
  /**
   * The latest pointer position the source window reported. The source window
   * holds pointer capture for the whole drag, so it keeps reporting even when
   * the pointer is over another window. The OS cursor is only the fallback.
   */
  point: Electron.Point | null;
  binding: OpenProjectBinding;
  grab: { x: number; y: number };
  timer: ReturnType<typeof setInterval>;
  startedAt: number;
};

export type ProjectTabDragService = {
  /**
   * Starts a Chrome-style tab drag out of `source`. With `moveSource`, the
   * source window itself follows the cursor (it held only this tab). Otherwise
   * a new window opens under the cursor with the project, and follows it.
   */
  start(args: {
    source: BrowserWindow;
    binding: OpenProjectBinding;
    grab: { x: number; y: number };
    moveSource: boolean;
    point: Electron.Point | null;
  }): Promise<{ windowId: number | null }>;
  /** The pointer moved, in screen coordinates. */
  move(point: Electron.Point): void;
  /**
   * Ends the drag. When the cursor is over another window's tab strip, that
   * window adopts the project and the dragged window closes.
   */
  end(point: Electron.Point | null): { merged: boolean; targetWindowId: number | null };
  dispose(): void;
};

export function createProjectTabDragService(deps: {
  /**
   * Opens a window on the project. `onWindow` fires as soon as the window
   * exists, before the project finishes loading in it, so the window can
   * follow the cursor at once.
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
  let pendingPoint: Electron.Point | null = null;

  const stopFollowing = () => {
    if (!active) return;
    clearInterval(active.timer);
    active = null;
    pendingPoint = null;
  };

  const follow = (
    win: BrowserWindow,
    binding: OpenProjectBinding,
    grab: { x: number; y: number },
    point: Electron.Point | null,
  ) => {
    stopFollowing();
    const drag: ActiveDrag = {
      win,
      point,
      binding,
      grab,
      startedAt: Date.now(),
      timer: setInterval(() => {
        if (win.isDestroyed() || Date.now() - drag.startedAt > MAX_DRAG_MS) {
          stopFollowing();
          return;
        }
        const cursor = drag.point ?? screen.getCursorScreenPoint();
        const [x, y] = win.getPosition();
        const nextX = Math.round(cursor.x - grab.x);
        const nextY = Math.round(cursor.y - grab.y);
        if (x !== nextX || y !== nextY) win.setPosition(nextX, nextY);
      }, FOLLOW_INTERVAL_MS),
    };
    active = drag;
  };

  const findDropTarget = (dragged: BrowserWindow, cursor: Electron.Point): BrowserWindow | null => {
    const candidates = BrowserWindow.getAllWindows().filter(
      (win) =>
        win !== dragged
        && !win.isDestroyed()
        && win.isVisible()
        && !win.isMinimized()
        && win.getParentWindow() == null,
    );
    // Prefer the focused window when two strips overlap under the cursor.
    const focused = BrowserWindow.getFocusedWindow();
    candidates.sort((a, b) => Number(b === focused) - Number(a === focused));
    for (const win of candidates) {
      const bounds = win.getContentBounds();
      if (
        cursor.x >= bounds.x
        && cursor.x <= bounds.x + bounds.width
        && cursor.y >= bounds.y
        && cursor.y <= bounds.y + TAB_STRIP_DROP_BAND_PX
      ) {
        return win;
      }
    }
    return null;
  };

  return {
    async start({ source, binding, grab, moveSource, point }) {
      pendingPoint = point;
      if (moveSource) {
        follow(source, binding, grab, point);
        return { windowId: source.id };
      }
      const cursor = point ?? screen.getCursorScreenPoint();
      const [width, height] = source.getSize();
      const win = await new Promise<BrowserWindow | null>((resolve) => {
        deps
          .openWindow({
            binding,
            bounds: {
              x: Math.round(cursor.x - grab.x),
              y: Math.round(cursor.y - grab.y),
              width,
              height,
            },
            onWindow: resolve,
          })
          // A window that never appeared resolves null; one that did already
          // resolved above, and a second resolve is ignored.
          .then(() => resolve(null), () => resolve(null));
      });
      if (!win || win.isDestroyed()) return { windowId: null };
      follow(win, binding, grab, pendingPoint);
      return { windowId: win.id };
    },

    move(point) {
      pendingPoint = point;
      if (active) active.point = point;
    },

    end(point) {
      const drag = active;
      stopFollowing();
      if (!drag || drag.win.isDestroyed()) return { merged: false, targetWindowId: null };
      const cursor = point ?? drag.point ?? screen.getCursorScreenPoint();
      const target = findDropTarget(drag.win, cursor);
      if (!target) {
        drag.win.focus();
        return { merged: false, targetWindowId: null };
      }
      const bounds = target.getContentBounds();
      deps.sendAdopt(target, { binding: drag.binding, clientX: cursor.x - bounds.x });
      target.focus();
      deps.closeWindow(drag.win);
      return { merged: true, targetWindowId: target.id };
    },

    dispose() {
      stopFollowing();
    },
  };
}
