/**
 * Turns a recording's track and analysis into the demo plan an engine
 * executes. Pure: no I/O, no clocks, so every rule here is testable with plain
 * numbers.
 *
 * ## Time: what plays, what speeds up, what is cut
 *
 * The source is split into 0.1 s bins. Each bin gets a screen level from the
 * analysis (still, busy or active) and a context from the track, and the pair
 * decides what the bin does:
 *
 * - The moment of an action (0.3 s before it to 1.2 s after) always plays at
 *   normal speed, so a viewer sees the click land.
 * - A page load is waiting on the app: a changing screen speeds up.
 * - The few seconds after an action show its result: a large change plays at
 *   normal speed, a small one (a spinner, a progress bar) speeds up.
 * - Otherwise the agent's state decides. While it thinks, or between turns,
 *   nothing on the screen is caused by it, so any change counts as still. While
 *   a tool runs, a changing screen speeds up. A recording with no agent (a
 *   person's own) plays large changes and speeds up small ones.
 *
 * A still stretch longer than 2 s keeps 0.75 s and the rest is cut. A speed-up
 * picks 2×, 4×, 8× or 16× so the stretch plays in about 2.5 s; past 16× the
 * middle is cut and the start and the end stay.
 *
 * ## Picture
 *
 * Clicks, taps, typing, drags and scrolls with a point zoom the camera to that
 * point (at most 2×, less when the element would not fit), unless the screen
 * changes as a whole right after, which is a new page best seen in full.
 * Nearby actions share one zoom and the camera pans between them. Surfaces with
 * a mouse get a drawn pointer that glides to each action; clicks and taps get
 * a ring. Step captions from `ade proof step` show at the bottom; with none,
 * the actions' own labels do.
 *
 * ## Size
 *
 * The output fits {@link DEMO_TARGET_BYTES}: the size and frame rate step down
 * a ladder until the bitrate that fits is high enough to read text. Past the
 * last step the timing gets stricter (shorter holds, faster speed-ups) before
 * the bitrate may drop below that floor.
 */

import {
  DEMO_TARGET_BYTES,
  type DemoAnalysis,
  type DemoAnalysisFrame,
  type DemoArtifactMetadata,
  type DemoBadge,
  type DemoCameraKey,
  type DemoCaption,
  type DemoCursorKey,
  type DemoEngineId,
  type DemoOutput,
  type DemoPlan,
  type DemoRing,
  type DemoSegment,
  type DemoStyle,
  type DemoTrack,
  type DemoTrackEvent,
} from "./demoContract";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const BIN_SECONDS = 0.1;

/** Changed fraction at or above which a frame is a large change. */
const ACTIVE_CHANGED = 0.01;
/** A smaller change still counts as large when it covers this much of the frame. */
const ACTIVE_BOX_AREA = 0.02;
const ACTIVE_BOX_MIN_CHANGED = 0.003;
/** Below this a change is noise: a caret, a clock. ScreenChange's 0.1 %. */
const BUSY_CHANGED = 0.001;
/** How long one changed frame keeps its bin level, in seconds. */
const ACTIVITY_CARRY = 0.6;
/**
 * A change too small to count on its own (a thin progress bar, a spinner)
 * still counts as busy when it repeats this many times in a second. A caret
 * blinks twice a second, so it stays still.
 */
const STEADY_CHANGES_PER_SECOND = 4;
/** A cut this long shows a "skipped" badge, so a viewer knows time passed. */
const SKIP_BADGE_MIN_SECONDS = 3;
const SKIP_BADGE_SECONDS = 1.2;

const MOMENT_BEFORE = 0.3;
const MOMENT_AFTER = 1.2;
const RESULT_WINDOW = 4.0;
const OPENING_MOMENT = 0.5;
const LOAD_END_MOMENT = 1.0;

type Timing = {
  stillThreshold: number;
  stillKeep: number;
  speedMinRun: number;
  speedTargetOutput: number;
};
const NORMAL_TIMING: Timing = { stillThreshold: 2.0, stillKeep: 0.75, speedMinRun: 1.5, speedTargetOutput: 2.5 };
const STRICT_TIMING: Timing = { stillThreshold: 1.0, stillKeep: 0.4, speedMinRun: 1.0, speedTargetOutput: 1.5 };
const SPEEDS = [2, 4, 8, 16] as const;

const ZOOM_MAX = 2.0;
const ZOOM_MAX_SMALL_SOURCE = 1.6;
/** A phone screen is small in the video already: a light zoom, briefly. */
const ZOOM_MAX_PHONE = 1.3;
const ZOOM_HOLD_AFTER_PHONE = 1.0;
const ZOOM_RAMP_PHONE = 0.35;
const ZOOM_OUT_PHONE = 0.45;
/** How much of the view a scene's boxes may fill; the rest is margin. */
const VIEW_FILL = 0.7;
/** Half the side of the square an action with only a point is given. */
const FOCUS_POINT_HALF = 0.06;
const ZOOM_MIN_USEFUL = 1.25;
const ZOOM_LEAD = 0.6;
const ZOOM_RAMP = 0.5;
const ZOOM_HOLD_AFTER = 2.5;
const ZOOM_OUT = 0.6;
const ZOOM_IGNORE_TAIL = 1.0;
/** A change this large right after an action is a new page: no zoom. */
const WHOLE_SCREEN_AREA = 0.5;
const WHOLE_SCREEN_CHANGED = 0.05;
const CAMERA_SAMPLE_SECONDS = 1 / 15;
/** A scene zoom that would hold shorter than this is left out: it only flickers. */
const SCENE_MIN_HOLD = 1.5;
/** Two zooms closer than this (after the zoom out) join: the camera moves straight across. */
const CAMERA_JOIN_GAP = 0.8;

const POINTER_SURFACES = new Set<DemoTrack["surface"]>(["mac-desktop", "app-control", "browser"]);
const POINTER_GLIDE = 0.6;
const POINTER_APPEAR_BEFORE = 0.8;
const POINTER_SAMPLE_SECONDS = 1 / 20;

const STEP_CAPTION_MAX = 5.0;
const ACTION_CAPTION = 2.0;
const CAPTION_MIN = 0.8;
const CAPTION_MAX_CHARS = 60;

export const DEMO_STYLE: DemoStyle = {
  accent: "#A78BFA",
  ringDurationSeconds: 0.45,
  ringStartRadius: 0.012,
  ringEndRadius: 0.04,
  ringLineWidth: 0.004,
  pointerHeight: 0.035,
  captionFontSize: 0.034,
  captionMargin: 0.05,
  badgeFontSize: 0.028,
};

// ---------------------------------------------------------------------------
// Output size and bitrate
// ---------------------------------------------------------------------------

type Rung = { longSide: number; shortSide: number; fps: number };
const LADDER: Rung[] = [
  { longSide: 1920, shortSide: 1080, fps: 30 },
  { longSide: 1280, shortSide: 720, fps: 30 },
  { longSide: 1280, shortSide: 720, fps: 15 },
  { longSide: 1280, shortSide: 720, fps: 10 },
  { longSide: 960, shortSide: 540, fps: 10 },
];
/** Bits per pixel per frame below which screen text blurs (1080p30 ≈ 470 kbps, measured). */
const FLOOR_BITS_PER_PIXEL_FRAME = 0.0075;
/** Above this, more bits buy nothing for screen content. */
const CEILING_BITS_PER_PIXEL_FRAME = 0.1;
/** The MP4 container and rate-control slack. */
const BUDGET_SLACK = 0.97;
const KEYFRAME_INTERVAL = 2;

function even(value: number): number {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function sizeFor(source: { width: number; height: number }, rung: Rung): { width: number; height: number } {
  const landscape = source.width >= source.height;
  const maxWidth = landscape ? rung.longSide : rung.shortSide;
  const maxHeight = landscape ? rung.shortSide : rung.longSide;
  const scale = Math.min(1, maxWidth / source.width, maxHeight / source.height);
  return { width: even(source.width * scale), height: even(source.height * scale) };
}

function floorBitrate(output: { width: number; height: number; fps: number }): number {
  return output.width * output.height * output.fps * FLOOR_BITS_PER_PIXEL_FRAME;
}

/** The first ladder step, from `startRung`, whose fitting bitrate reads well. */
function chooseOutput(
  source: { width: number; height: number },
  durationSeconds: number,
  budgetBits: number,
  startRung = 0,
): { output: DemoOutput; belowFloor: boolean; rung: number } {
  const budgetRate = budgetBits / Math.max(durationSeconds, 0.5);
  for (let index = Math.max(0, startRung); index < LADDER.length; index += 1) {
    const rung = LADDER[index]!;
    const size = sizeFor(source, rung);
    const ceiling = size.width * size.height * rung.fps * CEILING_BITS_PER_PIXEL_FRAME;
    const bitrate = Math.floor(Math.min(budgetRate, ceiling));
    if (bitrate >= floorBitrate({ ...size, fps: rung.fps }) || index === LADDER.length - 1) {
      return {
        output: { ...size, fps: rung.fps, bitrate: Math.max(bitrate, 50_000), keyframeIntervalSeconds: KEYFRAME_INTERVAL },
        belowFloor: bitrate < floorBitrate({ ...size, fps: rung.fps }),
        rung: index,
      };
    }
  }
  throw new Error("unreachable: the ladder always returns");
}

function rungOf(output: DemoOutput, source: { width: number; height: number }): number {
  const index = LADDER.findIndex((rung) => {
    const size = sizeFor(source, rung);
    return size.width === output.width && size.height === output.height && rung.fps === output.fps;
  });
  return index < 0 ? 0 : index;
}

/**
 * A render came out at `measuredBytes`, over the limit. The same plan with a
 * bitrate scaled to fit, one ladder step smaller when that bitrate would blur.
 */
export function refitPlanForSize(plan: DemoPlan, measuredBytes: number, options: { stepDown?: boolean } = {}): DemoPlan {
  const ratio = DEMO_TARGET_BYTES / Math.max(measuredBytes, 1);
  const bitrate = Math.floor(plan.output.bitrate * ratio * 0.92);
  let rung = rungOf(plan.output, plan.source);
  let output: DemoOutput = { ...plan.output, bitrate };
  // An encoder that overshot twice will not honour a lower bitrate at this
  // size (it has a floor of its own); fewer pixels and frames is what shrinks it.
  if (options.stepDown && rung < LADDER.length - 1) {
    rung += 1;
    const step = LADDER[rung]!;
    output = { ...sizeFor(plan.source, step), fps: step.fps, bitrate, keyframeIntervalSeconds: KEYFRAME_INTERVAL };
  }
  while (bitrate < floorBitrate(output) && rung < LADDER.length - 1) {
    rung += 1;
    const step = LADDER[rung]!;
    output = { ...sizeFor(plan.source, step), fps: step.fps, bitrate, keyframeIntervalSeconds: KEYFRAME_INTERVAL };
  }
  output.bitrate = Math.max(bitrate, 50_000);
  return { ...plan, output };
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

type Level = 0 | 1 | 2; // still, busy, active
type Decision = "play" | "speed" | "still";

function frameLevel(frame: DemoAnalysis["frames"][number]): Level {
  const area = frame.box ? frame.box[2] * frame.box[3] : 0;
  if (frame.changed >= ACTIVE_CHANGED || (area >= ACTIVE_BOX_AREA && frame.changed >= ACTIVE_BOX_MIN_CHANGED)) return 2;
  if (frame.changed >= BUSY_CHANGED) return 1;
  return 0;
}

function isScreenAction(event: DemoTrackEvent): boolean {
  return event.kind !== "step";
}

function decideBins(track: DemoTrack | null, analysis: DemoAnalysis, duration: number): Decision[] {
  const count = Math.max(1, Math.ceil(duration / BIN_SECONDS));
  const levels = new Array<Level>(count).fill(0);
  // A capture sends a frame only when the screen changes, so a page that
  // paints twice a second leaves empty bins between its frames. A change
  // therefore counts for ACTIVITY_CARRY after its frame; without that, a load
  // splits into pieces too short to speed up or to cut.
  const carryBins = Math.round(ACTIVITY_CARRY / BIN_SECONDS);
  // Steady tiny changes: count the frames with any change in each bin, then
  // mark as busy every bin whose surrounding second has enough of them.
  const tinyPerBin = new Array<number>(count).fill(0);
  analysis.frames.forEach((frame, index) => {
    if (index === 0 && frame.t <= BIN_SECONDS) return;
    if (frame.changed > 0 && frameLevel(frame) === 0) {
      const bin = Math.min(count - 1, Math.max(0, Math.floor(frame.t / BIN_SECONDS)));
      tinyPerBin[bin] = (tinyPerBin[bin] ?? 0) + 1;
    }
  });
  const span = Math.round(1 / BIN_SECONDS);
  let running = 0;
  for (let bin = 0; bin < count + span; bin += 1) {
    if (bin < count) running += tinyPerBin[bin]!;
    if (bin - span >= 0) running -= tinyPerBin[bin - span]!;
    const center = bin - Math.floor(span / 2);
    if (center >= 0 && center < count && running >= STEADY_CHANGES_PER_SECOND) {
      levels[center] = Math.max(levels[center]!, 1) as Level;
    }
  }

  analysis.frames.forEach((frame, index) => {
    if (index === 0 && frame.t <= BIN_SECONDS) return;
    const level = frameLevel(frame);
    if (level === 0) return;
    const first = Math.min(count - 1, Math.max(0, Math.floor(frame.t / BIN_SECONDS)));
    for (let bin = first; bin <= Math.min(count - 1, first + carryBins); bin += 1) {
      levels[bin] = Math.max(levels[bin]!, level) as Level;
    }
  });

  const moments = new Array<boolean>(count).fill(false);
  const results = new Array<boolean>(count).fill(false);
  const loads = new Array<boolean>(count).fill(false);
  const mark = (target: boolean[], start: number, end: number) => {
    const from = Math.max(0, Math.floor(start / BIN_SECONDS));
    const to = Math.min(count - 1, Math.ceil(end / BIN_SECONDS) - 1);
    for (let bin = from; bin <= to; bin += 1) target[bin] = true;
  };
  mark(moments, 0, OPENING_MOMENT);
  for (const event of track?.events ?? []) {
    if (!isScreenAction(event)) continue;
    mark(moments, event.t - MOMENT_BEFORE, event.t + MOMENT_AFTER);
    mark(results, event.t + MOMENT_AFTER, event.t + RESULT_WINDOW);
  }
  for (const load of track?.loadSpans ?? []) {
    mark(loads, load.start, load.end);
    mark(moments, load.end, load.end + LOAD_END_MOMENT);
  }

  const knowsAgent = (track?.agentSpans.length ?? 0) > 0;
  const agentAt = (time: number): "thinking" | "tool" | "none" => {
    for (const span of track?.agentSpans ?? []) {
      if (time >= span.start && time < span.end) return span.state;
    }
    return "none";
  };

  /** Active plays, busy speeds up, still is still. */
  const byLevel = (level: Level): Decision => (level === 2 ? "play" : level === 1 ? "speed" : "still");
  const decisions = new Array<Decision>(count);
  for (let bin = 0; bin < count; bin += 1) {
    const level = levels[bin]!;
    const time = (bin + 0.5) * BIN_SECONDS;
    if (moments[bin]) decisions[bin] = "play";
    else if (loads[bin]) decisions[bin] = level === 0 ? "still" : "speed";
    else if (results[bin] || !knowsAgent) decisions[bin] = byLevel(level);
    else {
      const agent = agentAt(time);
      decisions[bin] = agent === "tool" ? (level === 0 ? "still" : "speed") : "still";
    }
  }
  return decisions;
}

function buildSegments(decisions: Decision[], duration: number, timing: Timing): DemoSegment[] {
  const pieces: Array<{ start: number; end: number; speed: number }> = [];
  let runStart = 0;
  for (let bin = 1; bin <= decisions.length; bin += 1) {
    if (bin < decisions.length && decisions[bin] === decisions[runStart]) continue;
    const start = runStart * BIN_SECONDS;
    const end = Math.min(duration, bin * BIN_SECONDS);
    const length = end - start;
    const decision = decisions[runStart]!;
    if (length > 0) {
      if (decision === "play") {
        pieces.push({ start, end, speed: 1 });
      } else if (decision === "still") {
        pieces.push({ start, end: length <= timing.stillThreshold ? end : start + timing.stillKeep, speed: 1 });
      } else if (length < timing.speedMinRun) {
        pieces.push({ start, end, speed: 1 });
      } else {
        const speed = SPEEDS.find((candidate) => length / candidate <= timing.speedTargetOutput) ?? SPEEDS[SPEEDS.length - 1]!;
        const keepEach = (speed * timing.speedTargetOutput) / 2;
        if (length / speed <= timing.speedTargetOutput) {
          pieces.push({ start, end, speed });
        } else {
          pieces.push({ start, end: start + keepEach, speed });
          pieces.push({ start: end - keepEach, end, speed });
        }
      }
    }
    runStart = bin;
  }

  const segments: DemoSegment[] = [];
  let output = 0;
  for (const piece of pieces) {
    const sourceLength = piece.end - piece.start;
    if (sourceLength <= 1e-6) continue;
    const outputLength = sourceLength / piece.speed;
    const last = segments[segments.length - 1];
    const lastSpeed = last ? (last.sourceEnd - last.sourceStart) / (last.outputEnd - last.outputStart) : 0;
    if (last && Math.abs(last.sourceEnd - piece.start) < 1e-6 && Math.abs(lastSpeed - piece.speed) < 1e-6) {
      last.sourceEnd = piece.end;
      last.outputEnd = output + outputLength;
    } else {
      segments.push({ outputStart: output, outputEnd: output + outputLength, sourceStart: piece.start, sourceEnd: piece.end });
    }
    output += outputLength;
  }
  if (segments.length === 0) {
    const keep = Math.min(duration, timing.stillKeep);
    segments.push({ outputStart: 0, outputEnd: keep, sourceStart: 0, sourceEnd: keep });
  }
  return segments;
}

function speedOf(segment: DemoSegment): number {
  const output = segment.outputEnd - segment.outputStart;
  return output > 0 ? (segment.sourceEnd - segment.sourceStart) / output : 1;
}

/**
 * The output time of source time `s`. A time inside a cut maps to the start
 * of the next kept stretch (or the end), so an action there still lands on a
 * frame that shows its result.
 */
export function sourceToOutput(segments: DemoSegment[], s: number): number {
  for (const segment of segments) {
    if (s < segment.sourceStart) return segment.outputStart;
    if (s <= segment.sourceEnd) return segment.outputStart + (s - segment.sourceStart) / speedOf(segment);
  }
  return segments[segments.length - 1]?.outputEnd ?? 0;
}

// ---------------------------------------------------------------------------
// Camera, pointer, rings
// ---------------------------------------------------------------------------

function easeInOutCubic(p: number): number {
  const x = Math.min(Math.max(p, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

function clampCenter(center: number, zoom: number): number {
  const half = 0.5 / Math.max(zoom, 1);
  return Math.min(Math.max(center, half), 1 - half);
}

type Box = [number, number, number, number];
type View = { zoom: number; cx: number; cy: number };

/** The area an action touches: its element, or a small square around its point. */
function focusBox(event: DemoTrackEvent): Box | null {
  if (event.rect && event.rect[2] > 0 && event.rect[3] > 0) return event.rect;
  const point = typeof event.x === "number" && typeof event.y === "number" ? { x: event.x, y: event.y } : null;
  if (!point) return null;
  const half = FOCUS_POINT_HALF;
  return [point.x - half, point.y - half, half * 2, half * 2];
}

/**
 * One view that holds every box, with a margin, or null when that view is too
 * wide to be worth a zoom.
 */
function viewFor(boxes: readonly Box[], maxZoom: number): View | null {
  const left = Math.min(...boxes.map((box) => box[0]));
  const top = Math.min(...boxes.map((box) => box[1]));
  const right = Math.max(...boxes.map((box) => box[0] + box[2]));
  const bottom = Math.max(...boxes.map((box) => box[1] + box[3]));
  const width = Math.max(right - left, 0.001);
  const height = Math.max(bottom - top, 0.001);
  const zoom = Math.min(maxZoom, VIEW_FILL / width, VIEW_FILL / height);
  if (zoom < ZOOM_MIN_USEFUL) return null;
  return { zoom, cx: left + width / 2, cy: top + height / 2 };
}

function focusPoint(event: DemoTrackEvent): { x: number; y: number } | null {
  if (event.rect) return { x: event.rect[0] + event.rect[2] / 2, y: event.rect[1] + event.rect[3] / 2 };
  if (typeof event.x === "number" && typeof event.y === "number") return { x: event.x, y: event.y };
  return null;
}

function eventPoint(event: DemoTrackEvent): { x: number; y: number } | null {
  if (typeof event.x === "number" && typeof event.y === "number") return { x: event.x, y: event.y };
  return focusPoint(event);
}

const ZOOM_KINDS = new Set<DemoTrackEvent["kind"]>(["click", "tap", "type", "drag", "scroll"]);

type CameraWindow = { inStart: number; inEnd: number; holdEnd: number; view: View };

/** Writes camera keys: zoom in, hold, zoom out, or move straight to the next view when it comes soon. */
function cameraKeys(windows: CameraWindow[], outputDuration: number, out: number): DemoCameraKey[] {
  const keys: DemoCameraKey[] = [{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }];
  const push = (t: number, zoom: number, cx: number, cy: number) => {
    const clamped = Math.min(Math.max(t, 0), outputDuration);
    const last = keys[keys.length - 1]!;
    if (clamped < last.t - 1e-9) return;
    const key = { t: clamped, zoom, cx: clampCenter(cx, zoom), cy: clampCenter(cy, zoom) };
    if (Math.abs(clamped - last.t) < 1e-9) keys[keys.length - 1] = key;
    else keys.push(key);
  };
  const transition = (from: { t: number; view: View }, to: { t: number; view: View }) => {
    const span = to.t - from.t;
    if (span <= 0) {
      push(to.t, to.view.zoom, to.view.cx, to.view.cy);
      return;
    }
    // Ease the clamped centers, so a view at an edge does not drift in or out.
    const a = { zoom: from.view.zoom, cx: clampCenter(from.view.cx, from.view.zoom), cy: clampCenter(from.view.cy, from.view.zoom) };
    const b = { zoom: to.view.zoom, cx: clampCenter(to.view.cx, to.view.zoom), cy: clampCenter(to.view.cy, to.view.zoom) };
    const steps = Math.max(1, Math.ceil(span / CAMERA_SAMPLE_SECONDS));
    for (let step = 0; step <= steps; step += 1) {
      const p = easeInOutCubic(step / steps);
      push(from.t + span * (step / steps), a.zoom + (b.zoom - a.zoom) * p, a.cx + (b.cx - a.cx) * p, a.cy + (b.cy - a.cy) * p);
    }
  };
  const whole: View = { zoom: 1, cx: 0.5, cy: 0.5 };
  let open: CameraWindow | null = null;
  for (const window of windows) {
    if (open && window.inStart < open.holdEnd + out + CAMERA_JOIN_GAP) {
      // The next view comes before the camera could settle out: move to it.
      const from = Math.max(keys[keys.length - 1]!.t, open.holdEnd);
      transition({ t: from, view: open.view }, { t: Math.max(from + ZOOM_RAMP, window.inEnd), view: window.view });
    } else {
      if (open) transition({ t: Math.max(keys[keys.length - 1]!.t, open.holdEnd), view: open.view }, { t: open.holdEnd + out, view: whole });
      const inStart = Math.max(keys[keys.length - 1]!.t, window.inStart);
      transition({ t: inStart, view: whole }, { t: Math.max(inStart, window.inEnd), view: window.view });
    }
    push(Math.max(keys[keys.length - 1]!.t, window.holdEnd), window.view.zoom, window.view.cx, window.view.cy);
    open = window;
  }
  if (open) {
    if (open.holdEnd + out <= outputDuration + 1e-9) {
      transition({ t: Math.max(keys[keys.length - 1]!.t, open.holdEnd), view: open.view }, { t: open.holdEnd + out, view: whole });
    } else {
      push(outputDuration, open.view.zoom, open.view.cx, open.view.cy);
    }
  }
  return keys;
}

/**
 * The camera for a computer screen: ONE steady view per scene.
 *
 * A scene ends at a navigation or at a change of the whole screen (a new page,
 * a new window). Inside a scene the camera zooms in once, to a view that holds
 * every action of the scene and every part of the screen those actions
 * changed (the field, the button, the list that grew), holds it, and zooms out
 * when the scene ends. It never moves between the actions of a scene: moving
 * to each action, and zooming out and in between them, made the camera jump
 * about (2026-09-28). A scene whose view is almost the whole screen, or whose
 * zoom would last only a moment, gets no zoom.
 */
function planSceneCamera(
  track: DemoTrack | null,
  analysis: DemoAnalysis,
  segments: DemoSegment[],
  outputDuration: number,
): DemoCameraKey[] {
  const longSide = Math.max(analysis.width, analysis.height);
  const maxZoom = longSide < 1400 ? ZOOM_MAX_SMALL_SOURCE : ZOOM_MAX;
  const events = (track?.events ?? []).filter(isScreenAction);

  const wholeScreenAt = (frame: DemoAnalysisFrame) =>
    frame.changed >= WHOLE_SCREEN_CHANGED && Boolean(frame.box && frame.box[2] * frame.box[3] >= WHOLE_SCREEN_AREA);
  const cuts = [
    ...events.filter((event) => event.kind === "navigate").map((event) => event.t),
    // The first frame reports the whole screen as changed; it is not a cut.
    ...analysis.frames.filter((frame, index) => index > 0 && wholeScreenAt(frame)).map((frame) => frame.t),
  ].sort((a, b) => a - b);

  type Scene = { start: number; end: number; foci: Array<{ t: number; box: Box }> };
  const scenes: Scene[] = [];
  let sceneStart = 0;
  for (const cut of [...cuts, Number.POSITIVE_INFINITY]) {
    if (cut <= sceneStart) continue;
    scenes.push({ start: sceneStart, end: Math.min(cut, analysis.durationSeconds), foci: [] });
    sceneStart = cut;
  }
  for (const event of events) {
    if (!ZOOM_KINDS.has(event.kind)) continue;
    const box = focusBox(event);
    // Typing with no box goes into the field clicked before it, which the
    // scene already holds.
    if (!box) continue;
    const scene = scenes.find((candidate) => event.t >= candidate.start && event.t < candidate.end);
    scene?.foci.push({ t: event.t, box });
  }

  const windows: CameraWindow[] = [];
  for (const scene of scenes) {
    if (scene.foci.length === 0) continue;
    const firstT = scene.foci[0]!.t;
    const lastT = scene.foci[scene.foci.length - 1]!.t;
    const changed = analysis.frames
      .filter((frame) =>
        frame.t >= firstT
        && frame.t <= Math.min(lastT + RESULT_WINDOW, scene.end)
        && frameLevel(frame) === 2
        && frame.box
        && !wholeScreenAt(frame))
      .map((frame) => frame.box as Box);
    const view = viewFor([...scene.foci.map((focus) => focus.box), ...changed], maxZoom);
    if (!view) continue;
    const firstO = sourceToOutput(segments, firstT);
    const inStart = Math.max(0, firstO - ZOOM_LEAD);
    const inEnd = Math.max(inStart, Math.min(firstO - 0.1, inStart + ZOOM_RAMP));
    const holdEnd = Math.min(
      sourceToOutput(segments, lastT) + ZOOM_HOLD_AFTER,
      sourceToOutput(segments, scene.end) - ZOOM_OUT,
      outputDuration - ZOOM_OUT,
    );
    if (holdEnd - inEnd < SCENE_MIN_HOLD) continue;
    windows.push({ inStart, inEnd, holdEnd, view });
  }
  return cameraKeys(windows, outputDuration, ZOOM_OUT);
}

/**
 * The camera for a phone: none, unless the recording asked for zoom
 * (`record start --zoom`). Then each tap alone gets a light, short zoom. A
 * phone screen is already small in the video.
 */
function planPhoneCamera(
  track: DemoTrack | null,
  segments: DemoSegment[],
  outputDuration: number,
): DemoCameraKey[] {
  if (track?.zoom !== true) return [{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }];
  const windows: CameraWindow[] = [];
  for (const event of track.events) {
    if (event.kind !== "tap") continue;
    const box = focusBox(event);
    const view = box ? viewFor([box], ZOOM_MAX_PHONE) : null;
    if (!view) continue;
    const o = sourceToOutput(segments, event.t);
    if (o > outputDuration - ZOOM_IGNORE_TAIL) continue;
    const inStart = Math.max(0, o - ZOOM_LEAD, windows.length ? windows[windows.length - 1]!.holdEnd + ZOOM_OUT_PHONE : 0);
    const inEnd = Math.max(inStart, Math.min(o - 0.1, inStart + ZOOM_RAMP_PHONE));
    const holdEnd = Math.min(o + ZOOM_HOLD_AFTER_PHONE, outputDuration - ZOOM_OUT_PHONE);
    if (holdEnd <= inEnd) continue;
    windows.push({ inStart, inEnd, holdEnd, view });
  }
  return cameraKeys(windows, outputDuration, ZOOM_OUT_PHONE);
}

function planCamera(
  track: DemoTrack | null,
  analysis: DemoAnalysis,
  segments: DemoSegment[],
  outputDuration: number,
): DemoCameraKey[] {
  return track?.surface === "apple"
    ? planPhoneCamera(track, segments, outputDuration)
    : planSceneCamera(track, analysis, segments, outputDuration);
}

const POINTER_KINDS = new Set<DemoTrackEvent["kind"]>(["click", "drag", "type", "scroll"]);
const RING_KINDS = new Set<DemoTrackEvent["kind"]>(["click", "tap", "drag"]);

function planPointer(track: DemoTrack | null, segments: DemoSegment[]): { cursor: DemoCursorKey[]; rings: DemoRing[] } {
  const rings: DemoRing[] = [];
  const cursor: DemoCursorKey[] = [];
  if (!track) return { cursor, rings };
  const hasPointer = POINTER_SURFACES.has(track.surface);
  let previous: { o: number; x: number; y: number } | null = null;
  const push = (key: DemoCursorKey) => {
    const last = cursor[cursor.length - 1];
    if (last && key.t < last.t - 1e-9) return;
    if (last && Math.abs(key.t - last.t) < 1e-9) cursor[cursor.length - 1] = key;
    else cursor.push(key);
  };
  for (const event of track.events) {
    const point = eventPoint(event);
    if (!point) continue;
    const o = sourceToOutput(segments, event.t);
    if (RING_KINDS.has(event.kind)) rings.push({ t: o, x: point.x, y: point.y });
    if (!hasPointer || !POINTER_KINDS.has(event.kind)) continue;
    if (!previous) {
      const appear = Math.max(0, o - POINTER_APPEAR_BEFORE);
      if (appear > 0) push({ t: 0, x: point.x, y: point.y, visible: false });
      push({ t: appear, x: point.x, y: point.y, visible: true });
      push({ t: o, x: point.x, y: point.y, visible: true });
    } else {
      const glideStart = Math.max(previous.o + 0.15, o - POINTER_GLIDE);
      if (glideStart >= o) {
        push({ t: o, x: point.x, y: point.y, visible: true });
      } else {
        push({ t: glideStart, x: previous.x, y: previous.y, visible: true });
        const steps = Math.max(1, Math.ceil((o - glideStart) / POINTER_SAMPLE_SECONDS));
        for (let step = 1; step <= steps; step += 1) {
          const p = easeInOutCubic(step / steps);
          push({
            t: glideStart + (o - glideStart) * (step / steps),
            x: previous.x + (point.x - previous.x) * p,
            y: previous.y + (point.y - previous.y) * p,
            visible: true,
          });
        }
      }
    }
    previous = { o, x: point.x, y: point.y };
  }
  return { cursor, rings };
}

// ---------------------------------------------------------------------------
// Captions and badges
// ---------------------------------------------------------------------------

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CAPTION_MAX_CHARS ? `${flat.slice(0, CAPTION_MAX_CHARS - 1)}…` : flat;
}

function actionCaption(event: DemoTrackEvent): string | null {
  if (!event.label) return null;
  switch (event.kind) {
    case "click":
      return `Click ${event.label}`;
    case "tap":
      return `Tap ${event.label}`;
    case "type":
      return `Type “${event.label}”`;
    case "navigate":
      return `Open ${event.label}`;
    case "key":
      return `Press ${event.label}`;
    default:
      return null;
  }
}

function planCaptions(track: DemoTrack | null, segments: DemoSegment[], outputDuration: number): DemoCaption[] {
  const events = track?.events ?? [];
  const steps = events.filter((event) => event.kind === "step" && event.label);
  const raw: Array<{ start: number; text: string; max: number }> = steps.length > 0
    ? steps.map((event) => ({ start: sourceToOutput(segments, event.t), text: event.label!, max: STEP_CAPTION_MAX }))
    : events.flatMap((event) => {
      const text = actionCaption(event);
      return text ? [{ start: sourceToOutput(segments, event.t), text, max: ACTION_CAPTION }] : [];
    });
  raw.sort((a, b) => a.start - b.start);

  const captions: DemoCaption[] = [];
  raw.forEach((caption, index) => {
    const next = raw[index + 1];
    const end = Math.min(outputDuration, caption.start + caption.max, next ? next.start : Infinity);
    // One caption at a time: one that the next replaces at once is not shown.
    if (end - caption.start < CAPTION_MIN && next) return;
    if (end <= caption.start) return;
    captions.push({ start: caption.start, end, text: shorten(caption.text) });
  });
  return captions;
}

function planBadges(segments: DemoSegment[]): DemoBadge[] {
  const badges: DemoBadge[] = [];
  segments.forEach((segment, index) => {
    const previous = segments[index - 1];
    if (!previous) return;
    const skipped = segment.sourceStart - previous.sourceEnd;
    if (skipped < SKIP_BADGE_MIN_SECONDS) return;
    const whole = Math.round(skipped);
    const label = `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
    badges.push({ start: segment.outputStart, end: Math.min(segment.outputEnd, segment.outputStart + SKIP_BADGE_SECONDS), text: `skipped ${label}` });
  });
  for (const segment of segments) {
    const speed = Math.round(speedOf(segment));
    if (speed <= 1) continue;
    const text = `${speed}×`;
    const last = badges[badges.length - 1];
    if (last && last.text === text && Math.abs(last.end - segment.outputStart) < 1e-6) last.end = segment.outputEnd;
    else badges.push({ start: segment.outputStart, end: segment.outputEnd, text });
  }
  // One badge at a time, in time order: a speed-up that starts where a skip
  // badge is showing takes over from it.
  badges.sort((a, b) => a.start - b.start);
  for (let index = 0; index < badges.length - 1; index += 1) {
    const current = badges[index]!;
    const next = badges[index + 1]!;
    if (current.end > next.start) current.end = next.start;
  }
  return badges.filter((badge) => badge.end - badge.start > 0.05);
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

function sourceDuration(analysis: DemoAnalysis): number {
  const lastFrame = analysis.frames[analysis.frames.length - 1]?.t ?? 0;
  const duration = Math.max(analysis.durationSeconds, lastFrame);
  if (!Number.isFinite(duration) || duration <= 0 || analysis.width <= 0 || analysis.height <= 0) {
    throw new Error("The recording has no frames to make a video from.");
  }
  return duration;
}

/** The plan for `--plain`: the whole recording at normal speed, sized to fit. */
export function planPlainDemo(analysis: DemoAnalysis): DemoPlan {
  const duration = sourceDuration(analysis);
  const source = { width: analysis.width, height: analysis.height };
  const { output } = chooseOutput(source, duration, DEMO_TARGET_BYTES * 8 * BUDGET_SLACK);
  return {
    version: 1,
    source,
    output,
    durationSeconds: duration,
    segments: [{ outputStart: 0, outputEnd: duration, sourceStart: 0, sourceEnd: duration }],
    camera: [{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }],
    cursor: [],
    rings: [],
    captions: [],
    badges: [],
    style: DEMO_STYLE,
  };
}

export function planDemo(input: { track: DemoTrack | null; analysis: DemoAnalysis; plain?: boolean }): DemoPlan {
  if (input.plain) return planPlainDemo(input.analysis);
  const duration = sourceDuration(input.analysis);
  const source = { width: input.analysis.width, height: input.analysis.height };
  const decisions = decideBins(input.track, input.analysis, duration);
  const budget = DEMO_TARGET_BYTES * 8 * BUDGET_SLACK;

  let segments = buildSegments(decisions, duration, NORMAL_TIMING);
  let outputDuration = segments[segments.length - 1]!.outputEnd;
  let fit = chooseOutput(source, outputDuration, budget);
  if (fit.belowFloor) {
    segments = buildSegments(decisions, duration, STRICT_TIMING);
    outputDuration = segments[segments.length - 1]!.outputEnd;
    fit = chooseOutput(source, outputDuration, budget);
  }

  const { cursor, rings } = planPointer(input.track, segments);
  return {
    version: 1,
    source,
    output: fit.output,
    durationSeconds: outputDuration,
    segments,
    camera: planCamera(input.track, input.analysis, segments, outputDuration),
    cursor,
    rings,
    captions: planCaptions(input.track, segments, outputDuration),
    badges: planBadges(segments),
    style: DEMO_STYLE,
  };
}

/** What the filed demo says about itself (`metadata.demo`). */
export function demoMetadataFor(args: {
  plan: DemoPlan;
  analysis: DemoAnalysis;
  track: DemoTrack | null;
  plain: boolean;
  engine: DemoEngineId | null;
}): DemoArtifactMetadata {
  const source = sourceDuration(args.analysis);
  const kept = args.plan.segments.reduce((sum, segment) => sum + (segment.sourceEnd - segment.sourceStart), 0);
  const spedUp = args.plan.segments
    .filter((segment) => speedOf(segment) > 1.001)
    .reduce((sum, segment) => sum + (segment.sourceEnd - segment.sourceStart), 0);
  const steps = args.plain
    ? []
    : (args.track?.events ?? [])
      .filter((event) => event.kind === "step" && event.label)
      .map((event) => ({ t: sourceToOutput(args.plan.segments, event.t), text: shorten(event.label!) }));
  return {
    plain: args.plain,
    engine: args.engine,
    sourceSeconds: source,
    outputSeconds: args.plan.durationSeconds,
    cutSeconds: Math.max(0, source - kept),
    spedUpSourceSeconds: spedUp,
    steps,
  };
}
