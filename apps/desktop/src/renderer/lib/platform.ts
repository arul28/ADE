function getPlatformValue(): string {
  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return navigator.platform;
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  return "";
}

export function isMacPlatform(platformValue = getPlatformValue()): boolean {
  return /mac|darwin/i.test(platformValue);
}

export function rendererPlatformAttribute(
  platformValue = getPlatformValue(),
): "darwin" | "win32" | "linux" | "unknown" {
  if (isMacPlatform(platformValue)) return "darwin";
  if (/win/i.test(platformValue)) return "win32";
  if (/linux/i.test(platformValue)) return "linux";
  return "unknown";
}

export function supportsNativeNotchPlatform(platformValue = getPlatformValue()): boolean {
  return isMacPlatform(platformValue);
}

export function supportsIosSimulatorPlatform(platformValue = getPlatformValue()): boolean {
  return isMacPlatform(platformValue);
}

export const isMac = isMacPlatform();
export const supportsNativeNotch = supportsNativeNotchPlatform();
const rendererPlatform = rendererPlatformAttribute();
export const revealLabel = isMac
  ? "Reveal in Finder"
  : rendererPlatform === "win32"
    ? "Reveal in File Explorer"
    : "Reveal in file manager";
export const modifierKeyLabel = isMac ? "Cmd" : "Ctrl";
