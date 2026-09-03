/**
 * The reserved rect, and the host engine that paints into it.
 *
 * The page draws ALL the chrome and none of the picture. `electron-control` is
 * a host builtin — a CDP screencast at thirty frames a second, each frame a
 * base64 PNG — and relaying that through the bridge would cost a structured
 * clone per frame for an image the guest would then have to decode. So the page
 * reserves an element, measures it, and tells the host where to paint.
 *
 * Three rules, and none of them is style:
 *
 * 1. **Coalesce.** A layout tick fires a `ResizeObserver` several times, a pane
 *    drag fires it per frame, and every one of those is an IPC round trip. So a
 *    rect identical to the last one reported is dropped outright, and the rest
 *    are batched onto an animation frame — the same discipline
 *    `host/ui.ts:reportHeight` keeps for the height channel.
 * 2. **Degrade.** A host with no `hostEngine` gets no call and no throw. The
 *    caller is told `false` and draws a sentence in the element instead: launch,
 *    connect, click, type and inspect all still work without a picture.
 * 3. **Release.** The host keeps painting until it is told to stop, so an
 *    unmount that forgot would leave a live view over whatever the reader opened
 *    next. Release is unconditional on unmount and on every hide.
 */

import { bridge, type PluginWebviewEngineRect } from "../bridge";

/** The plugin's own host builtin. The only engine this page ever places. */
export const ENGINE_ID = "electron-control";

/**
 * The smallest rect worth painting.
 *
 * A guest measures zero for a beat before layout settles, and a hidden
 * placement measures zero forever. Neither is a rect the host can honour, and
 * asking it to paint one is how a live view ends up as a one-pixel line in the
 * corner.
 */
const MIN_ENGINE_SIDE = 8;

/** Whether this host can paint an engine at all. */
export function hasHostEngine(): boolean {
  return typeof bridge()?.hostEngine?.place === "function";
}

/** The sentence a host with no engine gets, in place of the picture. */
export const NO_ENGINE_MESSAGE =
  "This ADE cannot draw the live app view. Launch, connect, click, type and inspect still work; update ADE to see the app.";

function sameRect(a: PluginWebviewEngineRect | null, b: PluginWebviewEngineRect): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/**
 * Round to whole CSS pixels.
 *
 * The host positions a native view, which cannot land on a fraction. Rounding
 * here rather than in the host is what makes the "same rect" test above mean
 * anything: sub-pixel jitter from a flex layout would otherwise report a new
 * rect on every single tick while the picture never moved.
 */
function normalize(rect: DOMRectReadOnly | DOMRect): PluginWebviewEngineRect {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.top),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

export type EnginePlacement = {
  /**
   * Measure the element and report it, coalesced.
   *
   * Answers whether a call was actually made, so a test can prove the repeat was
   * suppressed rather than inferring it from a count.
   */
  measure: () => void;
  /** Stop painting and forget the last rect, so the next measure reports again. */
  release: () => void;
};

/**
 * Watch one element and keep the host's engine on top of it.
 *
 * Returns the placement handle; the caller disposes it by calling `release`.
 * Everything is guarded, so this is safe to call on a host that has no engine —
 * it simply never places anything.
 */
export function placeEngineOn(element: HTMLElement, engineId: string = ENGINE_ID): EnginePlacement {
  let lastRect: PluginWebviewEngineRect | null = null;
  let frame: number | null = null;
  let disposed = false;

  function flush(): void {
    frame = null;
    if (disposed) return;
    const api = bridge();
    if (!api?.hostEngine?.place) return;
    const rect = normalize(element.getBoundingClientRect());
    if (rect.width < MIN_ENGINE_SIDE || rect.height < MIN_ENGINE_SIDE) return;
    if (sameRect(lastRect, rect)) return;
    lastRect = rect;
    void api.hostEngine.place({ engineId, rect }).catch(() => {
      // The host refused this rect. Forget it so the next measure tries again
      // rather than treating a rejected placement as the one on screen.
      lastRect = null;
    });
  }

  function measure(): void {
    if (disposed || frame !== null) return;
    // `requestAnimationFrame` when there is one, a microtask otherwise. jsdom
    // has the former, but a host that suspended the guest's frames would leave
    // a placement pending forever, and the fallback keeps the seam observable.
    if (typeof requestAnimationFrame === "function") {
      frame = requestAnimationFrame(flush);
    } else {
      frame = -1;
      void Promise.resolve().then(flush);
    }
  }

  function release(): void {
    if (disposed) return;
    disposed = true;
    if (frame !== null && frame >= 0 && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frame);
    }
    frame = null;
    lastRect = null;
    const api = bridge();
    if (!api?.hostEngine?.release) return;
    void api.hostEngine.release().catch(() => {
      // The placement was already gone. Nothing to stop.
    });
  }

  return { measure, release };
}
