import {
  ANDROID_EMULATOR_ERROR_CODES,
  type AndroidEmulatorErrorCode,
} from "../../../shared/types/androidEmulator";
import type {
  AndroidAvd,
  AndroidAvdListing,
  AndroidEmulatorStatus,
  AndroidHardwareProfile,
  AndroidLaneDeviceStatus,
  AndroidSdkStatus,
  AndroidSdkTool,
} from "../../../shared/types/androidEmulator";

/**
 * What the Android pane shows, from the brain's status and the stream.
 *
 * One function, so the body, the strip and the rail agree. The order of the
 * checks is the order of the questions: can this host run it at all, is the
 * SDK here, does the lane hold a device, and what is that device doing.
 */
export type AndroidPaneState =
  /** `window.ade.androidEmulator` is missing (an older shell, the web client). */
  | "unavailable"
  | "loading"
  | "status-failed"
  | "unsupported"
  | "setup"
  | "picker"
  | "starting"
  | "live"
  | "video-lost"
  | "stopped"
  | "crashed";

export type AndroidStreamState = "idle" | "starting" | "live" | "stalled" | "paused" | "error";

/** The SDK parts a boot cannot do without. `cmdline-tools` is optional: ADE writes AVD files itself. */
const REQUIRED_SDK_TOOLS: ReadonlyArray<AndroidSdkTool["id"]> = ["platform-tools", "emulator", "system-image"];

export function androidSdkTool(sdk: AndroidSdkStatus, id: AndroidSdkTool["id"]): AndroidSdkTool | null {
  return sdk.tools.find((tool) => tool.id === id) ?? null;
}

/** True when the setup card is the answer: no SDK, or a part a boot needs is missing. */
function androidSetupNeeded(sdk: AndroidSdkStatus): boolean {
  if (!sdk.found) return true;
  // A part the brain did not report is not called missing.
  return REQUIRED_SDK_TOOLS.some((id) => androidSdkTool(sdk, id)?.available === false);
}

export function resolveAndroidPaneState(input: {
  apiPresent: boolean;
  status: AndroidEmulatorStatus | null;
  statusFailed: boolean;
  /** The user opened the picker over a device the lane already holds. */
  pickerRequested: boolean;
  /** A create, attach or start this pane sent and that has not answered yet. */
  pendingStart: boolean;
  stream: AndroidStreamState;
  /** The stream's automatic reconnects ran out. */
  streamGaveUp: boolean;
}): AndroidPaneState {
  if (!input.apiPresent) return "unavailable";
  const status = input.status;
  if (!status) return input.statusFailed ? "status-failed" : "loading";
  if (!status.platformSupported) return "unsupported";
  if (androidSetupNeeded(status.sdk)) return "setup";
  if (input.pendingStart) return "starting";
  const laneState = status.lane?.state ?? "none";
  if (input.pickerRequested || laneState === "none" || !status.lane?.device) return "picker";
  switch (laneState) {
    case "starting":
    case "stopping":
      return "starting";
    case "crashed":
      return "crashed";
    case "off":
      return "stopped";
    case "booted":
    default:
      if (input.stream === "live") return "live";
      if (input.streamGaveUp || input.stream === "error") return "video-lost";
      return "starting";
  }
}

/** The rail is up while there is a device picture, live or not. */
export function androidRailVisible(state: AndroidPaneState): boolean {
  return state === "live" || state === "video-lost";
}

/** Touch and keys go to the device only while it draws. */
export function androidInputAllowed(state: AndroidPaneState): boolean {
  return state === "live";
}

/**
 * The device's size in device pixels, in the orientation the video shows.
 *
 * Touches go to the brain in device pixels and the brain scales them to the
 * video (`androidStream.sendTouch`), so the flat view measures its box in
 * these units. The AVD's LCD is portrait; the stream turns with the device, so
 * a landscape video means the long side runs across. Falls back to the
 * decoded size when the AVD does not say, which is what the brain also uses
 * when it could not read `wm size`.
 */
export function androidDevicePixelSize(
  avd: Pick<AndroidAvd, "lcdWidth" | "lcdHeight"> | null,
  video: { width: number | null; height: number | null } | null,
): { width: number; height: number } | null {
  const videoWidth = video?.width ?? null;
  const videoHeight = video?.height ?? null;
  const lcdWidth = avd?.lcdWidth ?? null;
  const lcdHeight = avd?.lcdHeight ?? null;
  if (lcdWidth && lcdHeight && lcdWidth > 0 && lcdHeight > 0) {
    const long = Math.max(lcdWidth, lcdHeight);
    const short = Math.min(lcdWidth, lcdHeight);
    const landscape = Boolean(videoWidth && videoHeight && videoWidth > videoHeight);
    return landscape ? { width: long, height: short } : { width: short, height: long };
  }
  if (videoWidth && videoHeight && videoWidth > 0 && videoHeight > 0) {
    return { width: videoWidth, height: videoHeight };
  }
  return null;
}

/** The name a person reads: the AVD's display name, or its folder name. */
export function androidAvdLabel(avd: Pick<AndroidAvd, "name" | "displayName"> | null | undefined): string {
  return avd?.displayName?.trim() || avd?.name || "Android device";
}

/** `Medium Phone · API 36`: the profile and the Android version, with the parts that exist. */
export function androidAvdSpecLine(
  avd: Pick<AndroidAvd, "profileId" | "apiLevel">,
  profiles: readonly AndroidHardwareProfile[],
): string {
  const profile = avd.profileId ? profiles.find((entry) => entry.id === avd.profileId) ?? null : null;
  // Before the inventory is read (it is read only for the picker), the id reads
  // as words: `medium_phone` becomes "Medium phone".
  const profileName = profile?.name ?? (avd.profileId ? androidProfileIdWords(avd.profileId) : null);
  return [profileName, avd.apiLevel ? `API ${avd.apiLevel}` : null].filter(Boolean).join(" · ") || "Android emulator";
}

function androidProfileIdWords(id: string): string {
  const words = id.replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
}

/** The lane device's name for the strip, the rail and the loading card. */
export function androidLaneDeviceName(lane: AndroidLaneDeviceStatus | null | undefined): string {
  if (lane?.avd) return androidAvdLabel(lane.avd);
  return lane?.device?.avdName ?? "Android device";
}

export type AndroidStockProfileChoice = {
  /** What the button says. */
  label: string;
  profile: AndroidHardwareProfile;
};

/**
 * The short "New device" list: a phone, a small phone, a tablet and a
 * foldable, from the profiles this SDK has. The ids are the SDK's stock ones;
 * a form factor stands in when an SDK names them differently. The brand grid
 * (plan §7.1, P1) replaces this list.
 */
export function androidStockProfiles(profiles: readonly AndroidHardwareProfile[]): AndroidStockProfileChoice[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  const used = new Set<string>();
  const pick = (ids: string[], formFactor: string | null, test?: (profile: AndroidHardwareProfile) => boolean) => {
    for (const id of ids) {
      const profile = byId.get(id);
      if (profile && !used.has(profile.id)) return profile;
    }
    return profiles.find((profile) => !used.has(profile.id)
      && (formFactor == null || profile.formFactor === formFactor)
      && (test ? test(profile) : true)) ?? null;
  };
  const choices: AndroidStockProfileChoice[] = [];
  const add = (label: string, profile: AndroidHardwareProfile | null) => {
    if (!profile) return;
    used.add(profile.id);
    choices.push({ label, profile });
  };
  add("Phone", pick(["medium_phone"], "phone"));
  add("Small phone", pick(["small_phone"], "phone", (profile) => (profile.screenInches ?? 99) < 6));
  add("Tablet", pick(["medium_tablet", "pixel_tablet"], "tablet"));
  add("Foldable", pick(["pixel_9_pro_fold", "pixel_fold"], "foldable", undefined)
    ?? pick([], null, (profile) => /fold/i.test(profile.id)));
  return choices;
}

/** Phones, tablets and foldables first in "More…"; watch, TV and car profiles after them. */
export function androidProfileGroup(profile: AndroidHardwareProfile): string {
  switch (profile.formFactor) {
    case "phone":
      return "Phone";
    case "tablet":
      return "Tablet";
    case "foldable":
      return "Foldable";
    case "wear":
      return "Wear OS";
    case "tv":
      return "TV";
    case "automotive":
      return "Car";
    case "desktop":
      return "Desktop";
    default:
      return "Other";
  }
}

/** The ⋯ menu's verbs for one AVD card, from what the lane and the brain allow. */
export function androidAvdMenuActions(avd: AndroidAvdListing, laneId: string | null): {
  release: boolean;
  delete: boolean;
} {
  return {
    release: Boolean(laneId) && avd.heldByLaneId === laneId,
    // The brain deletes only an ADE-made AVD that no lane holds and that is off,
    // and never one ADE made for a lane outside this project.
    delete: avd.adeCreated && !avd.madeForOtherLane && !avd.heldByLaneId && !avd.running,
  };
}

/** The text a key event types on the device, or null when it types none. */
export function androidKeyText(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): string | null {
  if (event.metaKey || event.ctrlKey) return null;
  if (event.key === "Enter") return "\n";
  // One printable character; named keys ("Shift", "ArrowUp") are longer.
  if (event.key.length === 1) return event.key;
  return null;
}

/* ── Errors ─────────────────────────────────────────────────────────────── */

export type AndroidErrorDescription = {
  /** One short sentence for the strip. */
  sentence: string;
  /** The wire text, behind `Details`. Null when it adds nothing. */
  detail: string | null;
  code: AndroidEmulatorErrorCode | null;
};

const ANDROID_ERROR_SENTENCE: Record<AndroidEmulatorErrorCode, string> = {
  ANDROID_SDK_NOT_FOUND: "No Android SDK was found on this machine.",
  ANDROID_TOOL_MISSING: "A part of the Android SDK is missing.",
  ANDROID_NO_ACCELERATION: "This machine has no emulator acceleration.",
  ANDROID_NO_SYSTEM_IMAGE: "No phone image is installed.",
  ANDROID_AVD_NOT_FOUND: "That Android device is not on this machine any more.",
  ANDROID_AVD_HELD_BY_OTHER_LANE: "Another lane holds that device.",
  ANDROID_LANE_HAS_DEVICE: "This lane already holds a device.",
  ANDROID_AVD_RUNNING: "That device is already running somewhere else.",
  ANDROID_NO_FREE_PORT: "No free emulator port is left on this machine.",
  ANDROID_BOOT_TIMEOUT: "The device did not finish booting in time.",
  ANDROID_EMULATOR_EXITED: "The emulator stopped.",
  ANDROID_STREAM_FAILED: "The live view could not start.",
  ANDROID_NOT_RUNNING: "The device is not running.",
  ANDROID_PATH_OUTSIDE_LANE: "That file path is outside this lane's folder.",
};

const IPC_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/;

function errorText(error: unknown): string {
  if (error == null) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message;
  }
  return String(error);
}

function errorCode(error: unknown, text: string): AndroidEmulatorErrorCode | null {
  const own = error && typeof error === "object" && "code" in error ? (error as { code?: unknown }).code : null;
  if (typeof own === "string" && (ANDROID_EMULATOR_ERROR_CODES as readonly string[]).includes(own)) {
    return own as AndroidEmulatorErrorCode;
  }
  // A code that crossed IPC or the runtime socket survives only in the text.
  return ANDROID_EMULATOR_ERROR_CODES.find((code) => text.includes(code)) ?? null;
}

/**
 * Any failure the pane meets, as one sentence and the raw text. A brain
 * `AndroidEmulatorError` carries its own plain sentence and a code; anything
 * else keeps its first line.
 */
export function describeAndroidError(error: unknown): AndroidErrorDescription {
  const raw = errorText(error).replace(IPC_PREFIX, "").trim();
  const code = errorCode(error, raw);
  if (/Project is switching/i.test(raw)) {
    return { sentence: "ADE was switching projects. Try again.", detail: null, code };
  }
  // The brain's message is already one plain sentence for the panel; the code
  // in front of it (when it crossed a socket) is not for reading.
  const own = (code ? raw.replace(new RegExp(`^(?:[A-Za-z]*Error:\\s*)?${code}:?\\s*`), "") : raw).trim();
  const firstLine = own.split("\n")[0]?.trim() ?? "";
  const readable = firstLine.length > 0 && firstLine.length <= 140 && !/^[A-Z_]+$/.test(firstLine);
  const sentence = readable
    ? firstLine
    : code
      ? ANDROID_ERROR_SENTENCE[code]
      : "Something went wrong with the Android emulator.";
  const detail = raw && raw !== sentence ? raw : null;
  return { sentence, detail, code };
}
