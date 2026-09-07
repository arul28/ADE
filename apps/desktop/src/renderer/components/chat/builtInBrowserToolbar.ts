import {
  BUILT_IN_BROWSER_EMULATION_PRESETS,
  findBuiltInBrowserEmulationPreset,
} from "../../../shared/builtInBrowserEmulation";
import type {
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserEmulationPresetId,
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

/* ── Responsive toolbar ───────────────────────────────────────────────────── */

/**
 * The narrowest a URL field is still a URL field.
 *
 * Below this it stops being able to show a host, so the row must give up a
 * control instead: an omnibox squeezed to nothing is a browser you cannot
 * steer, and every other button on the row is a convenience by comparison.
 */
export const BROWSER_TOOLBAR_URL_MIN_WIDTH = 140;

/** Above this the field can afford the word "Open" next to the ▶ glyph. */
export const BROWSER_TOOLBAR_OPEN_LABEL_MIN_WIDTH = 520;

/**
 * What each control costs the row, in CSS px, at its laid-out size.
 *
 * These are the widths the toolbar's own classes produce: `w-7` icon buttons
 * are 28, the nav group is three of them inside one border, `gap-1` is 4 and
 * the row's `px-1.5` is 6 a side. They live here rather than being measured per
 * control because the decision has to be made in the same frame as the resize —
 * measuring children that are about to be removed is how a layout starts
 * oscillating.
 */
export type BrowserToolbarControlWidths = {
  /** Back + forward + reload in one bordered group. */
  nav: number;
  /** Back + reload, once forward has been dropped. */
  navNoForward: number;
  device: number;
  deviceIcon: number;
  camera: number;
  inspect: number;
  inspectIcon: number;
  attach: number;
  recording: number;
  overflow: number;
  gap: number;
  padding: number;
  /** The padlock and its gap, always reserved so the row cannot jump on load. */
  urlLock: number;
  /** The omnibox's own left padding. */
  urlPadding: number;
  openLabel: number;
  openIcon: number;
};

export const BROWSER_TOOLBAR_CONTROL_WIDTHS: BrowserToolbarControlWidths = {
  nav: 86,
  navNoForward: 58,
  device: 90,
  deviceIcon: 28,
  camera: 28,
  inspect: 72,
  inspectIcon: 28,
  attach: 70,
  recording: 96,
  overflow: 28,
  gap: 4,
  padding: 12,
  urlLock: 17,
  urlPadding: 8,
  openLabel: 60,
  openIcon: 34,
};

/**
 * What the device button costs with `label` on it.
 *
 * "Desktop" and "iPhone 17 Pro Max · landscape" are not the same button, and
 * the row that decides what fits has to price the one it is actually going to
 * render. Clamped at the button's own `max-w-[104px]` truncation.
 */
export function estimateDeviceButtonWidth(label: string | null | undefined): number {
  const text = (label ?? "").trim();
  const textWidth = Math.min(104, Math.max(28, Math.round(text.length * 6.4)));
  // icon 12 + gap 4 + text + caret 9 + gap 4 + px-2 padding 16.
  return textWidth + 45;
}

export type BrowserToolbarDensity = "full" | "compact" | "tight" | "minimal";

/** How the URL field offers to submit: with a word, a glyph, or not at all. */
export type BrowserToolbarOpenAffordance = "label" | "icon" | "none";

export type BrowserToolbarLayout = {
  density: BrowserToolbarDensity;
  /** Text next to an icon: the device name, "Inspect". */
  showLabels: boolean;
  showForward: boolean;
  showDevice: boolean;
  showCamera: boolean;
  showInspect: boolean;
  showAttach: boolean;
  openAffordance: BrowserToolbarOpenAffordance;
  /** What the URL field is left with once everything above is placed. */
  urlWidth: number;
};

export type BrowserToolbarLayoutOptions = {
  /** A selection is attached, so the row would like an "Attach" button. */
  hasSelection?: boolean;
  /** A recording is running; its pill is state, not a convenience, so it stays. */
  recording?: boolean;
  /** The device button's rendered label, which decides how wide it is. */
  deviceLabel?: string | null;
  /** The omnibox is focused: Enter submits, so the ▶ affordance steps aside. */
  urlFocused?: boolean;
  urlMinWidth?: number;
  widths?: Partial<BrowserToolbarControlWidths>;
};

type BrowserToolbarStep = Pick<
  BrowserToolbarLayout,
  "density" | "showLabels" | "showForward" | "showDevice" | "showCamera" | "showInspect" | "showAttach"
>;

/**
 * The order things are given up in.
 *
 * Labels first (an icon still says what it does), then Inspect, then the
 * camera, then the device button — each into the ⋮ menu, which is why the ⋮ is
 * never in this list. Forward goes last of all: it is the only one whose
 * absence loses a capability the menu does not carry.
 */
const BROWSER_TOOLBAR_STEPS: readonly BrowserToolbarStep[] = [
  { density: "full", showLabels: true, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: true },
  { density: "full", showLabels: true, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false },
  { density: "compact", showLabels: false, showForward: true, showDevice: true, showCamera: true, showInspect: true, showAttach: false },
  { density: "compact", showLabels: false, showForward: true, showDevice: true, showCamera: true, showInspect: false, showAttach: false },
  { density: "tight", showLabels: false, showForward: true, showDevice: true, showCamera: false, showInspect: false, showAttach: false },
  { density: "tight", showLabels: false, showForward: true, showDevice: false, showCamera: false, showInspect: false, showAttach: false },
  { density: "minimal", showLabels: false, showForward: false, showDevice: false, showCamera: false, showInspect: false, showAttach: false },
];

/**
 * How much toolbar fits in `width`, measured rather than guessed.
 *
 * The old version keyed off two hardcoded pane widths, and at ~420px every
 * control was still "allowed" — nav 86 + device 90 + camera 28 + inspect 72 +
 * ⋮ 28 + gaps left 84px for a field that also had to hold a lock and the word
 * "Open", so the input collapsed to zero and the omnibox vanished. Now the row
 * prices what it is about to render and sheds controls, in the order above,
 * until the field clears `urlMinWidth`.
 */
export function browserToolbarLayout(
  width: number | null | undefined,
  options: BrowserToolbarLayoutOptions = {},
): BrowserToolbarLayout {
  const widths = { ...BROWSER_TOOLBAR_CONTROL_WIDTHS, ...options.widths };
  const urlMin = options.urlMinWidth ?? BROWSER_TOOLBAR_URL_MIN_WIDTH;
  const measured = typeof width === "number" && Number.isFinite(width) && width > 0 ? width : null;
  const deviceWidth = options.deviceLabel != null
    ? estimateDeviceButtonWidth(options.deviceLabel)
    : widths.device;
  const naturalAffordance: BrowserToolbarOpenAffordance = options.urlFocused
    ? "none"
    : measured == null || measured >= BROWSER_TOOLBAR_OPEN_LABEL_MIN_WIDTH
      ? "label"
      : "icon";

  const price = (step: BrowserToolbarStep, openAffordance: BrowserToolbarOpenAffordance) => {
    const showAttach = step.showAttach && Boolean(options.hasSelection);
    let controls = 0;
    // nav + omnibox + ⋮ are always on the row.
    let items = 3;
    controls += step.showForward ? widths.nav : widths.navNoForward;
    controls += widths.overflow;
    // What the omnibox spends on itself before the text field gets any: the
    // padlock, its own padding, and whatever the submit affordance costs. The
    // field's share is what is left of that, which is the number that has to
    // clear the minimum — pricing the omnibox as a whole is what left a 101px
    // field inside a "comfortable" 180px box.
    controls += widths.urlPadding + widths.urlLock;
    if (openAffordance === "label") controls += widths.openLabel;
    else if (openAffordance === "icon") controls += widths.openIcon;
    if (options.recording) {
      controls += widths.recording;
      items += 1;
    }
    if (step.showDevice) {
      controls += step.showLabels ? deviceWidth : widths.deviceIcon;
      items += 1;
    }
    if (step.showCamera) {
      controls += widths.camera;
      items += 1;
    }
    if (step.showInspect) {
      controls += step.showLabels ? widths.inspect : widths.inspectIcon;
      items += 1;
    }
    if (showAttach) {
      controls += widths.attach;
      items += 1;
    }
    const consumed = widths.padding + controls + widths.gap * (items - 1);
    const urlWidth = measured == null ? Number.POSITIVE_INFINITY : measured - consumed;
    return { step, showAttach, openAffordance, urlWidth };
  };

  // The ▶ is the last thing to go, after every control has already moved into
  // the ⋮ menu: it is only ever a hint that Enter works, and at the width where
  // it is the difference it is cheaper to lose than the field it sits in.
  const priced = [
    ...BROWSER_TOOLBAR_STEPS.map((step) => price(step, naturalAffordance)),
    price(BROWSER_TOOLBAR_STEPS[BROWSER_TOOLBAR_STEPS.length - 1], "none"),
  ];

  const chosen = priced.find((entry) => entry.urlWidth >= urlMin) ?? priced[priced.length - 1];
  return {
    ...chosen.step,
    showAttach: chosen.showAttach,
    openAffordance: chosen.openAffordance,
    urlWidth: Number.isFinite(chosen.urlWidth) ? Math.max(0, Math.round(chosen.urlWidth)) : urlMin,
  };
}

/* ── Native view geometry ─────────────────────────────────────────────────── */

export type BrowserViewFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
  /**
   * 1 when the device fits the stage, else how much of it the frame shows.
   *
   * A landscape phone in a 578px pane cannot be honoured at 1:1, and the old
   * behaviour — clamp width, keep height — cropped the page at the pane's right
   * edge with nothing on screen admitting it. The frame is shrunk on both axes
   * instead, so the whole device is visible and the caption can say `fit 82%`.
   */
  scale: number;
};

export type BrowserViewBox = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

/**
 * Where the native view sits inside its stage.
 *
 * With no emulation it fills the stage inset by the host's hairline, so the
 * rounded frame masks the (rectangular) native view. With a CSS size it is that
 * size exactly, centred — until the device is bigger than the stage, when the
 * whole frame is scaled down uniformly rather than cropped on one axis.
 */
export function browserLetterboxFrame(
  stage: { width: number; height: number },
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  inset = 1,
): BrowserViewFrame {
  const availableWidth = Math.max(0, Math.round(stage.width) - inset * 2);
  const availableHeight = Math.max(0, Math.round(stage.height) - inset * 2);
  const cssWidth = emulation?.width && emulation.width > 0 ? Math.round(emulation.width) : null;
  const cssHeight = emulation?.height && emulation.height > 0 ? Math.round(emulation.height) : null;
  if (cssWidth == null || cssHeight == null) {
    return { left: inset, top: inset, width: availableWidth, height: availableHeight, scale: 1 };
  }
  const scale = Math.min(1, availableWidth / cssWidth, availableHeight / cssHeight);
  const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 0;
  const width = Math.min(availableWidth, Math.round(cssWidth * safeScale));
  const height = Math.min(availableHeight, Math.round(cssHeight * safeScale));
  return {
    left: inset + Math.floor((availableWidth - width) / 2),
    top: inset + Math.floor((availableHeight - height) / 2),
    width,
    height,
    scale: safeScale,
  };
}

/**
 * Trim a measured rect to the box that actually clips it.
 *
 * The renderer measures the frame's own rect, which stays at its laid-out size
 * for a frame or two after a drag; without this the main process is handed a
 * width the pane no longer has and the page paints over the window edge.
 */
export function clampBrowserViewBounds(
  frame: { x: number; y: number; width: number; height: number },
  box: BrowserViewBox,
): { x: number; y: number; width: number; height: number } {
  const left = Math.max(Math.round(frame.x), Math.round(box.left));
  const top = Math.max(Math.round(frame.y), Math.round(box.top));
  const right = Math.min(Math.round(frame.x + frame.width), Math.round(box.right));
  const bottom = Math.min(Math.round(frame.y + frame.height), Math.round(box.bottom));
  return {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/**
 * The mono caption under a letterboxed view: `393 × 852`, and `393 × 852 · fit
 * 82%` when the pane was too small to show the device at 1:1.
 *
 * The numbers are always the CSS pixels the page is laid out at — the fit is
 * about this pane, not about the device, so it is an aside rather than a
 * different size.
 */
export function emulationCaption(
  emulation: { width?: number | null; height?: number | null } | null | undefined,
  scale?: number | null,
): string | null {
  if (!emulation?.width || !emulation.height) return null;
  const size = `${Math.round(emulation.width)} × ${Math.round(emulation.height)}`;
  if (typeof scale !== "number" || !Number.isFinite(scale) || scale <= 0 || scale >= 0.995) return size;
  return `${size} · fit ${Math.round(scale * 100)}%`;
}

/* ── Find errors ──────────────────────────────────────────────────────────── */

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

/* ── Dev servers ──────────────────────────────────────────────────────────── */

export type BrowserDevServer = {
  url: string;
  port: number | null;
  /** The command or framework behind the port, when the detector knows it. */
  source: string | null;
};

function devServerPort(url: string, explicit: unknown): number | null {
  if (typeof explicit === "number" && Number.isInteger(explicit) && explicit > 0) return explicit;
  try {
    const parsed = new URL(url);
    const port = Number.parseInt(parsed.port, 10);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * One entry from `builtInBrowser.getDevServers()`, defensively.
 *
 * The shape is owned by the main process and this panel also runs against an
 * older one during a dev reload, so a string, a bare port, or the full record
 * all have to land somewhere useful rather than throwing.
 */
export function normalizeDevServer(value: unknown): BrowserDevServer | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { url: `http://localhost:${value}`, port: value, source: null };
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const url = /^https?:/i.test(trimmed) ? trimmed : `http://${trimmed}`;
    return { url, port: devServerPort(url, null), source: null };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const rawUrl = typeof record.url === "string" && record.url.trim() ? record.url.trim() : null;
  const rawPort = typeof record.port === "number" ? record.port : null;
  const url = rawUrl
    ? (/^https?:/i.test(rawUrl) ? rawUrl : `http://${rawUrl}`)
    : rawPort != null
      ? `http://localhost:${rawPort}`
      : null;
  if (!url) return null;
  const source = ["command", "source", "framework", "label", "name"]
    .map((key) => (typeof record[key] === "string" ? (record[key] as string).trim() : ""))
    .find((text) => text.length > 0) ?? null;
  return { url, port: devServerPort(url, rawPort), source: source || null };
}

export function normalizeDevServers(value: unknown): BrowserDevServer[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { servers?: unknown }).servers)
      ? (value as { servers: unknown[] }).servers
      : [];
  const seen = new Set<string>();
  const servers: BrowserDevServer[] = [];
  for (const entry of list) {
    const server = normalizeDevServer(entry);
    if (!server || seen.has(server.url)) continue;
    seen.add(server.url);
    servers.push(server);
  }
  return servers;
}

/** Merge a freshly detected server into the list without duplicating it. */
export function mergeDevServer(
  servers: BrowserDevServer[],
  next: BrowserDevServer | null,
): BrowserDevServer[] {
  if (!next) return servers;
  const index = servers.findIndex((server) => server.url === next.url);
  if (index < 0) return [...servers, next];
  const current = servers[index];
  if (current.source === next.source) return servers;
  const merged = [...servers];
  merged[index] = { ...current, source: next.source ?? current.source };
  return merged;
}

/** `npm run dev · :5173`, or just `:5173` when nothing named the port. */
export function devServerChipLabel(server: BrowserDevServer): string {
  const port = server.port != null ? `:${server.port}` : shortHostLabel(server.url) ?? server.url;
  if (server.source) return `${server.source} · ${port}`;
  return server.port != null ? `localhost${port}` : port;
}

/* ── URL display ──────────────────────────────────────────────────────────── */

export type BrowserUrlDisplay = {
  /** Emphasised: the part that says which site you are on. */
  host: string;
  /** Dimmed: path, query and hash. Empty for a bare origin. */
  rest: string;
};

/**
 * Split a URL the way Arc and Zen show it — host bright, path faded — so a long
 * URL still answers "where am I?" at a glance in a 300px pane.
 */
export function splitUrlForDisplay(url: string | null | undefined): BrowserUrlDisplay | null {
  const value = (url ?? "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.host.replace(/^www\./i, "");
    if (!host) return null;
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return { host, rest: `${path}${parsed.search}${parsed.hash}` };
  } catch {
    return null;
  }
}

/** A clipboard string worth offering as "Paste a link", or null. */
export function clipboardUrlCandidate(text: string | null | undefined): string | null {
  const value = (text ?? "").trim();
  if (!value || /\s/.test(value) || value.length > 2_048) return null;
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return parsed.host ? value : null;
    } catch {
      return null;
    }
  }
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)) return `http://${value}`;
  if (/^[^/\s.]+(\.[^/\s.]+)+(:\d+)?(\/|$)/.test(value)) return `https://${value}`;
  return null;
}
