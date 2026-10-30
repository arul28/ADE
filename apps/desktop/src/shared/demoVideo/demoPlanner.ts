/**
 * Turns a recording's track and analysis into the demo plan an engine
 * executes. Pure: no I/O, no clocks, so every rule here is testable with plain
 * numbers. The camera lives in `demoCameraPlanner.ts`; this file plans time,
 * the pointer, captions, badges and the output size.
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
 * The camera (see `demoCameraPlanner.ts`): steps with a focus drive it (up to
 * 3×); otherwise a computer recording rests on a home view (the part of the
 * screen where anything happened) and each scene zooms in once (up to 2×),
 * and a phone zooms only when asked. Surfaces with a mouse get a drawn pointer
 * that glides to each action; clicks and taps get a ring. Only step captions
 * from `ade proof step` show: an action's own label ("Click Save") reads like
 * a log, not a demo.
 *
 * A caption sits at the bottom, or at the top when the action during it is
 * low in the view (typing into a prompt box), so it never covers what it
 * describes. Badges sit top right, one at a time: a speed-up shows its speed
 * ("4×"), and a key press shows its key ("Cmd + K", "Enter") when it is a
 * named key or has a Cmd, Ctrl, Alt or Meta modifier; a bare character is
 * never shown. A key badge during a speed-up interrupts the speed badge, which
 * comes back after it. Cuts show no badge.
 *
 * ## Size
 *
 * The output fits {@link DEMO_TARGET_BYTES}: the size and frame rate step down
 * a ladder until the bitrate that fits is high enough to read text. Past the
 * last step the timing gets stricter (shorter holds, faster speed-ups) before
 * the bitrate may drop below that floor.
 */

import {
  DEMO_ACTION_MAX_SECONDS,
  DEMO_STEP_MAX_CHARS,
  DEMO_TARGET_BYTES,
  type DemoAnalysis,
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
import { cameraAt, clampCenter, easeInOutCubic, eventPoint, planCamera } from "./demoCameraPlanner";

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

const POINTER_SURFACES = new Set<DemoTrack["surface"]>(["mac-desktop", "app-control", "browser"]);
/** A glide's length: a short hop is quick, a move across the screen takes longer. */
const POINTER_GLIDE_MIN = 0.35;
const POINTER_GLIDE_MAX = 0.8;
/** Extra glide seconds per unit of distance moved (1 is the frame's width). */
const POINTER_GLIDE_PER_DISTANCE = 0.6;
/** The pointer stays on an action this long before it glides on. */
const POINTER_SETTLE = 0.1;
/** Two actions closer than this: the pointer jumps instead of moving. */
const POINTER_JUMP_GAP = 0.05;
/** The least time between two actions for the pointer to glide at all rather than jump. */
const POINTER_GLIDE_FLOOR = 0.2;
/** A drag with no recorded length moves across in this long. */
const POINTER_DRAG_DEFAULT = 0.5;
/** A drag takes at least this long to move across, however short it was. */
const POINTER_DRAG_MIN = 0.2;
const POINTER_APPEAR_BEFORE = 0.8;
const POINTER_SAMPLE_SECONDS = 1 / 20;

const STEP_CAPTION_MAX = 5.0;
const CAPTION_MIN = 0.8;

/** An action this low in the view (0 top, 1 bottom) moves its caption to the top… */
const CAPTION_LOW_ACTION = 0.68;
/** …unless another action in the same caption is this high. */
const CAPTION_HIGH_ACTION = 0.32;

export const DEMO_STYLE: DemoStyle = {
  accent: "#A78BFA",
  ringDurationSeconds: 0.45,
  ringStartRadius: 0.012,
  ringEndRadius: 0.04,
  ringLineWidth: 0.004,
  pointerHeight: 0.035,
  captionFontSize: 0.036,
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

/** The first ladder step whose fitting bitrate reads well. */
function chooseOutput(
  source: { width: number; height: number },
  durationSeconds: number,
  budgetBits: number,
): { output: DemoOutput; belowFloor: boolean; rung: number } {
  const budgetRate = budgetBits / Math.max(durationSeconds, 0.5);
  for (let index = 0; index < LADDER.length; index += 1) {
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

/** How long the action ran on the screen: typing, a drag. 0 for an instant one. */
function actionSeconds(event: DemoTrackEvent): number {
  return typeof event.seconds === "number" && Number.isFinite(event.seconds) && event.seconds > 0 ? Math.min(event.seconds, DEMO_ACTION_MAX_SECONDS) : 0;
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
    const done = event.t + actionSeconds(event);
    mark(moments, event.t - MOMENT_BEFORE, done + MOMENT_AFTER);
    mark(results, done + MOMENT_AFTER, done + RESULT_WINDOW);
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
// Pointer and rings
// ---------------------------------------------------------------------------

const POINTER_KINDS = new Set<DemoTrackEvent["kind"]>(["click", "drag", "type", "scroll", "hover"]);
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
  /** Eased from `from` at `start` to `to` at `end`. */
  const move = (from: { x: number; y: number }, to: { x: number; y: number }, start: number, end: number) => {
    push({ t: start, x: from.x, y: from.y, visible: true });
    const steps = Math.max(1, Math.ceil((end - start) / POINTER_SAMPLE_SECONDS));
    for (let step = 1; step <= steps; step += 1) {
      const p = easeInOutCubic(step / steps);
      push({ t: start + (end - start) * (step / steps), x: from.x + (to.x - from.x) * p, y: from.y + (to.y - from.y) * p, visible: true });
    }
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
      // The glide ends as the action lands. It starts once the previous action
      // has settled, and never so late that the pointer jumps.
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const glide = Math.min(POINTER_GLIDE_MAX, POINTER_GLIDE_MIN + distance * POINTER_GLIDE_PER_DISTANCE);
      const glideStart = Math.max(previous.o + POINTER_SETTLE, o - glide);
      if (o - glideStart < POINTER_GLIDE_FLOOR) {
        // Too close behind the last action for a glide of its own: the pointer
        // spends the whole gap moving instead of jumping.
        if (o - previous.o > POINTER_JUMP_GAP) move(previous, point, previous.o, o);
        else push({ t: o, x: point.x, y: point.y, visible: true });
      } else {
        move(previous, point, glideStart, o);
      }
    }
    previous = { o, x: point.x, y: point.y };
    // A drag carries the pointer (and what it holds) to its end.
    if (event.kind === "drag" && event.to) {
      const end = { x: event.to[0], y: event.to[1] };
      const seconds = actionSeconds(event);
      const arrive = seconds > 0 ? sourceToOutput(segments, event.t + seconds) : o + POINTER_DRAG_DEFAULT;
      const arrived = Math.max(arrive, o + POINTER_DRAG_MIN);
      move(point, end, o, arrived);
      previous = { o: arrived, ...end };
    }
  }
  return { cursor, rings };
}

// ---------------------------------------------------------------------------
// Captions and badges
// ---------------------------------------------------------------------------

/** `ade proof step` refuses longer text; this only guards older tracks. */
function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > DEMO_STEP_MAX_CHARS ? `${flat.slice(0, DEMO_STEP_MAX_CHARS - 1)}…` : flat;
}


/**
 * Top when the actions during a caption are low in the view and none is high:
 * the caption would sit on the thing being done.
 */
function placeCaptions(captions: DemoCaption[], track: DemoTrack | null, segments: DemoSegment[], camera: DemoCameraKey[]): DemoCaption[] {
  const actions = (track?.events ?? []).filter((event) => event.kind !== "step" && event.kind !== "navigate");
  return captions.map((caption) => {
    let low = false;
    let high = false;
    for (const event of actions) {
      const point = eventPoint(event);
      if (!point) continue;
      const o = sourceToOutput(segments, event.t);
      if (o < caption.start || o > caption.end) continue;
      const view = cameraAt(camera, o);
      const y = 0.5 + (point.y - clampCenter(view.cy, view.zoom)) * Math.max(view.zoom, 1);
      if (y >= CAPTION_LOW_ACTION) low = true;
      if (y <= CAPTION_HIGH_ACTION) high = true;
    }
    return low && !high ? { ...caption, position: "top" as const } : caption;
  });
}

function planCaptions(track: DemoTrack | null, segments: DemoSegment[], outputDuration: number): DemoCaption[] {
  const raw = (track?.events ?? [])
    .filter((event) => event.kind === "step" && event.label)
    .map((event) => ({ start: sourceToOutput(segments, event.t), text: event.label!, max: STEP_CAPTION_MAX }));
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

/** A key press shows for this long. */
const KEY_BADGE_SECONDS = 1.3;
/** The same key again this soon counts up ("Tab ×3") instead of showing anew. */
const KEY_REPEAT_JOIN = 1.0;

const KEY_NAMES: Record<string, string> = {
  meta: "Cmd", cmd: "Cmd", command: "Cmd", super: "Win", win: "Win",
  control: "Ctrl", ctrl: "Ctrl", alt: "Alt", option: "Option", opt: "Option", shift: "Shift",
  enter: "Enter", return: "Enter", escape: "Esc", esc: "Esc", tab: "Tab", space: "Space", " ": "Space",
  backspace: "Backspace", delete: "Delete", del: "Delete", home: "Home", end: "End",
  pageup: "Page Up", pagedown: "Page Down",
  arrowup: "↑", up: "↑", arrowdown: "↓", down: "↓", arrowleft: "←", left: "←", arrowright: "→", right: "→",
};

/** Modifiers that make any key worth a badge. Shift alone does not: Shift + A is typing. */
const COMMAND_MODIFIERS = new Set(["meta", "cmd", "command", "super", "win", "control", "ctrl", "alt", "option", "opt"]);

/**
 * "Meta+k" → "Cmd + K", "ArrowDown" → "↓", "Enter" → "Enter". Null for a
 * press that gets no badge: a bare character ("a", "Shift+A", "7"), which may
 * be one letter of a password typed key by key. A named key (Enter, Tab, an
 * arrow, Space, F5…) or a press with Cmd, Ctrl, Alt or Meta shows.
 */
export function demoKeyText(label: string): string | null {
  const parts = label.split("+").map((part) => part.trim()).filter(Boolean);
  if (label.trim() === "+") parts.push("+");
  if (!parts.length) return null;
  const key = parts[parts.length - 1]!;
  const named = key.length > 1 || KEY_NAMES[key.toLowerCase()] !== undefined;
  const withCommand = parts.slice(0, -1).some((part) => COMMAND_MODIFIERS.has(part.toLowerCase()));
  if (!named && !withCommand) return null;
  const words = parts.map((part) => {
    const known = KEY_NAMES[part.toLowerCase()];
    if (known) return known;
    return part.length === 1 ? part.toUpperCase() : part.charAt(0).toUpperCase() + part.slice(1);
  });
  const text = words.join(" + ");
  return text.length > 24 ? null : text;
}

/** Each key press, as the viewer would want to see it on screen. */
function planKeyBadges(track: DemoTrack | null, segments: DemoSegment[], outputDuration: number): DemoBadge[] {
  const badges: Array<DemoBadge & { key: string; count: number; pressed: number }> = [];
  for (const event of track?.events ?? []) {
    if (event.kind !== "key" || !event.label) continue;
    const key = demoKeyText(event.label);
    if (!key) continue;
    const start = sourceToOutput(segments, event.t);
    const end = Math.min(outputDuration, start + KEY_BADGE_SECONDS);
    const last = badges[badges.length - 1];
    if (last && last.key === key && start - last.pressed <= KEY_REPEAT_JOIN) {
      last.count += 1;
      last.text = `${key} ×${last.count}`;
      last.end = end;
      last.pressed = start;
      continue;
    }
    badges.push({ start, end, text: key, key, count: 1, pressed: start });
  }
  return badges.map(({ start, end, text }) => ({ start, end, text }));
}

/** A badge piece shorter than this is left out: it would only flicker. */
const BADGE_MIN_SECONDS = 0.05;

/**
 * Speed badges and key badges in one row: no two overlap (an engine may draw
 * every badge whose span holds the time). At each moment the newest badge
 * showing wins; an older one that outlasts it comes back after it (a key
 * pressed during a speed-up interrupts "4×", which then resumes).
 */
function mergeBadges(...lists: DemoBadge[][]): DemoBadge[] {
  const all = lists.flat().filter((badge) => badge.end - badge.start > BADGE_MIN_SECONDS).sort((a, b) => a.start - b.start);
  const edges = [...new Set(all.flatMap((badge) => [badge.start, badge.end]))].sort((a, b) => a - b);
  const pieces: Array<DemoBadge & { owner: number }> = [];
  for (let index = 0; index + 1 < edges.length; index += 1) {
    const from = edges[index]!;
    const to = edges[index + 1]!;
    // Sorted by start, so the last badge covering the stretch is the newest.
    let owner = -1;
    all.forEach((badge, candidate) => {
      if (badge.start <= from && badge.end >= to) owner = candidate;
    });
    if (owner < 0) continue;
    const last = pieces[pieces.length - 1];
    if (last && last.owner === owner && last.end === from) last.end = to;
    else pieces.push({ ...all[owner]!, start: from, end: to, owner });
  }
  return pieces
    .filter((piece) => piece.end - piece.start > BADGE_MIN_SECONDS)
    .map(({ start, end, text }) => ({ start, end, text }));
}

/** A speed-up shows its speed. A cut shows nothing: a demo is edited. */
function planBadges(segments: DemoSegment[]): DemoBadge[] {
  const badges: DemoBadge[] = [];
  for (const segment of segments) {
    const speed = Math.round(speedOf(segment));
    if (speed <= 1) continue;
    const text = `${speed}×`;
    const last = badges[badges.length - 1];
    if (last && last.text === text && Math.abs(last.end - segment.outputStart) < 1e-6) last.end = segment.outputEnd;
    else badges.push({ start: segment.outputStart, end: segment.outputEnd, text });
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
  // A size refit may later shrink the output; the zoom cap holds at this, the largest size.
  const pictureScale = fit.output.width / source.width;
  const camera = planCamera(input.track, input.analysis, {
    toOutput: (s) => sourceToOutput(segments, s),
    outputDuration,
    levelOf: frameLevel,
    resultWindow: RESULT_WINDOW,
  }, pictureScale);
  return {
    version: 1,
    source,
    output: fit.output,
    durationSeconds: outputDuration,
    segments,
    camera,
    cursor,
    rings,
    captions: placeCaptions(planCaptions(input.track, segments, outputDuration), input.track, segments, camera),
    badges: mergeBadges(planBadges(segments), planKeyBadges(input.track, segments, outputDuration)),
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
