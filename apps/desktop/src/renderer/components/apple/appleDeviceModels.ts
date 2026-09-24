import iphone18ProUrl from "../../assets/apple-device-models/iphone-18-pro.glb?url";
import iphone18ProMaxUrl from "../../assets/apple-device-models/iphone-18-pro-max.glb?url";
import ipadPro13M5Url from "../../assets/apple-device-models/ipad-pro-13-m5.glb?url";

export type AppleDeviceModelId = "iphone-18-pro" | "iphone-18-pro-max" | "ipad-pro-13-m5";

export type AppleDeviceModelFamily = "iphone" | "ipad";

export type AppleDeviceModelSource = {
  id: AppleDeviceModelId;
  url: string;
  screenNodeNames: readonly string[];
};

const MODELS: Record<AppleDeviceModelId, AppleDeviceModelSource> = {
  "iphone-18-pro": {
    id: "iphone-18-pro",
    url: iphone18ProUrl,
    screenNodeNames: ["device-screen", "EHjrGDHNHzgNjtE.001"],
  },
  "iphone-18-pro-max": {
    id: "iphone-18-pro-max",
    url: iphone18ProMaxUrl,
    screenNodeNames: ["device-screen", "EHjrGDHNHzgNjtE"],
  },
  "ipad-pro-13-m5": {
    id: "ipad-pro-13-m5",
    url: ipadPro13M5Url,
    screenNodeNames: ["device-screen", "lsDiIbtoSGSmWWZ"],
  },
};

/**
 * Is this an iPhone Pro Max?
 *
 * Reads the device-type IDENTIFIER first and the display name second, the same
 * precedence `appleDeviceFamily` uses, and for the same reason: a simulator's
 * name is whatever a person typed. ADE names its clones after the lane, so a
 * real Pro Max cloned into a lane is called something like "apple sim preview"
 * and matched nothing — every Pro Max rendered on the smaller Pro body. The
 * reverse also bit: a device someone named "Pro Max test" got the Max body
 * whatever it actually was.
 *
 * The identifier is Apple's own and unambiguous:
 * `com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max`.
 */
function isIphoneProMax(hint: AppleDeviceModelHint): boolean {
  const identifier = hint.deviceTypeIdentifier?.trim();
  if (identifier) return /pro-?\s*max/i.test(identifier);
  return /pro\s*max/i.test(hint.deviceTypeName ?? "");
}

/**
 * What the model map is allowed to read.
 *
 * A named pair rather than two loose strings, because the whole bug was a
 * caller passing a name into a parameter that meant type.
 */
export type AppleDeviceModelHint = {
  /** `com.apple.CoreSimulator.SimDeviceType.…`, when the device is known. */
  deviceTypeIdentifier?: string | null;
  /** The display name. A fallback only — a person chose it. */
  deviceTypeName?: string | null;
};

/** Closest bundled body for a simulator product name. Always returns a model for iPhone/iPad. */
export function resolveAppleDeviceModelId(
  family: AppleDeviceModelFamily,
  hint: AppleDeviceModelHint,
): AppleDeviceModelId {
  switch (family) {
    case "ipad":
      return "ipad-pro-13-m5";
    case "iphone":
      return isIphoneProMax(hint) ? "iphone-18-pro-max" : "iphone-18-pro";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

export function appleDeviceModel(
  family: AppleDeviceModelFamily,
  hint: AppleDeviceModelHint,
): AppleDeviceModelSource {
  return MODELS[resolveAppleDeviceModelId(family, hint)];
}

export function appleDeviceModelById(id: AppleDeviceModelId): AppleDeviceModelSource {
  return MODELS[id];
}
