/**
 * Which frames of a finished video go on its contact sheet. Evenly spaced
 * frames miss what a person would point at: the dialog that opened for half a
 * second, the page after it loaded, the last screen. So the sheet is built
 * from moments, most important first:
 *
 * 1. The first and the last frame of the span (the last is the result).
 * 2. One frame per step caption: the screen once the step's last big change
 *    has settled, which is what the step did. Without a measure of change,
 *    three quarters into the step.
 * 3. The biggest other changes (a page load, a sheet sliding in), each shown
 *    once it settled, not mid-transition.
 * 4. Even fill in the widest gaps, so no long stretch goes unseen.
 *
 * "Change" is the engine's analysis of the file (`DemoAnalysisFrame.changed`,
 * the fraction of a small greyscale thumbnail that changed since the frame
 * before), the same measure the demo planner cuts still stretches with.
 */

import type { DemoAnalysisFrame } from "../../../shared/demoVideo/demoContract";

export type SheetFrameReason = "start" | "end" | "step" | "change" | "even";

export type SheetFrame = {
  /** Seconds into the video. */
  t: number;
  why: SheetFrameReason;
  /** The step caption showing at `t`, if any. */
  step: string | null;
};

/** A frame changed this much to count as activity (cursor and typing stay under it). */
const ACTIVE_CHANGE = 0.005;
/** Active frames this close together are one change. */
const BURST_JOIN_SECONDS = 0.3;
/** A change this big in total is a moment: a dropdown opening is 2–4 % of the screen, a page load most of it. */
const BIG_CHANGE = 0.02;
/** Show a change this long after it ends, once the screen has settled. */
const SETTLE_SECONDS = 0.35;
/** Two frames closer than this show the same screen. */
const STEP_GAP_SECONDS = 0.2;
/** Default frame count for a whole video and its bounds. */
const MIN_FRAMES = 4;
const DEFAULT_MAX_FRAMES = 12;
const CLOSE_LOOK_FRAMES_PER_SECOND = 3;
/** Steps may raise the count up to this, so every caption gets its frame. */
export const SHEET_MAX_FRAMES = 16;

type Burst = { start: number; end: number; score: number };

export function pickSheetFrames(args: {
  durationSeconds: number;
  steps?: ReadonlyArray<{ t: number; text: string }>;
  changes?: ReadonlyArray<DemoAnalysisFrame> | null;
  from?: number | null;
  to?: number | null;
  /**
   * Asked count; otherwise one per second of a whole video (three for a
   * closer look at part of it), 4–12, raised to fit the steps.
   */
  frames?: number | null;
}): SheetFrame[] {
  const duration = Math.max(0, args.durationSeconds);
  const start = clamp(args.from ?? 0, 0, duration);
  const end = clamp(args.to ?? duration, start, duration);
  const span = end - start;
  const allSteps = [...(args.steps ?? [])]
    .filter((step) => Number.isFinite(step.t) && typeof step.text === "string")
    .sort((a, b) => a.t - b.t);
  const captionAt = (t: number): string | null => {
    let caption: string | null = null;
    for (const step of allSteps) {
      if (step.t <= t + 1e-6) caption = step.text;
      else break;
    }
    return caption;
  };
  if (span <= 0) return [{ t: round2(start), why: "start", step: captionAt(start) }];

  // Steps whose window overlaps the span, with that window cut to the span.
  const windows = allSteps
    .map((step, index) => ({
      text: step.text,
      start: Math.max(step.t, start),
      end: Math.min(allSteps[index + 1]?.t ?? duration, end),
    }))
    .filter((window) => window.end > window.start);

  const asked = args.frames != null && Number.isFinite(args.frames) ? Math.round(args.frames) : null;
  const perSecond = span < duration ? CLOSE_LOOK_FRAMES_PER_SECOND : 1;
  const count = asked != null
    ? clamp(asked, 1, SHEET_MAX_FRAMES)
    : clamp(Math.max(clamp(Math.round(span * perSecond), MIN_FRAMES, DEFAULT_MAX_FRAMES), windows.length + 2), 1, SHEET_MAX_FRAMES);

  const bursts = changeBursts(args.changes ?? [], start, end);
  const settled = (burst: Burst, limit: number) => clamp(burst.end + SETTLE_SECONDS, burst.start, limit);
  // A change closer than this to a chosen frame adds nothing a person would
  // see. Step frames only skip a near-duplicate: each caption gets its frame.
  const minGap = span / (count * 2);

  const chosen: Array<{ t: number; why: SheetFrameReason }> = [];
  const add = (t: number, why: SheetFrameReason, gap: number) => {
    const at = clamp(t, start, end);
    if (chosen.length >= count || chosen.some((frame) => Math.abs(frame.t - at) < gap)) return;
    chosen.push({ t: at, why });
  };

  add(end, "end", 0);
  add(start, "start", STEP_GAP_SECONDS);

  // One frame per step: its outcome. With more steps than room, evenly chosen steps.
  const room = Math.max(0, count - chosen.length);
  const stepPicks = windows.length <= room
    ? windows
    : Array.from({ length: room }, (_, index) => windows[Math.floor(((index + 0.5) * windows.length) / room)]);
  for (const window of stepPicks) {
    const inside = bursts.filter((burst) => burst.start >= window.start && burst.start < window.end);
    const big = inside.filter((burst) => burst.score >= BIG_CHANGE);
    const outcome = big.at(-1) ?? [...inside].sort((a, b) => b.score - a.score)[0] ?? null;
    const t = outcome
      ? settled(outcome, window.end - 0.05)
      : window.start + 0.75 * (window.end - window.start);
    add(t, "step", STEP_GAP_SECONDS);
  }

  for (const burst of [...bursts].sort((a, b) => b.score - a.score)) {
    if (burst.score < BIG_CHANGE || chosen.length >= count) break;
    add(settled(burst, end), "change", minGap);
  }

  // Even fill: the middle of the widest gap, until the sheet is full.
  while (chosen.length < count) {
    const times = [...chosen.map((frame) => frame.t)].sort((a, b) => a - b);
    let best = { at: (start + end) / 2, width: -1 };
    for (let index = 1; index < times.length; index += 1) {
      const width = times[index] - times[index - 1];
      if (width > best.width) best = { at: (times[index] + times[index - 1]) / 2, width };
    }
    if (best.width >= 0 && best.width < 0.05) break;
    chosen.push({ t: best.at, why: "even" });
  }

  return chosen
    .sort((a, b) => a.t - b.t)
    .map((frame) => ({ t: round2(frame.t), why: frame.why, step: captionAt(frame.t) }));
}

/** Runs of active frames inside the span, each scored by its total change. */
function changeBursts(frames: ReadonlyArray<DemoAnalysisFrame>, start: number, end: number): Burst[] {
  const bursts: Burst[] = [];
  let current: Burst | null = null;
  for (const frame of frames) {
    // The first analysed frame reads as a full change (nothing before it).
    if (frame === frames[0] || !Number.isFinite(frame.t) || !Number.isFinite(frame.changed)) continue;
    if (frame.t < start || frame.t > end || frame.changed < ACTIVE_CHANGE) continue;
    if (current && frame.t - current.end <= BURST_JOIN_SECONDS) {
      current.end = frame.t;
      current.score += frame.changed;
    } else {
      current = { start: frame.t, end: frame.t, score: frame.changed };
      bursts.push(current);
    }
  }
  return bursts;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
