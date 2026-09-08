import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  findBuiltInBrowserEmulationPreset,
} from "../../../../shared/builtInBrowserEmulation";
import {
  BUILT_IN_BROWSER_MAX_RECORDING_MS,
  BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS,
} from "../../../../shared/types/builtInBrowser";
import type {
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserEmulationPresetId,
  BuiltInBrowserEmulationState,
  BuiltInBrowserRecordingFps,
  BuiltInBrowserRecordingStatus,
} from "../../../../shared/types/builtInBrowser";
import { browserHostLabel } from "../../../lib/browserUrl";

/**
 * The words the browser chrome puts on screen.
 *
 * Pure, so the fiddly parts — elapsed formatting, which device row is checked,
 * the sentence a find failure turns into — are testable without mounting a
 * panel that positions a native browser view. The *layout* decision (what still
 * fits on the row) lives next door in `builtInBrowserToolbar.ts`; this module
 * only names things.
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

/**
 * The picker's coercion of an fps choice, over the shared rate list.
 *
 * Deliberately lenient where main's `normalizeBuiltInBrowserRecordingFps`
 * throws: this one backs a `<Select>` whose only job is to land on a legal
 * value, and a rejected menu click has nowhere to surface.
 */
export function normalizeRecordingFps(value: unknown): BuiltInBrowserRecordingFps {
  const match = BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS.find((option) => option === value);
  return match ?? BUILT_IN_BROWSER_RECORDING_FPS_OPTIONS[0];
}

/**
 * Why a recording nobody stopped stopped anyway.
 *
 * Null for the ordinary case — an agent or a person calling `stopRecording` —
 * because "your recording stopped because you stopped it" is noise. The two
 * values that are NOT that are the whole reason the field exists: without them
 * the REC pill just vanishes and the clip is quietly short.
 *
 * Each line has to answer the question the vanished pill raises, which is not
 * "why" but "is there a file". The two cases differ on exactly that:
 * `max_duration` FINALIZES the recording (the clip is on disk, the event's
 * `frameCount` is the real one), while `handoff` ABORTS it — nothing is
 * published, because a capture taken while a human was typing a password is not
 * proof of anything the agent did — and it does not resume on hand-back. A line
 * that said only "stopped" would send someone hunting for a file that in one of
 * the two cases was never written.
 *
 * No Reveal action to go with the first: the `recording` event carries no path,
 * unlike the `stopRecording` result the normal save path toasts.
 */
export function recordingEndedByLabel(value: unknown): string | null {
  if (value === "max_duration") {
    const minutes = Math.round(BUILT_IN_BROWSER_MAX_RECORDING_MS / 60_000);
    return `${minutes}-minute limit reached. The clip was saved.`;
  }
  if (value === "handoff") {
    return "Sign-in took the tab. The partial clip was discarded and recording does not resume.";
  }
  return null;
}

/** Longest tab title the toast will carry before it stops being scannable. */
const RECORDING_TOAST_TITLE_MAX = 48;

/**
 * The "Recording stopped" toast's body, with the tab it is about.
 *
 * The `recording` event is filtered by project but not by tab, so a background
 * tab hitting the cap raises this over whatever page the human is looking at —
 * and an unattributed "Recording stopped" reads as being about *that* page.
 * Naming the tab is the whole point of the toast: the pill you would have
 * watched is on a tab you cannot see.
 *
 * Null when there is nothing worth saying (`recordingEndedByLabel`'s ordinary
 * stop), and the bare reason when the tab had no title — an untitled or
 * already-destroyed tab is not worth an empty pair of quotes.
 */
export function recordingEndedByMessage(endedBy: unknown, tabTitle: unknown): string | null {
  const reason = recordingEndedByLabel(endedBy);
  if (!reason) return null;
  const title = typeof tabTitle === "string" ? tabTitle.trim() : "";
  if (!title) return reason;
  const clipped = title.length > RECORDING_TOAST_TITLE_MAX
    ? `${title.slice(0, RECORDING_TOAST_TITLE_MAX - 1).trimEnd()}…`
    : title;
  return `${clipped} — ${reason}`;
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

type EmulationSize = { width?: number | null; height?: number | null };

/** The preset whose metrics these are, in either orientation. */
function matchEmulationPreset(
  emulation: EmulationSize | null | undefined,
): { preset: BuiltInBrowserEmulationPreset; rotated: boolean } | null {
  const width = emulation?.width && emulation.width > 0 ? Math.round(emulation.width) : null;
  const height = emulation?.height && emulation.height > 0 ? Math.round(emulation.height) : null;
  if (width == null || height == null) return null;
  for (const preset of deviceMenuPresets()) {
    if (preset.width === width && preset.height === height) return { preset, rotated: false };
    if (preset.width === height && preset.height === width) return { preset, rotated: true };
  }
  return null;
}

/**
 * Which row of the device menu is the current one.
 *
 * Derived from the metrics, not only from `presetId`, because rotating a preset
 * goes through the custom width/height path and comes back labelled
 * `responsive` — the human still has an iPhone 17 on screen and the menu has to
 * agree with them. A genuinely custom size is `responsive`, which is a row of
 * that menu too, so it is checkable rather than nothing being checked.
 */
export function activeEmulationPresetId(
  emulation: BuiltInBrowserEmulationState | null | undefined,
): BuiltInBrowserEmulationPresetId {
  if (!emulation) return "desktop";
  if (emulation.presetId && emulation.presetId !== "responsive" && emulation.presetId !== "desktop") {
    return emulation.presetId;
  }
  return matchEmulationPreset(emulation)?.preset.id ?? "responsive";
}

/**
 * The device name a human would use for what is on screen.
 *
 * A rotated preset arrives back from the service as `852×393` — true, and
 * useless: the pill stops saying which device it is at exactly the moment you
 * are checking a device. Rotation is an orientation of the same phone, so it
 * reads as one.
 */
export function emulationDisplayLabel(
  emulation: BuiltInBrowserEmulationState | null | undefined,
): string {
  if (!emulation) return "Desktop";
  const matched = matchEmulationPreset(emulation);
  if (matched) return matched.rotated ? `${matched.preset.label} · landscape` : matched.preset.label;
  return emulationButtonLabel(emulation);
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
const BUILT_IN_BROWSER_ZOOM_STEPS = [
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

const FIND_ERROR_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/no (active )?(tab|page)|tab .*not found|closed|destroyed/i, "Open a page before searching it."],
  [/timed?\s*out|timeout/i, "Find took too long on this page."],
];

/**
 * A sentence a person can act on, never the service's own words.
 *
 * `findInPage` fails with things like "Error invoking remote method
 * 'built-in-browser:find-in-page': TypeError: …", which in a bar two words wide
 * reads as a crash. Every failure here means the same thing to the human.
 */
export function findErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  for (const [pattern, message] of FIND_ERROR_PATTERNS) {
    if (pattern.test(raw)) return message;
  }
  return "Find is not available on this page.";
}

/* ── Tabs ─────────────────────────────────────────────────────────────────── */

/** What a tab pill says: its title, else its host, else "New tab". */
export function browserTabLabel(
  tab: { title?: string | null },
  displayUrl: string | null | undefined,
): string {
  const title = tab.title?.trim();
  if (title) return title;
  const host = browserHostLabel(displayUrl);
  if (host) return host;
  const raw = (displayUrl ?? "").trim();
  return raw || "New tab";
}
