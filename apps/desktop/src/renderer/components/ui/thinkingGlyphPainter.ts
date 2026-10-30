/**
 * Paints the thinking indicator's glyph (the sparkle that turns and melts into
 * a circle, and the twinkle at its corner) into a canvas from one shared
 * worker, so the page has no CSS animation for it.
 *
 * As CSS, the glyph was three compositor animations. They cost the main thread
 * nothing per step, but every one of them is a layer Chrome must place again on
 * every main-thread frame: while a reply streamed, the glyph alone made each
 * update's layerize about twice as long (≈0.7 s of a 32 s stream), and a page
 * with running CSS animations keeps scheduling main-thread frames at idle. A
 * canvas the worker draws into reaches the compositor without the main thread.
 *
 * The worker draws exactly what the CSS drew: the same 120 shapes
 * (ThinkingIndicator's GLYPH_STRIP), the same stepped turn and twinkle
 * keyframes, at the same 1/30 s instants of the page's timeline (time 0 of the
 * document timeline, where `animationPhaseAlignment` starts every CSS loop), so
 * it stays in step with the label's CSS sheen.
 */

import ThinkingGlyphWorker from "./thinkingGlyph.worker?worker";
import type { GlyphState, WorkerMessage } from "./thinkingGlyph.worker";

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;

function sharedWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    worker = new ThinkingGlyphWorker();
  } catch {
    workerFailed = true;
    worker = null;
  }
  return worker;
}

/** Whether this renderer can paint the glyph off the main thread. */
export function canPaintThinkingGlyph(): boolean {
  return typeof OffscreenCanvas !== "undefined"
    && typeof HTMLCanvasElement !== "undefined"
    && "transferControlToOffscreen" in HTMLCanvasElement.prototype
    && typeof Worker !== "undefined"
    && typeof Path2D !== "undefined";
}

export type ThinkingGlyphHandle = {
  update(state: GlyphState): void;
  detach(): void;
};

/** Hands `canvas` to the shared worker; null when the worker cannot start (keep the CSS glyph). */
export function attachThinkingGlyph(canvas: HTMLCanvasElement, frames: readonly string[], state: GlyphState): ThinkingGlyphHandle | null {
  const target = sharedWorker();
  if (!target) return null;
  let offscreen: OffscreenCanvas;
  try {
    offscreen = canvas.transferControlToOffscreen();
  } catch {
    return null;
  }
  const id = nextId++;
  target.postMessage(
    { type: "attach", id, canvas: offscreen, frames, pageTimeOrigin: performance.timeOrigin, state } satisfies WorkerMessage,
    [offscreen],
  );
  let last = JSON.stringify(state);
  return {
    update(next) {
      const key = JSON.stringify(next);
      if (key === last) return;
      last = key;
      target.postMessage({ type: "update", id, state: next } satisfies WorkerMessage);
    },
    detach() {
      target.postMessage({ type: "detach", id } satisfies WorkerMessage);
    },
  };
}
