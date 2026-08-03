import { isCursorProviderSupported } from "../../shared/providerPlatformSupport";

function getPlatformValue(): string {
  if (typeof navigator !== "undefined" && typeof navigator.platform === "string") {
    return navigator.platform;
  }
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform;
  }
  return "";
}

/**
 * Host platform/arch as captured by preload. `navigator.platform` cannot answer
 * this — Chromium reports "Win32" on Windows on ARM as well — so anything that
 * has to distinguish win32-x64 from win32-arm64 reads the bridge instead.
 * Falls back to the browser-mock/dev default when the bridge is absent.
 */
export function rendererRuntimeTarget(): { platform: string; arch: string } {
  const bridged = typeof window !== "undefined"
    ? (window as { ade?: { app?: { runtimeTarget?: { platform?: unknown; arch?: unknown } } } }).ade
      ?.app?.runtimeTarget
    : undefined;
  const platform = typeof bridged?.platform === "string" && bridged.platform
    ? bridged.platform
    : rendererPlatformAttribute();
  const arch = typeof bridged?.arch === "string" && bridged.arch ? bridged.arch : "x64";
  return { platform, arch };
}

/**
 * False only on Windows on ARM, where `@cursor/sdk` has no build — the Cursor
 * provider is hidden there rather than shown broken. See
 * shared/providerPlatformSupport.ts. Deliberately a function, not a module-scope
 * const: the preload bridge must exist before it is read.
 */
export function cursorProviderAvailable(): boolean {
  const { platform, arch } = rendererRuntimeTarget();
  return isCursorProviderSupported(platform, arch);
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
