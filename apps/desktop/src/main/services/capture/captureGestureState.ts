import path from "node:path";
import {
  captureGestureChordLabel,
  captureGestureUnavailableReason,
  isCaptureGestureSupported,
} from "../../../shared/captureGesturePlatformSupport";
import type {
  CaptureGestureFailure,
  CaptureGestureHealth,
  CaptureGestureSource,
} from "../../../shared/types/captureGesture";

/**
 * Everything about the capture gesture that is a decision rather than an effect.
 *
 * Split out of `captureHelper.ts` for the same reason the notch splits
 * `attentionNotchRouter` out of `attentionNotchHelper`: the interesting bugs in
 * a supervised child process live in "should this chord fire", "is this line
 * the helper sent me actually a capture", and "what do we tell the user when it
 * stopped" — none of which need a process to test.
 */

/** Executable name per platform. Windows needs the extension to spawn at all. */
export function captureHelperExecutableName(platform: NodeJS.Platform | string): string {
  return platform === "win32" ? "ade-capture-helper.exe" : "ade-capture-helper";
}

/**
 * Where the helper lives, packaged and in development.
 *
 * The two-branch shape is lifted wholesale from
 * `resolveAttentionNotchExecutablePath`: packaged builds put extraResources
 * under `process.resourcesPath`, while a dev run resolves them relative to
 * `app.getAppPath()`, which is the `apps/desktop` checkout. Getting this wrong
 * is invisible in dev and fatal in the DMG.
 */
export function resolveCaptureHelperExecutablePath(input: {
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform?: NodeJS.Platform | string;
}): string {
  const name = captureHelperExecutableName(input.platform ?? process.platform);
  return input.isPackaged
    ? path.join(input.resourcesPath, "native", name)
    : path.join(input.appPath, "resources", "native", name);
}

/* ────────────────────────── chord admission ────────────────────────── */

export type CaptureChordDecision =
  | { action: "capture" }
  | { action: "ignore"; reason: "disabled" | "in-flight" | "cooldown" };

/**
 * Whether a chord the helper just reported should actually take a shot.
 *
 * Three refusals, and they are not interchangeable:
 *
 * - `disabled` — the setting is off. The helper should not even be running, but
 *   a chord already in flight when the user flipped the switch must not land.
 * - `in-flight` — a capture is already running. `screencapture` takes ~100-300ms
 *   and the chord is *modifier keys*, which people hold; without this a single
 *   deliberate press produces a burst of identical attachments.
 * - `cooldown` — a shot landed very recently. Releasing and re-pressing one of
 *   two held Command keys re-fires the chord, so the in-flight guard alone does
 *   not cover a natural "press and wiggle".
 */
export function evaluateCaptureChord(input: {
  enabled: boolean;
  captureInFlight: boolean;
  lastCaptureAtMs: number | null;
  nowMs: number;
  cooldownMs: number;
}): CaptureChordDecision {
  if (!input.enabled) return { action: "ignore", reason: "disabled" };
  if (input.captureInFlight) return { action: "ignore", reason: "in-flight" };
  if (
    input.lastCaptureAtMs != null
    && input.nowMs - input.lastCaptureAtMs < input.cooldownMs
  ) {
    return { action: "ignore", reason: "cooldown" };
  }
  return { action: "capture" };
}

/* ────────────────────────── helper protocol ────────────────────────── */

/**
 * What the native helper is allowed to say. Anything else is dropped with a
 * warning rather than crashing the supervisor: a helper newer than this build
 * may well emit a message type this build has never heard of, and losing one
 * unknown line is better than losing the process.
 */
export type CaptureHelperOutput =
  | { type: "ready" }
  | { type: "chord" }
  | {
      type: "captured";
      path: string;
      appName: string | null;
      windowTitle: string | null;
      ownerPid: number | null;
      bounds: { x: number; y: number; width: number; height: number } | null;
    }
  | { type: "permission-denied" }
  | { type: "no-window" }
  | { type: "capture-failed"; message: string };

export type CaptureHelperInput =
  | { type: "capture" }
  | { type: "settings"; enabled: boolean }
  | { type: "quit" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export type CaptureWindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function parseBounds(value: unknown): CaptureWindowBounds | null {
  if (!isRecord(value)) return null;
  const { x, y, width, height } = value;
  if (
    typeof x !== "number" || typeof y !== "number"
    || typeof width !== "number" || typeof height !== "number"
  ) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (!(width > 0) || !(height > 0)) return null;
  return { x, y, width, height };
}

/**
 * Parse one NDJSON line from the helper, or return null.
 *
 * Returns null for BOTH malformed JSON and a well-formed message this build
 * cannot interpret; the caller logs them differently because only the first is
 * a protocol violation worth showing in health.
 */
export function parseCaptureHelperOutput(line: string): CaptureHelperOutput | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string") return null;
  switch (parsed.type) {
    case "ready":
      return { type: "ready" };
    case "chord":
      return { type: "chord" };
    case "permission-denied":
      return { type: "permission-denied" };
    case "no-window":
      return { type: "no-window" };
    case "capture-failed":
      return {
        type: "capture-failed",
        message: optionalString(parsed.message) ?? "The window could not be captured.",
      };
    case "captured": {
      const capturedPath = optionalString(parsed.path);
      if (!capturedPath) return null;
      const ownerPid = typeof parsed.ownerPid === "number" && Number.isFinite(parsed.ownerPid)
        ? parsed.ownerPid
        : null;
      return {
        type: "captured",
        path: capturedPath,
        appName: optionalString(parsed.appName),
        windowTitle: optionalString(parsed.windowTitle),
        ownerPid,
        bounds: parseBounds(parsed.bounds),
      };
    }
    default:
      return null;
  }
}

/* ────────────────────────── presentation ────────────────────────── */

/**
 * The macOS remedy, once.
 *
 * Two surfaces tell the user this — the refusal a capture returns and the
 * health card in Settings — and they were two sentences saying the same thing
 * in different words, which reads as two different problems.
 */
export const MAC_OS_SCREEN_RECORDING_REMEDY =
  "Grant Screen Recording to ADE in System Settings › Privacy & Security › Screen Recording, then restart ADE.";

/**
 * What the capture-gesture IPC answers when no supervisor exists — a runtime
 * mode that never built one, or a platform with no helper. Deliberately the
 * same verdict `captureGestureHealth()` returns for an unsupported platform.
 *
 * One constant, because two copies of a verdict are two verdicts.
 */
export const UNAVAILABLE_CAPTURE_GESTURE_HEALTH: CaptureGestureHealth = {
  state: "unsupported",
  title: "Screen capture gesture isn’t available here",
  message: "This ADE build does not include the native capture helper.",
  recovery: null,
};

/**
 * Why the capture was refused, in the terms of the platform that refused it.
 *
 * Three branches, not two: a `darwin`-or-else split sends a Linux user to a
 * Windows group-policy explanation. The gesture is macOS and Windows only
 * today, so the default is unreachable — but the day a third platform lands it
 * is the difference between a vague message and a wrong one.
 */
function permissionDeniedMessageFor(platform: string): string {
  if (platform === "darwin") {
    return `ADE needs Screen Recording permission to capture a window. ${MAC_OS_SCREEN_RECORDING_REMEDY}`;
  }
  if (platform === "win32") {
    return "Windows refused the keyboard hook the gesture needs. This is usually endpoint security or a group policy; ADE cannot grant it for you.";
  }
  return "This system refused the permission the capture gesture needs.";
}

export function captureFailureFor(
  output: Extract<
    CaptureHelperOutput,
    { type: "permission-denied" | "no-window" | "capture-failed" }
  >,
  source: CaptureGestureSource,
  platform: string = process.platform,
): CaptureGestureFailure {
  if (output.type === "permission-denied") {
    // The two platforms deny for different reasons and have different
    // remedies. Windows has no Screen Recording pane, so sending a Windows
    // user there is worse than saying nothing.
    return {
      reason: "permission-denied",
      source,
      message: permissionDeniedMessageFor(platform),
    };
  }
  if (output.type === "no-window") {
    return {
      reason: "no-window",
      source,
      message: "There was no window in front to capture.",
    };
  }
  return { reason: "capture-failed", source, message: output.message };
}

export type CaptureHealthInput = {
  platform: NodeJS.Platform;
  enabled: boolean;
  executableExists: boolean;
  running: boolean;
  permissionDenied: boolean;
  exhaustedRestarts: boolean;
};

/**
 * One health verdict, in the order the user can act on it.
 *
 * Platform first, exactly as the notch does it: "turn the gesture on" is not an
 * actionable instruction on a machine where no helper was ever built, and
 * showing the disabled state there tells the user to do something impossible.
 */
export function captureGestureHealth(input: CaptureHealthInput): CaptureGestureHealth {
  if (!isCaptureGestureSupported(input.platform)) {
    return {
      state: "unsupported",
      title: "Screen capture gesture isn’t available here",
      message: captureGestureUnavailableReason(input.platform)
        ?? "This platform has no capture helper.",
      recovery: null,
    };
  }
  if (!input.enabled) {
    return {
      state: "disabled",
      title: "Capture gesture is off",
      message: `Turn it on to grab the window in front with ${captureGestureChordLabel(input.platform)}.`,
      recovery: null,
    };
  }
  if (!input.executableExists) {
    return {
      state: "missing",
      title: "The capture helper is missing",
      message: "This ADE installation shipped without the native capture helper. Reinstall or update ADE, then restart the app.",
      recovery: "reinstall_or_update",
    };
  }
  if (input.permissionDenied) {
    return {
      state: "permission_denied",
      title: "ADE can’t record the screen",
      message: input.platform === "darwin"
        ? MAC_OS_SCREEN_RECORDING_REMEDY
        : "Windows refused the screen capture. Restart ADE and try again.",
      recovery: "grant_permission",
    };
  }
  if (input.running) {
    return {
      state: "running",
      title: "Capture gesture is active",
      message: `Press ${captureGestureChordLabel(input.platform)} anywhere to send the window in front to the CTO.`,
      recovery: null,
    };
  }
  if (input.exhaustedRestarts) {
    return {
      state: "crash_loop",
      title: "The capture helper stopped",
      message: "The native helper repeatedly exited. Restart ADE; if it happens again, reinstall or update the app.",
      recovery: "retry",
    };
  }
  return {
    state: "starting",
    title: "Capture gesture is starting",
    message: "ADE is preparing the native capture helper.",
    recovery: "retry",
  };
}

/** Stable, sortable, filesystem-safe attachment name for one shot. */
export function captureAttachmentFilename(capturedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "ade-capture-",
    capturedAt.getFullYear(),
    pad(capturedAt.getMonth() + 1),
    pad(capturedAt.getDate()),
    "-",
    pad(capturedAt.getHours()),
    pad(capturedAt.getMinutes()),
    pad(capturedAt.getSeconds()),
    ".png",
  ].join("");
}
