import {
  APPLE_DEVICE_ORIENTATIONS,
  APPLE_DUO_COVER_SCREEN_ID,
  APPLE_DUO_INNER_SCREEN_ID,
  type AppleDeviceOrientation,
  type AppleDevicePosture,
} from "./types/iosSimulator";

/**
 * Orientation facts shared by the simulator service and the Apple pane, so
 * the two never encode them twice: the axis of an orientation, and the
 * iPhone Duo's translations between how the phone is held, how CoreDevice
 * names that, and how each panel's picture sits.
 */

export function isAppleDeviceOrientation(value: string): value is AppleDeviceOrientation {
  return (APPLE_DEVICE_ORIENTATIONS as readonly string[]).includes(value);
}

/**
 * Portrait and upside-down are one axis; the two landscapes are the other.
 * A 180-degree turn inside one axis keeps the pixel geometry, so the axis is
 * all a framebuffer can tell.
 */
export function appleOrientationFamily(orientation: AppleDeviceOrientation): "portrait" | "landscape" {
  return orientation === "landscape-left" || orientation === "landscape-right" ? "landscape" : "portrait";
}

/** The Duo's live panel by name; null for any other screen id. */
export type AppleDuoScreen = "cover" | "inner";

export function appleDuoScreenName(screenId: number | null | undefined): AppleDuoScreen | null {
  if (screenId === APPLE_DUO_COVER_SCREEN_ID) return "cover";
  if (screenId === APPLE_DUO_INNER_SCREEN_ID) return "inner";
  return null;
}

/**
 * The inner panel's picture, a quarter turn on from how the phone is held: the
 * panel is mounted that way, so holding the phone upright runs its picture
 * wide. The cover follows the phone.
 */
const APPLE_DUO_INNER_ORIENTATION: Record<AppleDeviceOrientation, AppleDeviceOrientation> = {
  portrait: "landscape-left",
  "landscape-left": "portrait-upside-down",
  "portrait-upside-down": "landscape-right",
  "landscape-right": "portrait",
};

/** How the live panel's picture sits when the phone is held at `held`. */
export function appleDuoPanelOrientation(held: AppleDeviceOrientation, innerLive: boolean): AppleDeviceOrientation {
  return innerLive ? APPLE_DUO_INNER_ORIENTATION[held] : held;
}

/**
 * The pose CoreDevice reports for each orientation ADE asks for. ADE names
 * the interface's orientation and CoreDevice the device's, so the two
 * landscapes swap between them (a phone turned landscape-left shows its
 * interface landscape-right).
 */
const APPLE_DUO_PHYSICAL_ORIENTATION: Record<AppleDeviceOrientation, string> = {
  portrait: "portrait",
  "portrait-upside-down": "pud",
  "landscape-left": "landscape-right",
  "landscape-right": "landscape-left",
};

export function appleDuoPhysicalOrientation(orientation: AppleDeviceOrientation): string {
  return APPLE_DUO_PHYSICAL_ORIENTATION[orientation];
}

/**
 * How a Duo is held, in ADE's terms. Null when the simulator has not said,
 * or the phone lies face down or up.
 */
export function appleDuoHeldOrientation(posture: AppleDevicePosture | null | undefined): AppleDeviceOrientation | null {
  if (!posture?.supported || !posture.orientation) return null;
  return APPLE_DEVICE_ORIENTATIONS.find((orientation) => APPLE_DUO_PHYSICAL_ORIENTATION[orientation] === posture.orientation) ?? null;
}

/**
 * Tent's Table Mode. A helper that did not set it only sees the phone lie
 * face down, which nothing but Tent does (ADE stands the phone up for any
 * other fold).
 */
export function appleDuoInTent(posture: AppleDevicePosture | null | undefined): boolean {
  return Boolean(posture?.supported && (posture.tableMode === true || posture.orientation === "facedown"));
}
