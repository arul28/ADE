/**
 * The reserved rect, and the host engine that paints into it.
 *
 * The page owns all the chrome and NONE of the pixels. The live screen is a
 * `Simulator.app` window capture — a `MediaStream` from Electron's
 * `desktopCapturer`, painted into a `<video>` at 60fps, with a window-parking
 * claim keeping the captured window on screen. A plugin guest has none of that
 * and should not: `getUserMedia` over a desktop source inside sandboxed web
 * content would be a capability escape, not a feature.
 *
 * So the page reserves an element, measures it, and tells the host where to
 * draw. Three rules make that safe:
 *
 * 1. **CSS pixels, guest-relative.** `getBoundingClientRect()` already answers
 *    in the guest viewport's own coordinates, which is exactly what the host
 *    needs — it owns the frame and knows where the frame sits.
 * 2. **Coalesced.** A `ResizeObserver` fires per layout tick, and a zoom step
 *    or a window drag is dozens of ticks. The same rect is never sent twice,
 *    and a burst of different rects settles into one call on the next frame —
 *    the discipline `host/ui.ts:reportHeight` keeps for the height channel.
 * 3. **Released.** On unmount, and whenever the reserved element stops being
 *    visible, the host is told to stop painting. A page that only ever placed
 *    would leave the engine drawing over chrome that has moved.
 *
 * A host with no `hostEngine` never throws here. `placeEngine` answers `false`
 * and the caller draws its own "this host cannot paint the live screen" line —
 * which is the honest thing to show, because there is genuinely nothing behind
 * the rect.
 */

import { bridge, type HostEngineRect } from "../bridge";

/**
 * The engine id, which is the plugin's own builtin surface.
 *
 * The same word `panels.js` names in the vocabulary canvas (`engine:
 * "simulator"`) and the same word `vocabularyCanvas.tsx` switches on. One name
 * for one painter, so a page and a panel cannot disagree about which engine
 * they mean.
 */
export const SIMULATOR_ENGINE_ID = "simulator";

/** Sub-pixel jitter a layout tick produces and a repaint must not chase. */
const RECT_EPSILON = 0.5;

export function rectsMatch(a: HostEngineRect | null, b: HostEngineRect | null): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < RECT_EPSILON
    && Math.abs(a.y - b.y) < RECT_EPSILON
    && Math.abs(a.width - b.width) < RECT_EPSILON
    && Math.abs(a.height - b.height) < RECT_EPSILON;
}

/** Whether this host can paint an engine at all. */
export function hasHostEngine(): boolean {
  return Boolean(bridge()?.hostEngine);
}

/**
 * The one sentence a host with no engine gets.
 *
 * Named here rather than written at the call site so the page says the same
 * thing everywhere it has to say it, and so the seam test can assert the page
 * degraded rather than that it happened to render some words.
 */
export const NO_ENGINE_MESSAGE =
  "This ADE cannot paint the live simulator screen here. Open iOS Sim Control on the Mac running the simulator.";

/**
 * Read an element's rect in the guest's own CSS pixels.
 *
 * `null` for an element with no box — display:none, detached, or a placement
 * that is hidden — which is what makes "the reserved rect went away" and "the
 * page unmounted" the same call to `releaseEngine` at the caller.
 */
export function measureRect(element: Element | null): HostEngineRect | null {
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (!Number.isFinite(box.width) || !Number.isFinite(box.height)) return null;
  if (box.width <= 0 || box.height <= 0) return null;
  return {
    x: Math.round(box.left),
    y: Math.round(box.top),
    width: Math.round(box.width),
    height: Math.round(box.height),
  };
}

/**
 * A coalescing placer, one per mounted page.
 *
 * Holds the last rect it actually sent, so a `ResizeObserver` that fires eight
 * times for one zoom step costs one host call. Also holds the in-flight promise:
 * a rect that changes while a `place` is still resolving is applied once that
 * one settles rather than racing it, because the host draws at the newest rect
 * it was given and two overlapping places could settle in either order.
 */
export function createEnginePlacer(engineId: string = SIMULATOR_ENGINE_ID) {
  let placed: HostEngineRect | null = null;
  let pending: HostEngineRect | null = null;
  let inFlight: Promise<void> | null = null;
  let released = true;

  async function drain(): Promise<void> {
    const api = bridge()?.hostEngine;
    if (!api) return;
    while (pending) {
      const next = pending;
      pending = null;
      try {
        await api.place({ engineId, rect: next });
        placed = next;
        released = false;
      } catch {
        // A host whose engine has already gone. The next real rect retries; a
        // throw here would take the whole pane down over a repaint.
        placed = null;
        return;
      }
    }
  }

  return {
    /**
     * Ask the host to paint at this rect.
     *
     * `false` when there is no engine to ask, or when the rect is the one
     * already placed. `true` means a call was made or queued.
     */
    place(rect: HostEngineRect | null): boolean {
      if (!rect) return false;
      if (!bridge()?.hostEngine) return false;
      if (!released && rectsMatch(rect, placed)) return false;
      if (rectsMatch(rect, pending)) return false;
      pending = rect;
      if (!inFlight) {
        inFlight = drain().finally(() => {
          inFlight = null;
          if (pending) {
            inFlight = drain().finally(() => {
              inFlight = null;
            });
          }
        });
      }
      return true;
    },
    /** Take the painter away. Safe to call twice and safe with no engine. */
    async release(): Promise<void> {
      pending = null;
      placed = null;
      if (released) return;
      released = true;
      const api = bridge()?.hostEngine;
      if (!api) return;
      try {
        await api.release();
      } catch {
        // Already released, or a host that has gone. Nothing to take back.
      }
    },
    /** The rect the host was last told to paint, for a test and for the header. */
    get current(): HostEngineRect | null {
      return placed;
    },
  };
}

export type EnginePlacer = ReturnType<typeof createEnginePlacer>;
