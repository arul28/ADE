/**
 * Apple-device preference keys and defaults.
 *
 * Names match `docs/plans/apple-device-env-contracts.md` so the recorder,
 * stream, and settings UI all read one vocabulary. The settings manifest
 * namespaces the same rows as `appearance.apple-*` for search and deeplinks.
 */

export const APPLE_RECORDINGS_RELATIVE_DIR = ".ade/artifacts/apple-recordings";

export const GIB = 1024 ** 3;

export const APPLE_DEVICE_SETTING_KEYS = {
  realisticBody: "apple.realisticBody",
  tapRings: "apple.recordingOverlays.tapRings",
  keyBadges: "apple.recordingOverlays.keyBadges",
  remoteBitrateKbpsCap: "apple.remoteBitrateKbpsCap",
  recordingsWarnBytes: "apple.recordingsWarnBytes",
} as const;

export const DEFAULT_APPLE_REALISTIC_BODY = true;
export const DEFAULT_APPLE_TAP_RINGS = true;
export const DEFAULT_APPLE_KEY_BADGES = true;
export const DEFAULT_APPLE_REMOTE_BITRATE_KBPS = 2500;
export const DEFAULT_APPLE_RECORDINGS_WARN_BYTES = 5 * GIB;

export const APPLE_REMOTE_BITRATE_KBPS_MIN = 100;
export const APPLE_REMOTE_BITRATE_KBPS_MAX = 20_000;
export const APPLE_RECORDINGS_WARN_GIB_MIN = 1;
export const APPLE_RECORDINGS_WARN_GIB_MAX = 100;

export type AppleDevicePreferences = {
  realisticBody: boolean;
  recordingTapRings: boolean;
  recordingKeyBadges: boolean;
  remoteBitrateKbpsCap: number;
  recordingsWarnBytes: number;
};

export const DEFAULT_APPLE_DEVICE_PREFERENCES: AppleDevicePreferences = {
  realisticBody: DEFAULT_APPLE_REALISTIC_BODY,
  recordingTapRings: DEFAULT_APPLE_TAP_RINGS,
  recordingKeyBadges: DEFAULT_APPLE_KEY_BADGES,
  remoteBitrateKbpsCap: DEFAULT_APPLE_REMOTE_BITRATE_KBPS,
  recordingsWarnBytes: DEFAULT_APPLE_RECORDINGS_WARN_BYTES,
};

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

export function clampAppleRemoteBitrateKbps(value: unknown): number {
  const next = asFiniteNumber(value);
  if (next == null) return DEFAULT_APPLE_REMOTE_BITRATE_KBPS;
  return Math.max(
    APPLE_REMOTE_BITRATE_KBPS_MIN,
    Math.min(APPLE_REMOTE_BITRATE_KBPS_MAX, Math.round(next)),
  );
}

export function clampAppleRecordingsWarnBytes(value: unknown): number {
  const next = asFiniteNumber(value);
  if (next == null) return DEFAULT_APPLE_RECORDINGS_WARN_BYTES;
  return Math.max(0, Math.round(next));
}

/**
 * Accepts either the in-memory shape or the contract-shaped blob written to
 * localStorage / the account store (`recordingOverlays.tapRings`, …).
 */
export function normalizeAppleDevicePreferences(value: unknown): AppleDevicePreferences {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const overlays = record.recordingOverlays && typeof record.recordingOverlays === "object"
    && !Array.isArray(record.recordingOverlays)
    ? record.recordingOverlays as Record<string, unknown>
    : {};
  return {
    realisticBody: asBoolean(record.realisticBody, DEFAULT_APPLE_REALISTIC_BODY),
    recordingTapRings: asBoolean(
      record.recordingTapRings ?? overlays.tapRings,
      DEFAULT_APPLE_TAP_RINGS,
    ),
    recordingKeyBadges: asBoolean(
      record.recordingKeyBadges ?? overlays.keyBadges,
      DEFAULT_APPLE_KEY_BADGES,
    ),
    remoteBitrateKbpsCap: clampAppleRemoteBitrateKbps(record.remoteBitrateKbpsCap),
    recordingsWarnBytes: clampAppleRecordingsWarnBytes(record.recordingsWarnBytes),
  };
}

/** Contract-shaped payload for persistence and account sync. */
export function serializeAppleDevicePreferences(
  prefs: AppleDevicePreferences,
): Record<string, unknown> {
  return {
    realisticBody: prefs.realisticBody,
    recordingOverlays: {
      tapRings: prefs.recordingTapRings,
      keyBadges: prefs.recordingKeyBadges,
    },
    remoteBitrateKbpsCap: prefs.remoteBitrateKbpsCap,
    recordingsWarnBytes: prefs.recordingsWarnBytes,
  };
}

export function warnGibFromBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return APPLE_RECORDINGS_WARN_GIB_MIN;
  return Math.max(
    APPLE_RECORDINGS_WARN_GIB_MIN,
    Math.min(APPLE_RECORDINGS_WARN_GIB_MAX, Math.round(bytes / GIB)),
  );
}

export function warnBytesFromGib(gib: number): number {
  const clamped = Math.max(
    APPLE_RECORDINGS_WARN_GIB_MIN,
    Math.min(APPLE_RECORDINGS_WARN_GIB_MAX, Math.round(gib)),
  );
  return clamped * GIB;
}
