import type {
  BuiltInBrowserEmulationMetrics,
  BuiltInBrowserEmulationPreset,
  BuiltInBrowserEmulationPresetId,
  BuiltInBrowserEmulationState,
} from "./types/builtInBrowser";

/**
 * Device emulation presets shared by the browser service, the CLI
 * (`ade browser emulate --device …`) and the Browser toolbar. Keeping the table
 * in `shared/` means main, preload and renderer agree on the exact metrics, so
 * a screenshot taken by an agent matches what a human sees in the same preset.
 */

const IPHONE_17_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";

export const BUILT_IN_BROWSER_EMULATION_PRESETS: readonly BuiltInBrowserEmulationPreset[] = [
  {
    id: "desktop",
    label: "Desktop",
    width: 0,
    height: 0,
    deviceScaleFactor: 0,
    mobile: false,
    hasTouch: false,
    userAgent: null,
  },
  {
    id: "iphone-17",
    label: "iPhone 17",
    width: 393,
    height: 852,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: IPHONE_17_UA,
  },
  {
    id: "iphone-17-pro",
    label: "iPhone 17 Pro",
    width: 402,
    height: 874,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: IPHONE_17_UA,
  },
  {
    id: "iphone-17-pro-max",
    label: "iPhone 17 Pro Max",
    width: 440,
    height: 956,
    deviceScaleFactor: 3,
    mobile: true,
    hasTouch: true,
    userAgent: IPHONE_17_UA,
  },
  {
    id: "ipad",
    label: "iPad",
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    mobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
  },
  {
    id: "pixel",
    label: "Pixel",
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    hasTouch: true,
    userAgent: PIXEL_UA,
  },
  {
    id: "responsive",
    label: "Responsive",
    width: 1024,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
    hasTouch: false,
    userAgent: null,
  },
] as const;

export const BUILT_IN_BROWSER_EMULATION_PRESET_IDS: readonly BuiltInBrowserEmulationPresetId[] =
  BUILT_IN_BROWSER_EMULATION_PRESETS.map((preset) => preset.id);

/** `desktop` is the "no override" preset — selecting it clears emulation. */
export const BUILT_IN_BROWSER_EMULATION_OFF_PRESET_ID: BuiltInBrowserEmulationPresetId = "desktop";

export const BUILT_IN_BROWSER_MIN_EMULATION_DIMENSION = 64;
export const BUILT_IN_BROWSER_MAX_EMULATION_DIMENSION = 10_000;
export const BUILT_IN_BROWSER_MIN_DEVICE_SCALE_FACTOR = 0.25;
export const BUILT_IN_BROWSER_MAX_DEVICE_SCALE_FACTOR = 5;

/** Accepts `iphone17Pro`, `iPhone 17 Pro`, `iphone-17-pro`, … */
function normalizePresetToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1-$2")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function findBuiltInBrowserEmulationPreset(
  value: string | null | undefined,
): BuiltInBrowserEmulationPreset | null {
  if (typeof value !== "string") return null;
  const token = normalizePresetToken(value);
  if (!token) return null;
  return (
    BUILT_IN_BROWSER_EMULATION_PRESETS.find((preset) => preset.id === token)
    ?? BUILT_IN_BROWSER_EMULATION_PRESETS.find(
      (preset) => normalizePresetToken(preset.label) === token,
    )
    ?? null
  );
}

export type BuiltInBrowserEmulationRequest = {
  preset?: string | null;
  width?: number | null;
  height?: number | null;
  deviceScaleFactor?: number | null;
  mobile?: boolean | null;
  userAgent?: string | null;
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Resolves a `setEmulation` request into the state we persist per tab.
 *
 * Returns `null` when emulation should be cleared: an explicit `null`/`"off"`
 * preset, or the `desktop` preset (whose whole point is "no override").
 * Throws on an unknown preset id or an incomplete custom size so a typo never
 * silently leaves the tab at desktop metrics.
 */
export function resolveBuiltInBrowserEmulation(
  request: BuiltInBrowserEmulationRequest,
): BuiltInBrowserEmulationState | null {
  const rawPreset = typeof request.preset === "string" ? request.preset.trim() : null;
  const width = finiteOrNull(request.width);
  const height = finiteOrNull(request.height);
  const hasExplicitSize = width != null || height != null;

  if (rawPreset && !hasExplicitSize) {
    const lowered = rawPreset.toLowerCase();
    if (lowered === "off" || lowered === "none" || lowered === "clear" || lowered === "reset") {
      return null;
    }
    const preset = findBuiltInBrowserEmulationPreset(rawPreset);
    if (!preset) {
      throw new Error(
        `Unknown browser device preset: ${rawPreset}. Known presets: ${BUILT_IN_BROWSER_EMULATION_PRESET_IDS.join(", ")}.`,
      );
    }
    if (preset.id === BUILT_IN_BROWSER_EMULATION_OFF_PRESET_ID) return null;
    return {
      presetId: preset.id,
      label: preset.label,
      width: preset.width,
      height: preset.height,
      deviceScaleFactor: preset.deviceScaleFactor,
      mobile: preset.mobile,
      hasTouch: preset.hasTouch,
      userAgent: typeof request.userAgent === "string" && request.userAgent.trim()
        ? request.userAgent.trim()
        : preset.userAgent,
    };
  }

  if (!hasExplicitSize) {
    if (request.preset === null) return null;
    if (rawPreset) {
      // Unreachable: handled above. Kept for exhaustiveness during refactors.
      throw new Error(`Unknown browser device preset: ${rawPreset}.`);
    }
    return null;
  }

  if (width == null || height == null) {
    throw new Error("Browser emulation requires both width and height when setting a custom size.");
  }
  const base = findBuiltInBrowserEmulationPreset(rawPreset ?? "responsive")
    ?? findBuiltInBrowserEmulationPreset("responsive")!;
  const mobile = typeof request.mobile === "boolean" ? request.mobile : base.mobile;
  const scale = finiteOrNull(request.deviceScaleFactor) ?? (base.deviceScaleFactor || 1);
  const clampedWidth = Math.round(
    clampNumber(width, BUILT_IN_BROWSER_MIN_EMULATION_DIMENSION, BUILT_IN_BROWSER_MAX_EMULATION_DIMENSION),
  );
  const clampedHeight = Math.round(
    clampNumber(height, BUILT_IN_BROWSER_MIN_EMULATION_DIMENSION, BUILT_IN_BROWSER_MAX_EMULATION_DIMENSION),
  );
  return {
    presetId: "responsive",
    // Label the metrics we actually apply, not the ones that were asked for.
    label: `${clampedWidth}×${clampedHeight}`,
    width: clampedWidth,
    height: clampedHeight,
    deviceScaleFactor: clampNumber(scale, BUILT_IN_BROWSER_MIN_DEVICE_SCALE_FACTOR, BUILT_IN_BROWSER_MAX_DEVICE_SCALE_FACTOR),
    mobile,
    hasTouch: mobile,
    userAgent: typeof request.userAgent === "string" && request.userAgent.trim()
      ? request.userAgent.trim()
      : (rawPreset ? base.userAgent : null),
  };
}

export function builtInBrowserEmulationMetrics(
  state: BuiltInBrowserEmulationState,
): BuiltInBrowserEmulationMetrics {
  return {
    width: state.width,
    height: state.height,
    deviceScaleFactor: state.deviceScaleFactor,
    mobile: state.mobile,
    userAgent: state.userAgent,
  };
}
