/**
 * The Android emulator contract, recordings at Apple's level: the machine
 * preferences (overlays, auto-record, the storage warning, the remote
 * bitrate cap), the lane's auto-record switch, and who drove an input.
 * Re-exported from `androidEmulator.ts`; import from there.
 */

import type { AndroidLaneArgs } from "./androidEmulator";

/* ---------- who drove the device ---------- */

/**
 * Who sent an input. Only `agent` may START an automatic recording. The
 * desktop preload stamps `user` on the pane's calls; absent means `agent`,
 * so every caller that is not a viewer (the CLI, an agent's action) counts.
 */
export type AndroidInputSource = "user" | "agent";

/** Fields every input call may carry, beside its own. */
export type AndroidInputRecordArgs = {
  source?: AndroidInputSource | null;
  /** `--no-record`: this call does not start an automatic recording. */
  noRecord?: boolean | null;
  /** Set by the runtime for an agent: the chat that owns an automatic recording. */
  chatSessionId?: string | null;
};

/* ---------- machine preferences ---------- */

const GIB = 1024 ** 3;

/**
 * The machine's Android recording and viewer preferences, kept in the
 * machine's Android settings file (`<ADE home>/android/settings.json`)
 * under `preferences`, beside `sdkPath`.
 */
export type AndroidMachinePreferences = {
  /** Draw a ring where each input landed, in the demo. */
  tapRings: boolean;
  /** Show typed text (never a password field's) in the demo. */
  keyBadges: boolean;
  /** An agent's input starts an automatic recording when none runs. */
  autoRecordAgentInput: boolean;
  /** The Health warning shows when this project's recordings pass this many bytes. */
  recordingsWarnBytes: number;
  /** The highest bitrate a viewer on another machine gets, in kbit/s. */
  remoteBitrateKbpsCap: number;
};

export const ANDROID_REMOTE_BITRATE_KBPS_MIN = 100;
export const ANDROID_REMOTE_BITRATE_KBPS_MAX = 20_000;
export const ANDROID_RECORDINGS_WARN_GIB_MIN = 1;
export const ANDROID_RECORDINGS_WARN_GIB_MAX = 100;

export const DEFAULT_ANDROID_MACHINE_PREFERENCES: Readonly<AndroidMachinePreferences> = Object.freeze({
  tapRings: true,
  keyBadges: true,
  autoRecordAgentInput: true,
  recordingsWarnBytes: 5 * GIB,
  remoteBitrateKbpsCap: 2500,
});

function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Reads stored or sent preferences: a missing or bad field takes its
 * default, numbers are clamped (bitrate 100–20000 kbit/s, warning 1–100 GiB).
 * `base` fills the fields `raw` leaves out (a partial write keeps the rest).
 */
export function normalizeAndroidMachinePreferences(
  raw: unknown,
  base: AndroidMachinePreferences = DEFAULT_ANDROID_MACHINE_PREFERENCES,
): AndroidMachinePreferences {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flag = (key: "tapRings" | "keyBadges" | "autoRecordAgentInput"): boolean =>
    typeof input[key] === "boolean" ? (input[key] as boolean) : base[key];
  return {
    tapRings: flag("tapRings"),
    keyBadges: flag("keyBadges"),
    autoRecordAgentInput: flag("autoRecordAgentInput"),
    recordingsWarnBytes: clampInteger(
      input.recordingsWarnBytes,
      ANDROID_RECORDINGS_WARN_GIB_MIN * GIB,
      ANDROID_RECORDINGS_WARN_GIB_MAX * GIB,
      base.recordingsWarnBytes,
    ),
    remoteBitrateKbpsCap: clampInteger(
      input.remoteBitrateKbpsCap,
      ANDROID_REMOTE_BITRATE_KBPS_MIN,
      ANDROID_REMOTE_BITRATE_KBPS_MAX,
      base.remoteBitrateKbpsCap,
    ),
  };
}

/** `getMachinePreferences` and `setMachinePreferences` answer this. */
export type AndroidMachinePreferencesResult = {
  preferences: AndroidMachinePreferences;
  /** Bytes of this project's Android recordings on that machine; null when they cannot be counted. */
  recordingsBytes: number | null;
};

/* ---------- the lane's auto-record switch ---------- */

export type AndroidAutoRecordState = {
  laneId: string | null;
  /** The lane's switch (`ade android auto-record on|off`). */
  lane: boolean;
  /** The machine's "Record agent input" preference. */
  machine: boolean;
  /** Both on: an agent's input starts a recording. */
  enabled: boolean;
};

export type AndroidSetAutoRecordArgs = AndroidLaneArgs & { enabled: boolean };

export type AndroidEmulatorRecordingServiceApi = {
  getMachinePreferences(args?: Record<string, never> | null): Promise<AndroidMachinePreferencesResult>;
  /** Person-only. A partial write keeps the other fields (and the SDK folder). */
  setMachinePreferences(args: Partial<AndroidMachinePreferences>): Promise<AndroidMachinePreferencesResult>;
  getAutoRecord(args: AndroidLaneArgs): Promise<AndroidAutoRecordState>;
  setAutoRecord(args: AndroidSetAutoRecordArgs): Promise<AndroidAutoRecordState>;
};
