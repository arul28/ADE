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

type GlyphState = {
  /** CSS color of the glyph (`currentColor` of the indicator). */
  color: string;
  /** Not the focused app: hold the rest frame and stop. */
  resting: boolean;
  /** Reduced motion: hold the still frame and stop. */
  still: boolean;
  /** Canvas size in device pixels (square). */
  sizePx: number;
};

type WorkerMessage =
  | { type: "attach"; id: number; canvas: OffscreenCanvas; frames: readonly string[]; pageTimeOrigin: number; state: GlyphState }
  | { type: "update"; id: number; state: GlyphState }
  | { type: "detach"; id: number };

/**
 * The worker's whole program. It runs from a blob URL (`worker-src 'self' blob:`
 * in rendererCsp.ts), so it must not reference anything outside its own body.
 */
function thinkingGlyphWorker(scope: {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  performance: Performance;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
}): void {
  const STEP_MS = 1000 / 30;
  const LOOP_MS = 4000;
  const TWINKLE = "M 19 2.5 C 19.18 4.32 19.68 4.82 21.5 5 C 19.68 5.18 19.18 5.68 19 7.5 C 18.82 5.68 18.32 5.18 16.5 5 C 18.32 4.82 18.82 4.32 19 2.5 Z";
  // index.css `ade-thinking-glyph-turn`: [offset, rotate deg, scale, steps of the segment that starts here].
  const TURN: Array<[number, number, number, number]> = [[0, 0, 1, 36], [0.3, 108, 0.9, 24], [0.5, 180, 0.78, 24], [0.7, 252, 0.9, 36], [1, 360, 1, 0]];
  // index.css `ade-thinking-twinkle`: [offset, opacity, rotate deg, scale, steps].
  const TWINKLE_KEYS: Array<[number, number, number, number, number]> = [[0, 0, 0, 0.2, 0], [0.3, 0, 0, 0.2, 24], [0.5, 1, 90, 1, 24], [0.7, 0, 0, 0.2, 0], [1, 0, 0, 0.2, 0]];

  /** The value CSS shows for a `steps(n, jump-none)` segment at `progress` in [0, 1). */
  const jumpNone = (progress: number, steps: number) => (steps <= 1 ? 0 : Math.min(1, Math.floor(progress * steps + 1e-9) / (steps - 1)));

  type Entry = { canvas: OffscreenCanvas; ctx: OffscreenCanvasRenderingContext2D; frames: Path2D[]; twinkle: Path2D; state: GlyphState; drawnKey: string };
  const entries = new Map<number, Entry>();
  let pageOffsetMs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pageNow = () => scope.performance.now() + pageOffsetMs;

  function draw(entry: Entry, pageMs: number): void {
    const { ctx, canvas, state } = entry;
    const moving = !state.resting && !state.still;
    const local = ((pageMs % LOOP_MS) + LOOP_MS) % LOOP_MS;
    const step = moving ? Math.floor(local / STEP_MS + 1e-6) % 120 : 0;
    // One drawing per step and state: the worker wakes on step edges only, but a state change redraws now.
    const key = `${step}|${state.color}|${state.sizePx}|${state.resting}|${state.still}`;
    if (key === entry.drawnKey) return;
    entry.drawnKey = key;
    if (canvas.width !== state.sizePx) canvas.width = state.sizePx;
    if (canvas.height !== state.sizePx) canvas.height = state.sizePx;
    const unit = state.sizePx / 24;
    const at = (step * STEP_MS) / LOOP_MS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // The glyph: turn and scale about the box's centre, then the shape of this step.
    let rotate = 0;
    let scale = 1;
    if (moving) {
      const k = TURN.findIndex((key, index) => at >= key[0] && at < TURN[index + 1]![0]);
      const [start, fromDeg, fromScale, steps] = TURN[k]!;
      const [end, toDeg, toScale] = TURN[k + 1]!;
      const eased = jumpNone((at - start) / (end - start), steps);
      rotate = fromDeg + (toDeg - fromDeg) * eased;
      scale = fromScale + (toScale - fromScale) * eased;
    }
    ctx.setTransform(unit, 0, 0, unit, 0, 0);
    ctx.translate(12, 12);
    ctx.rotate((rotate * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.translate(-12, -12);
    // The SVG fill fades the color from opacity 1 to 0.4 along (5,4)-(20,20).
    // The color is any CSS color, so rather than rewrite its alpha the shape is
    // filled solid and then masked by that fade.
    ctx.fillStyle = state.color;
    ctx.save();
    ctx.fill(entry.frames[step]!);
    ctx.globalCompositeOperation = "destination-in";
    const fade = ctx.createLinearGradient(5, 4, 20, 20);
    fade.addColorStop(0, "rgba(0,0,0,1)");
    fade.addColorStop(1, "rgba(0,0,0,0.4)");
    ctx.fillStyle = fade;
    ctx.fillRect(-24, -24, 72, 72);
    ctx.restore();

    // The twinkle: its own box, turning about 79% 21%.
    let opacity = state.still ? 0.5 : 0;
    let twinkleDeg = 0;
    let twinkleScale = state.still ? 1 : 0.2;
    if (moving) {
      const k = TWINKLE_KEYS.findIndex((key, index) => at >= key[0] && at < TWINKLE_KEYS[index + 1]![0]);
      const [start, fromOpacity, fromDeg, fromScale, steps] = TWINKLE_KEYS[k]!;
      const [end, toOpacity, toDeg, toScale] = TWINKLE_KEYS[k + 1]!;
      const eased = jumpNone((at - start) / (end - start), steps);
      opacity = fromOpacity + (toOpacity - fromOpacity) * eased;
      twinkleDeg = fromDeg + (toDeg - fromDeg) * eased;
      twinkleScale = fromScale + (toScale - fromScale) * eased;
    }
    if (opacity > 0) {
      ctx.setTransform(unit, 0, 0, unit, 0, 0);
      ctx.translate(18.96, 5.04);
      ctx.rotate((twinkleDeg * Math.PI) / 180);
      ctx.scale(twinkleScale, twinkleScale);
      ctx.translate(-18.96, -5.04);
      ctx.globalAlpha = opacity;
      ctx.fillStyle = state.color;
      ctx.fill(entry.twinkle);
      ctx.globalAlpha = 1;
    }
  }

  function tick(): void {
    timer = null;
    const now = pageNow();
    let moving = false;
    for (const entry of entries.values()) {
      draw(entry, now);
      if (!entry.state.resting && !entry.state.still) moving = true;
    }
    if (!moving) return;
    // Wake just past the next step edge of the page timeline.
    const next = (Math.floor(now / STEP_MS) + 1) * STEP_MS + 0.5;
    timer = scope.setTimeout(tick, Math.max(0, next - now));
  }

  function reschedule(): void {
    if (timer !== null) scope.clearTimeout(timer);
    timer = null;
    tick();
  }

  scope.onmessage = (event) => {
    const message = event.data;
    if (message.type === "attach") {
      // Page time = worker time + (worker origin - page origin).
      pageOffsetMs = scope.performance.timeOrigin - message.pageTimeOrigin;
      const ctx = message.canvas.getContext("2d");
      if (!ctx) return;
      entries.set(message.id, {
        canvas: message.canvas,
        ctx,
        frames: message.frames.map((d) => new Path2D(d)),
        twinkle: new Path2D(TWINKLE),
        state: message.state,
        drawnKey: "",
      });
    } else if (message.type === "update") {
      const entry = entries.get(message.id);
      if (entry) entry.state = message.state;
    } else {
      entries.delete(message.id);
    }
    reschedule();
  };
}

let worker: Worker | null = null;
let workerFailed = false;
let nextId = 1;

function sharedWorker(): Worker | null {
  if (worker || workerFailed) return worker;
  try {
    const source = `(${thinkingGlyphWorker.toString()})(self);`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    worker = new Worker(url);
    URL.revokeObjectURL(url);
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
