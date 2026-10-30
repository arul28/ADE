/**
 * The camera of a demo: where the picture looks at each moment of the output.
 * Pure, like the planner (`demoPlanner.ts`) that calls it.
 *
 * Three cameras; the first that applies wins:
 *
 * - **Step focus.** Once any step has a focus (`ade proof step --focus`), the
 *   steps drive the camera and nothing else does. Each focused step moves the
 *   camera to its region (up to 3×, and never past 2 output pixels per source
 *   pixel, so the picture stays sharp) and holds it until the next step; a
 *   step without a focus shows the whole frame.
 * - **Phone.** No zoom unless the recording asked for it (`record start
 *   --zoom`); then each tap gets a light, short zoom (up to 1.3×).
 * - **Computer screen.** The camera rests on a home view: the part of the
 *   screen where anything happened, with a margin, so a small app in a large
 *   frame fills the video. A scene (up to a navigation or a change of the
 *   whole screen) zooms in once, up to 2× (1.6× on a small source), to a view
 *   that holds every action of the scene and what they changed, holds it, and
 *   returns to the home view when the scene ends. A scene whose zoom gains
 *   little over the home view, or would hold only a moment, gets none.
 *
 * Keys are sampled densely along an ease, so an engine's linear interpolation
 * between them is smooth.
 */

import type {
  DemoAnalysis,
  DemoAnalysisFrame,
  DemoCameraKey,
  DemoTrack,
  DemoTrackEvent,
} from "./demoContract";

/** What the camera needs from the planner's timeline. */
export type CameraTimeline = {
  /** Output time of source time `s` (the planner's `sourceToOutput`). */
  toOutput: (s: number) => number;
  /** Output length, seconds. */
  outputDuration: number;
  /** A frame's change level, as the planner rates it: 0 noise, 1 busy, 2 a large change. */
  levelOf: (frame: DemoAnalysisFrame) => 0 | 1 | 2;
  /** How long after an action its result counts, in source seconds. */
  resultWindow: number;
};

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
/** A step's focus may zoom further than an action: the agent chose the region. */
const FOCUS_ZOOM_MAX = 3.0;
/**
 * But no further than this many output pixels per source pixel: past it the
 * picture goes soft. A Retina capture has room for 3×; a 1x one about 2×.
 */
const FOCUS_MAX_UPSCALE = 2.0;
/** How much of the view a step's focus fills. */
const FOCUS_FILL = 0.92;
/** A focus this close to the whole frame is the whole frame. */
const FOCUS_MIN_ZOOM = 1.05;
/** A scene zoom that would hold shorter than this is left out: it only flickers. */
const SCENE_MIN_HOLD = 1.5;
/** Two zooms closer than this (after the zoom out) join: the camera moves straight across. */
const CAMERA_JOIN_GAP = 0.8;
/** The home view's margin around everything that happened, per side. */
const HOME_MARGIN = 0.04;
/** A crop that gains less than this is not worth losing the frame's edges for. */
const HOME_MIN_ZOOM = 1.2;
/** A scene zooms past the home view only when it gets this much closer. */
const HOME_SCENE_GAIN = 1.15;

/** The most zoom the output's resolution allows before the picture goes soft. */
function upscaleCap(pictureScale: number): number {
  return FOCUS_MAX_UPSCALE / Math.max(pictureScale, 1e-6);
}

export function easeInOutCubic(p: number): number {
  const x = Math.min(Math.max(p, 0), 1);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function clampCenter(center: number, zoom: number): number {
  const half = 0.5 / Math.max(zoom, 1);
  return Math.min(Math.max(center, half), 1 - half);
}

type Box = [number, number, number, number];
type View = { zoom: number; cx: number; cy: number };
const WHOLE_VIEW: View = { zoom: 1, cx: 0.5, cy: 0.5 };

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

export function eventPoint(event: DemoTrackEvent): { x: number; y: number } | null {
  if (typeof event.x === "number" && typeof event.y === "number") return { x: event.x, y: event.y };
  return focusPoint(event);
}

const ZOOM_KINDS = new Set<DemoTrackEvent["kind"]>(["click", "tap", "type", "drag", "scroll"]);

type CameraWindow = { inStart: number; inEnd: number; holdEnd: number; view: View };

/**
 * Writes camera keys: zoom in, hold, zoom out, or move straight to the next
 * view when it comes soon. Between zooms the camera rests on `home`.
 */
function cameraKeys(windows: CameraWindow[], outputDuration: number, out: number, home: View = WHOLE_VIEW): DemoCameraKey[] {
  const keys: DemoCameraKey[] = [{ t: 0, zoom: home.zoom, cx: clampCenter(home.cx, home.zoom), cy: clampCenter(home.cy, home.zoom) }];
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
  let open: CameraWindow | null = null;
  for (const window of windows) {
    if (open && window.inStart < open.holdEnd + out + CAMERA_JOIN_GAP) {
      // The next view comes before the camera could settle out: move to it.
      const from = Math.max(keys[keys.length - 1]!.t, open.holdEnd);
      transition({ t: from, view: open.view }, { t: Math.max(from + ZOOM_RAMP, window.inEnd), view: window.view });
    } else {
      if (open) transition({ t: Math.max(keys[keys.length - 1]!.t, open.holdEnd), view: open.view }, { t: open.holdEnd + out, view: home });
      const inStart = Math.max(keys[keys.length - 1]!.t, window.inStart);
      transition({ t: inStart, view: home }, { t: Math.max(inStart, window.inEnd), view: window.view });
    }
    push(Math.max(keys[keys.length - 1]!.t, window.holdEnd), window.view.zoom, window.view.cx, window.view.cy);
    open = window;
  }
  if (open) {
    if (open.holdEnd + out <= outputDuration + 1e-9) {
      transition({ t: Math.max(keys[keys.length - 1]!.t, open.holdEnd), view: open.view }, { t: open.holdEnd + out, view: home });
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
  timeline: CameraTimeline,
  pictureScale: number,
): DemoCameraKey[] {
  const { outputDuration } = timeline;
  const longSide = Math.max(analysis.width, analysis.height);
  const maxZoom = longSide < 1400 ? ZOOM_MAX_SMALL_SOURCE : ZOOM_MAX;
  const events = (track?.events ?? []).filter((event) => event.kind !== "step");
  const home = planHomeView(track, analysis, timeline, Math.min(maxZoom, upscaleCap(pictureScale))) ?? WHOLE_VIEW;
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
        && frame.t <= Math.min(lastT + timeline.resultWindow, scene.end)
        && timeline.levelOf(frame) === 2
        && frame.box
        && !wholeScreenAt(frame))
      .map((frame) => frame.box as Box);
    const view = viewFor([...scene.foci.map((focus) => focus.box), ...changed], maxZoom);
    // Not worth a zoom when the home view is already about this close.
    if (!view || view.zoom < home.zoom * HOME_SCENE_GAIN) continue;
    const firstO = timeline.toOutput(firstT);
    const inStart = Math.max(0, firstO - ZOOM_LEAD);
    const inEnd = Math.max(inStart, Math.min(firstO - 0.1, inStart + ZOOM_RAMP));
    const holdEnd = Math.min(
      timeline.toOutput(lastT) + ZOOM_HOLD_AFTER,
      timeline.toOutput(scene.end) - ZOOM_OUT,
      outputDuration - ZOOM_OUT,
    );
    if (holdEnd - inEnd < SCENE_MIN_HOLD) continue;
    windows.push({ inStart, inEnd, holdEnd, view });
  }
  return cameraKeys(windows, outputDuration, ZOOM_OUT, home);
}

function wholeScreenAt(frame: DemoAnalysisFrame): boolean {
  return frame.changed >= WHOLE_SCREEN_CHANGED && Boolean(frame.box && frame.box[2] * frame.box[3] >= WHOLE_SCREEN_AREA);
}

/**
 * The view a computer recording rests on instead of the whole frame: the part
 * of the screen where anything happened (every action, every step focus,
 * every change after the first frame) with a margin, in the frame's aspect.
 * A small app in a large frame then fills the video, and the empty rest is
 * cropped away. Null, so the whole frame shows, when the crop would gain
 * little or when a change covered the whole screen (a new page, a scroll):
 * what it showed may lie anywhere.
 */
function planHomeView(track: DemoTrack | null, analysis: DemoAnalysis, timeline: CameraTimeline, maxZoom: number): View | null {
  if (maxZoom < HOME_MIN_ZOOM) return null;
  const boxes: Box[] = [];
  for (const [index, frame] of analysis.frames.entries()) {
    if (index === 0 || !frame.box || timeline.levelOf(frame) === 0) continue;
    if (wholeScreenAt(frame)) return null;
    boxes.push(frame.box);
  }
  for (const event of track?.events ?? []) {
    if (event.kind === "navigate") return null;
    const box = event.kind === "step" ? event.rect ?? null : focusBox(event);
    if (box) boxes.push(box);
    if (event.to) boxes.push([event.to[0] - FOCUS_POINT_HALF, event.to[1] - FOCUS_POINT_HALF, FOCUS_POINT_HALF * 2, FOCUS_POINT_HALF * 2]);
  }
  if (!boxes.length) return null;
  const left = Math.max(0, Math.min(...boxes.map((box) => box[0])) - HOME_MARGIN);
  const top = Math.max(0, Math.min(...boxes.map((box) => box[1])) - HOME_MARGIN);
  const right = Math.min(1, Math.max(...boxes.map((box) => box[0] + box[2])) + HOME_MARGIN);
  const bottom = Math.min(1, Math.max(...boxes.map((box) => box[1] + box[3])) + HOME_MARGIN);
  const zoom = Math.min(maxZoom, 1 / Math.max(right - left, 1e-3), 1 / Math.max(bottom - top, 1e-3));
  if (zoom < HOME_MIN_ZOOM) return null;
  return { zoom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/**
 * The camera for a phone: none, unless the recording asked for zoom
 * (`record start --zoom`). Then each tap alone gets a light, short zoom. A
 * phone screen is already small in the video.
 */
function planPhoneCamera(track: DemoTrack | null, timeline: CameraTimeline): DemoCameraKey[] {
  const { outputDuration } = timeline;
  if (track?.zoom !== true) return [{ t: 0, zoom: 1, cx: 0.5, cy: 0.5 }];
  const windows: CameraWindow[] = [];
  for (const event of track.events) {
    if (event.kind !== "tap") continue;
    const box = focusBox(event);
    const view = box ? viewFor([box], ZOOM_MAX_PHONE) : null;
    if (!view) continue;
    const o = timeline.toOutput(event.t);
    if (o > outputDuration - ZOOM_IGNORE_TAIL) continue;
    const inStart = Math.max(0, o - ZOOM_LEAD, windows.length ? windows[windows.length - 1]!.holdEnd + ZOOM_OUT_PHONE : 0);
    const inEnd = Math.max(inStart, Math.min(o - 0.1, inStart + ZOOM_RAMP_PHONE));
    const holdEnd = Math.min(o + ZOOM_HOLD_AFTER_PHONE, outputDuration - ZOOM_OUT_PHONE);
    if (holdEnd <= inEnd) continue;
    windows.push({ inStart, inEnd, holdEnd, view });
  }
  return cameraKeys(windows, outputDuration, ZOOM_OUT_PHONE);
}

/**
 * The camera when the agent chose it: once any step has a focus
 * (`ade proof step --focus`), the steps drive the camera and nothing else
 * does. A step with a focus moves the camera to that region as it starts and
 * holds it until the next step; a step without one shows the whole frame. Null
 * when no step has a focus.
 */
function planFocusCamera(track: DemoTrack | null, timeline: CameraTimeline, pictureScale: number): DemoCameraKey[] | null {
  const { outputDuration } = timeline;
  const steps = (track?.events ?? []).filter((event) => event.kind === "step").sort((a, b) => a.t - b.t);
  if (!steps.some((step) => step.rect)) return null;
  const maxZoom = Math.max(1, Math.min(FOCUS_ZOOM_MAX, upscaleCap(pictureScale)));
  const windows: CameraWindow[] = [];
  steps.forEach((step, index) => {
    const rect = step.rect;
    if (!rect || rect[2] <= 0 || rect[3] <= 0) return;
    const zoom = Math.min(maxZoom, FOCUS_FILL / rect[2], FOCUS_FILL / rect[3]);
    if (zoom < FOCUS_MIN_ZOOM) return;
    const start = timeline.toOutput(step.t);
    const next = steps[index + 1];
    const end = next ? timeline.toOutput(next.t) : outputDuration;
    // Held to the next step when it has a focus too (the camera moves straight
    // across); otherwise it zooms out before the next step starts.
    const holdEnd = Math.min(end - (next?.rect ? 0 : ZOOM_OUT), outputDuration - (next ? 0 : ZOOM_OUT));
    const inEnd = Math.min(start + ZOOM_RAMP, holdEnd);
    if (holdEnd - start < ZOOM_RAMP) return;
    windows.push({ inStart: start, inEnd, holdEnd, view: { zoom, cx: rect[0] + rect[2] / 2, cy: rect[1] + rect[3] / 2 } });
  });
  return cameraKeys(windows, outputDuration, ZOOM_OUT);
}

/**
 * The camera for a recording: the steps' focus when any step has one, else a
 * phone's tap zoom, else a computer screen's home view and scene zooms.
 * `pictureScale`: output pixels per source pixel at zoom 1.
 */
export function planCamera(
  track: DemoTrack | null,
  analysis: DemoAnalysis,
  timeline: CameraTimeline,
  pictureScale: number,
): DemoCameraKey[] {
  return planFocusCamera(track, timeline, pictureScale)
    ?? (track?.surface === "apple"
      ? planPhoneCamera(track, timeline)
      : planSceneCamera(track, analysis, timeline, pictureScale));
}

/** The camera's view at output time `t`, interpolated as an engine does. */
export function cameraAt(camera: DemoCameraKey[], t: number): DemoCameraKey {
  let previous = camera[0] ?? { t: 0, zoom: 1, cx: 0.5, cy: 0.5 };
  for (const key of camera) {
    if (key.t > t) {
      const span = key.t - previous.t;
      const f = span > 0 ? (t - previous.t) / span : 1;
      return {
        t,
        zoom: previous.zoom + (key.zoom - previous.zoom) * f,
        cx: previous.cx + (key.cx - previous.cx) * f,
        cy: previous.cy + (key.cy - previous.cy) * f,
      };
    }
    previous = key;
  }
  return previous;
}
