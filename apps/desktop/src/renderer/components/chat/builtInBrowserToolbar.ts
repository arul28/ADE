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

/* ── Responsive toolbar ───────────────────────────────────────────────────── */

/** Below this the toolbar drops every text label and goes icon-only. */
export const BROWSER_TOOLBAR_COMPACT_WIDTH = 420;
/** Below this only `← ⟳ [URL] ⋮` survives; everything else moves to overflow. */
export const BROWSER_TOOLBAR_MINIMAL_WIDTH = 360;

export type BrowserToolbarDensity = "full" | "compact" | "minimal";

export type BrowserToolbarLayout = {
  density: BrowserToolbarDensity;
  /** Text next to an icon: the device name, "Inspect", "Open". */
  showLabels: boolean;
  showForward: boolean;
  showDevice: boolean;
  showCamera: boolean;
  showInspect: boolean;
  /** The URL field's trailing "Open" submit button. Enter always works. */
  showOpenButton: boolean;
};

/**
 * How much toolbar fits in `width`.
 *
 * A pane dragged to 300px used to keep every control at its natural width and
 * push the overflow button off-screen, which is worse than hiding things: the
 * one control that could still reach them was the one that disappeared. So the
 * row sheds labels first, then whole controls into the overflow menu, and the
 * menu button is the last thing standing.
 */
export function browserToolbarLayout(width: number | null | undefined): BrowserToolbarLayout {
  const value = typeof width === "number" && Number.isFinite(width) && width > 0
    ? width
    : Number.POSITIVE_INFINITY;
  if (value < BROWSER_TOOLBAR_MINIMAL_WIDTH) {
    return {
      density: "minimal",
      showLabels: false,
      showForward: false,
      showDevice: false,
      showCamera: false,
      showInspect: false,
      showOpenButton: false,
    };
  }
  if (value < BROWSER_TOOLBAR_COMPACT_WIDTH) {
    return {
      density: "compact",
      showLabels: false,
      showForward: true,
      showDevice: true,
      showCamera: true,
      showInspect: true,
      showOpenButton: false,
    };
  }
  return {
    density: "full",
    showLabels: true,
    showForward: true,
    showDevice: true,
    showCamera: true,
    showInspect: true,
    showOpenButton: true,
  };
}

/* ── Native view geometry ─────────────────────────────────────────────────── */

export type BrowserViewFrame = {
  left: number;
  top: number;
  width: number;
  height: number;
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
 * size exactly, centred — and clamped to the stage, because a 393×852 phone in
 * a 300px pane cannot be honoured and painting past the pane is the bug this
 * whole pass exists to fix.
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
    return { left: inset, top: inset, width: availableWidth, height: availableHeight };
  }
  const width = Math.min(cssWidth, availableWidth);
  const height = Math.min(cssHeight, availableHeight);
  return {
    left: inset + Math.floor((availableWidth - width) / 2),
    top: inset + Math.floor((availableHeight - height) / 2),
    width,
    height,
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

/** The mono caption under a letterboxed view: `393 × 852`. */
export function emulationCaption(
  emulation: { width?: number | null; height?: number | null } | null | undefined,
): string | null {
  if (!emulation?.width || !emulation.height) return null;
  return `${Math.round(emulation.width)} × ${Math.round(emulation.height)}`;
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
