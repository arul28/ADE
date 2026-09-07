import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  findBuiltInBrowserEmulationPreset,
} from "../../../shared/builtInBrowserEmulation";
import type {
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserEmulationState,
  BuiltInBrowserRecordingStatus,
} from "../../../shared/types/builtInBrowser";

/**
 * Pure display helpers for the browser toolbar.
 *
 * Kept out of the panel component so the fiddly parts — elapsed formatting, the
 * preset label shown on the device button, and the simulator→preset mapping —
 * are testable without mounting a panel that positions a native browser view.
 */

/* ── Recording ────────────────────────────────────────────────────────────── */

/**
 * `m:ss`, or `h:mm:ss` past an hour. Deliberately not padded on the leading
 * unit: "0:42" reads as a stopwatch, "00:42" reads as a video scrubber.
 */
export function formatRecordingElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor((Number.isFinite(elapsedMs) ? elapsedMs : 0) / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const paddedSeconds = String(seconds).padStart(2, "0");
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${paddedSeconds}`;
  return `${minutes}:${paddedSeconds}`;
}

/** Elapsed milliseconds since a recording started, clamped at zero. */
export function recordingElapsedMs(
  recording: Pick<BuiltInBrowserRecordingStatus, "startedAt"> | null | undefined,
  now: number = Date.now(),
): number {
  if (!recording?.startedAt) return 0;
  const startedAt = Date.parse(recording.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  return Math.max(0, now - startedAt);
}

/** The text inside the REC pill: `0:42 · 60 fps`. */
export function recordingPillLabel(
  recording: BuiltInBrowserRecordingStatus | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!recording) return null;
  const elapsed = formatRecordingElapsed(recordingElapsedMs(recording, now));
  const fps = Number.isFinite(recording.fps) && recording.fps > 0 ? `${Math.round(recording.fps)} fps` : null;
  return fps ? `${elapsed} · ${fps}` : elapsed;
}

/** The only two rates the recorder accepts. */
export const BUILT_IN_BROWSER_RECORDING_FRAME_RATES = [30, 60] as const;
export type BuiltInBrowserRecordingFrameRate = (typeof BUILT_IN_BROWSER_RECORDING_FRAME_RATES)[number];

export function normalizeRecordingFps(value: unknown): BuiltInBrowserRecordingFrameRate {
  return value === 60 ? 60 : 30;
}

/* ── Device emulation ─────────────────────────────────────────────────────── */

/** `desktop` means "no override", so a null emulation reads as Desktop. */
export function emulationButtonLabel(
  emulation: BuiltInBrowserEmulationState | null | undefined,
): string {
  if (!emulation) return "Desktop";
  const label = emulation.label?.trim();
  return label && label.length > 0 ? label : "Desktop";
}

/** `390 × 844`, or null for the presets that carry no metrics (Desktop). */
export function emulationSizeLabel(
  metrics: Pick<BuiltInBrowserEmulationPreset, "width" | "height"> | null | undefined,
): string | null {
  if (!metrics) return null;
  if (!metrics.width || !metrics.height) return null;
  return `${Math.round(metrics.width)} × ${Math.round(metrics.height)}`;
}

/**
 * The presets offered as one-click entries on the device menu.
 *
 * `desktop` is excluded because it is the menu's "Off" row, and `responsive`
 * because it is the custom width/height row — offering either twice would make
 * the same choice look like two different ones.
 */
export function deviceMenuPresets(): BuiltInBrowserEmulationPreset[] {
  return BUILT_IN_BROWSER_EMULATION_PRESETS.filter(
    (preset) => preset.id !== "desktop" && preset.id !== "responsive",
  );
}

/**
 * Map a booted simulator's device name onto a known preset.
 *
 * Returns null when the simulator is running a device ADE has no metrics for —
 * the menu then hides the entry rather than emulating the wrong screen, which
 * would be worse than not offering it: a screenshot at 393×852 labelled
 * "iPhone 16e" is a false claim about what the page looks like.
 */
export function simulatorEmulationPreset(
  deviceName: string | null | undefined,
): BuiltInBrowserEmulationPreset | null {
  if (typeof deviceName !== "string" || !deviceName.trim()) return null;
  const preset = findBuiltInBrowserEmulationPreset(deviceName);
  if (!preset) return null;
  if (preset.id === "desktop" || preset.id === "responsive") return null;
  return preset;
}

/* ── Zoom ─────────────────────────────────────────────────────────────────── */

/** Chromium's own zoom ladder, which is what ⌘=/⌘− step through elsewhere. */
export const BUILT_IN_BROWSER_ZOOM_STEPS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
] as const;

export function zoomPercentLabel(factor: number | null | undefined): string {
  const value = typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  return `${Math.round(value * 100)}%`;
}

/**
 * The next rung up or down the ladder. Snaps a value that is between rungs
 * (an agent can set any factor) onto the nearest one in the asked direction.
 */
export function stepZoomFactor(factor: number | null | undefined, direction: 1 | -1): number {
  const steps = BUILT_IN_BROWSER_ZOOM_STEPS;
  const current = typeof factor === "number" && Number.isFinite(factor) && factor > 0 ? factor : 1;
  const epsilon = 0.001;
  if (direction > 0) {
    const next = steps.find((step) => step > current + epsilon);
    return next ?? steps[steps.length - 1];
  }
  const previous = [...steps].reverse().find((step) => step < current - epsilon);
  return previous ?? steps[0];
}

/* ── URL bar ──────────────────────────────────────────────────────────────── */

export type BrowserUrlLockKind = "secure" | "insecure" | "none";

/**
 * Which glyph the URL field shows. Loopback is `insecure` like any other http
 * origin — the lock is about the transport, and mislabelling a dev server as
 * safe teaches the wrong reflex on the day it is not loopback.
 */
export function urlLockKind(url: string | null | undefined): BrowserUrlLockKind {
  const value = (url ?? "").trim();
  if (!value) return "none";
  if (/^https:/i.test(value)) return "secure";
  if (/^http:/i.test(value)) return "insecure";
  return "none";
}

/* ── Find in page ─────────────────────────────────────────────────────────── */

export type BrowserFindState = {
  activeMatchOrdinal: number | null;
  matches: number | null;
};

/** `3 of 12`, `No results`, or null before the first result lands. */
export function findMatchLabel(state: BrowserFindState | null | undefined): string | null {
  if (!state) return null;
  const matches = state.matches;
  if (matches == null) return null;
  if (matches <= 0) return "No results";
  const ordinal = state.activeMatchOrdinal;
  if (ordinal == null || ordinal <= 0) return `${matches} ${matches === 1 ? "match" : "matches"}`;
  return `${ordinal} of ${matches}`;
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */

/** Host without `www.`, for the tab pill and the empty-state chips. */
export function shortHostLabel(url: string | null | undefined): string | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const host = parsed.host.replace(/^www\./i, "");
    return host || null;
  } catch {
    return null;
  }
}

/** What a tab pill says: its title, else its host, else "New tab". */
export function browserTabLabel(
  tab: { title?: string | null },
  displayUrl: string | null | undefined,
): string {
  const title = tab.title?.trim();
  if (title) return title;
  const host = shortHostLabel(displayUrl);
  if (host) return host;
  const raw = (displayUrl ?? "").trim();
  return raw || "New tab";
}
