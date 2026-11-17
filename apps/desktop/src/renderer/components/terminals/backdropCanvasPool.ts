import { hasLiveBackdropContext, releaseBackdropCanvas } from "./workToolPickerBackdropRenderer";

/**
 * Canvases for the backdrop mesh, kept with their WebGL context between mounts.
 *
 * The new-chat screen mounts a backdrop each time it opens and unmounts it when
 * the chat starts, so every new chat made a WebGL context and threw it away.
 * Each new context costs a burst of GPU process memory (ANGLE's Metal heaps,
 * the first frame's buffers) that Chromium gives back only some time after it
 * goes quiet. A returned canvas keeps its context here, and the next backdrop
 * draws on it: one context serves every new chat in a row. The mesh, the
 * frames and the timing are the renderer's as before, so nothing looks
 * different.
 *
 * At most two canvases wait (the top bar and the new-chat pane can each hand
 * one back), and one that waits 30 s is released, so a backdrop nobody opens
 * again holds no GPU memory.
 */
const IDLE_RELEASE_MS = 30_000;
const MAX_IDLE = 2;

type IdleCanvas = { canvas: HTMLCanvasElement; timer: number };
const idle: IdleCanvas[] = [];

function freshCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("data-backdrop-canvas", "");
  canvas.className = "absolute inset-0";
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  return canvas;
}

/** A canvas for a new backdrop: a waiting one with a live context, or a new one. */
export function acquireBackdropCanvas(): HTMLCanvasElement {
  while (idle.length > 0) {
    const entry = idle.pop()!;
    window.clearTimeout(entry.timer);
    if (hasLiveBackdropContext(entry.canvas)) return entry.canvas;
    releaseBackdropCanvas(entry.canvas);
  }
  return freshCanvas();
}

/**
 * Take a canvas back from a backdrop that disposed its renderer with
 * `keepContext`. The canvas leaves the page at once; its context waits for
 * the next backdrop, or is released after `IDLE_RELEASE_MS`.
 */
export function returnBackdropCanvas(canvas: HTMLCanvasElement): void {
  canvas.remove();
  if (!hasLiveBackdropContext(canvas) || idle.length >= MAX_IDLE) {
    releaseBackdropCanvas(canvas);
    return;
  }
  // A waiting canvas keeps its context, not its drawing buffers: the next
  // renderer sizes the canvas on its first draw.
  canvas.width = 1;
  canvas.height = 1;
  const entry: IdleCanvas = {
    canvas,
    timer: window.setTimeout(() => {
      const index = idle.indexOf(entry);
      if (index >= 0) idle.splice(index, 1);
      releaseBackdropCanvas(canvas);
    }, IDLE_RELEASE_MS),
  };
  idle.push(entry);
}
