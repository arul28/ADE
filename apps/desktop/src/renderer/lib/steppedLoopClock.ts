/**
 * Runs stepped CSS loops on a timer instead of the display's frame clock.
 *
 * While any infinite CSS animation is running, Chromium services it on every
 * display frame, whatever its `steps()` say: a compositor animation ticks the
 * compositor (and the GPU process's display scheduler) at the refresh rate, and
 * a main-thread one (an animated SVG icon, a `background-position` shimmer)
 * recalculates style at that rate. On a 240 Hz display the top-bar activity
 * pulse, which changes four times in three seconds, kept the renderer at ~3%
 * and the GPU process at ~3% of a core; a `steps(30)` spinner on an SVG icon
 * restyled 240 times a second (renderer ~14%).
 *
 * A stepped loop only looks different at its step instants, and those can be
 * read from its keyframes. So an adopted loop is frozen (`playbackRate = 0`,
 * which keeps it "running" and leaves CSS `animation-play-state` in charge),
 * and one shared timer sets its time at each step instant. The keyframes, the
 * delays, reduced-motion rules and the phase alignment
 * (`animationPhaseAlignment.ts`) all stay as they are: the loop shows exactly
 * the values CSS would, at the same moments, and nothing between them.
 *
 * A loop is adopted only when every segment that changes a value uses a step
 * timing function and it changes at most `MAX_CHANGES_PER_SECOND` times a
 * second. A fast compositor loop (the Lanes working mark, 60 steps a second) is
 * cheaper left to the compositor than woken from the main thread 60 times a
 * second, so it keeps running as plain CSS.
 */

/** Above this, a timer-driven loop costs the renderer more than it saves. */
const MAX_CHANGES_PER_SECOND = 31;
/** Steps due within this window of a timer fire share its frame. */
const BATCH_WINDOW_MS = 8;
/** Lands a seek just past the step instant, never on the old side of it. */
const SEEK_EPSILON_MS = 0.5;

type SteppedLoop = {
  animation: CSSAnimation;
  durationMs: number;
  delayMs: number;
  /** Fractions of one iteration where the loop's value changes, ascending. */
  changes: number[];
  nextAtMs: number;
};

const loops = new Map<CSSAnimation, SteppedLoop>();
let timer: ReturnType<typeof setTimeout> | null = null;
let visibilityListening = false;

type StepTiming = { steps: number; position: string };

function parseStepTiming(easing: string): StepTiming | null {
  if (easing === "step-end") return { steps: 1, position: "end" };
  if (easing === "step-start") return { steps: 1, position: "start" };
  const match = /^steps\(\s*(\d+)\s*(?:,\s*([a-z-]+)\s*)?\)$/.exec(easing);
  if (!match) return null;
  return { steps: Number(match[1]), position: match[2] ?? "end" };
}

const KEYFRAME_META_KEYS = new Set(["offset", "computedOffset", "easing", "composite"]);

function keyframeValues(keyframe: ComputedKeyframe): string {
  return JSON.stringify(
    Object.entries(keyframe)
      .filter(([key]) => !KEYFRAME_META_KEYS.has(key))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

const roundFraction = (value: number) => Math.round(value * 1e6) / 1e6;

/**
 * The fractions of an iteration at which a stepped loop shows a new value, or
 * null when some changing segment is not stepped (a smooth segment has no
 * step instants to wake on).
 */
function stepChangeFractions(animation: CSSAnimation): number[] | null {
  const effect = animation.effect;
  if (!(effect instanceof KeyframeEffect)) return null;
  const keyframes = effect.getKeyframes();
  const fractions = new Set<number>();
  for (let index = 0; index < keyframes.length - 1; index += 1) {
    const from = keyframes[index];
    const to = keyframes[index + 1];
    const start = from.computedOffset;
    const end = to.computedOffset;
    if (!(end > start)) continue;
    if (keyframeValues(from) === keyframeValues(to)) continue;
    const timing = parseStepTiming(from.easing ?? "linear");
    if (!timing) return null;
    // Every timing that jumps at the segment's ends lands on the same grid of
    // `steps` (or `steps ± 1`) intervals; listing both ends covers the jump
    // into the segment and the hand-over to the next one.
    const intervals = timing.position === "jump-both"
      ? timing.steps + 1
      : timing.position === "jump-none"
        ? Math.max(1, timing.steps - 1)
        : timing.steps;
    for (let step = 0; step <= intervals; step += 1) {
      fractions.add(roundFraction((start + ((end - start) * step) / intervals) % 1));
    }
  }
  if (fractions.size === 0) return null;
  const direction = effect.getTiming().direction ?? "normal";
  const all = direction === "normal"
    ? [...fractions]
    : [...fractions, ...[...fractions].map((fraction) => roundFraction((1 - fraction) % 1))];
  return [...new Set(all)].sort((a, b) => a - b);
}

function nextChangeAt(loop: Pick<SteppedLoop, "durationMs" | "delayMs" | "changes">, nowMs: number): number {
  const local = nowMs - loop.delayMs;
  const iteration = Math.floor(local / loop.durationMs);
  const position = (local - iteration * loop.durationMs) / loop.durationMs;
  for (const fraction of loop.changes) {
    if (fraction > position + 1e-9) return loop.delayMs + (iteration + fraction) * loop.durationMs;
  }
  return loop.delayMs + (iteration + 1 + loop.changes[0]) * loop.durationMs;
}

// The document timeline starts at the performance time origin and every loop
// is aligned to its time 0, so an adopted loop's time is simply "now".
function seek(loop: SteppedLoop, nowMs: number): void {
  loop.animation.currentTime = nowMs + SEEK_EPSILON_MS;
}

function isLive(animation: CSSAnimation): boolean {
  if (animation.playState === "idle" || animation.playState === "finished") return false;
  const target = (animation.effect as KeyframeEffect | null)?.target;
  return Boolean(target?.isConnected);
}

function schedule(): void {
  if (timer != null) {
    clearTimeout(timer);
    timer = null;
  }
  if (loops.size === 0 || document.visibilityState === "hidden") return;
  let next = Infinity;
  for (const loop of loops.values()) next = Math.min(next, loop.nextAtMs);
  timer = setTimeout(tick, Math.max(0, next - performance.now()));
}

function tick(): void {
  timer = null;
  const now = performance.now();
  for (const [animation, loop] of loops) {
    if (!isLive(animation)) {
      loops.delete(animation);
      continue;
    }
    if (loop.nextAtMs > now + BATCH_WINDOW_MS) continue;
    // A loop CSS has paused (`animation-play-state: paused`) holds still.
    if (animation.playState !== "paused") seek(loop, now);
    loop.nextAtMs = nextChangeAt(loop, now + SEEK_EPSILON_MS);
  }
  schedule();
}

// A hidden window draws nothing, so the clock stops with it and catches every
// loop up to the current step when the window shows again.
function onVisibilityChange(): void {
  if (document.visibilityState === "hidden") {
    schedule();
    return;
  }
  const now = performance.now();
  for (const [animation, loop] of loops) {
    if (!isLive(animation)) {
      loops.delete(animation);
      continue;
    }
    if (animation.playState !== "paused") seek(loop, now);
    loop.nextAtMs = nextChangeAt(loop, now + SEEK_EPSILON_MS);
  }
  schedule();
}

/**
 * Hands a running infinite CSS loop to the shared step clock when it is
 * stepped and slow enough; otherwise leaves it to CSS. Safe to call more than
 * once for the same animation.
 */
export function adoptSteppedLoop(animation: CSSAnimation): void {
  if (loops.has(animation) || animation.playState !== "running") return;
  const effect = animation.effect;
  if (!(effect instanceof KeyframeEffect)) return;
  const timing = effect.getTiming();
  const durationMs = Number(timing.duration);
  if (timing.iterations !== Infinity || !(durationMs > 0)) return;
  if ((timing.easing ?? "linear") !== "linear" || (timing.iterationStart ?? 0) !== 0) return;
  if (animation.playbackRate !== 1) return;
  const changes = stepChangeFractions(animation);
  if (!changes) return;
  if ((changes.length * 1000) / durationMs > MAX_CHANGES_PER_SECOND) return;

  const loop: SteppedLoop = { animation, durationMs, delayMs: timing.delay ?? 0, changes, nextAtMs: 0 };
  const now = performance.now();
  animation.playbackRate = 0;
  seek(loop, now);
  loop.nextAtMs = nextChangeAt(loop, now + SEEK_EPSILON_MS);
  loops.set(animation, loop);
  if (!visibilityListening) {
    visibilityListening = true;
    document.addEventListener("visibilitychange", onVisibilityChange);
  }
  schedule();
}
