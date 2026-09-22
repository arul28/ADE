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

function isIphoneProMaxName(name: string | null): boolean {
  if (!name) return false;
  return /pro\s*max/i.test(name);
}

/** Closest bundled body for a simulator product name. Always returns a model for iPhone/iPad. */
export function resolveAppleDeviceModelId(
  family: AppleDeviceModelFamily,
  deviceTypeName: string | null,
): AppleDeviceModelId {
  switch (family) {
    case "ipad":
      return "ipad-pro-13-m5";
    case "iphone":
      return isIphoneProMaxName(deviceTypeName) ? "iphone-18-pro-max" : "iphone-18-pro";
    default: {
      const _exhaustive: never = family;
      return _exhaustive;
    }
  }
}

export function appleDeviceModel(
  family: AppleDeviceModelFamily,
  deviceTypeName: string | null,
): AppleDeviceModelSource {
  return MODELS[resolveAppleDeviceModelId(family, deviceTypeName)];
}

export function appleDeviceModelById(id: AppleDeviceModelId): AppleDeviceModelSource {
  return MODELS[id];
}
