import { rendererPlatformAttribute } from "../../lib/platform";
import { BRAND } from "../../../shared/brand";

export function microphonePermissionGuidance(
  platform = rendererPlatformAttribute(),
): string {
  if (platform === "win32") {
    return `Microphone access is off for ${BRAND.NAME}. Open Settings → Privacy & security → Microphone, then turn on Microphone access and Let desktop apps access your microphone.`;
  }
  if (platform === "darwin") {
    return `Microphone access is off for ${BRAND.NAME}. Turn it on in System Settings → Privacy & Security → Microphone, then try again.`;
  }
  return `Microphone access is off for ${BRAND.NAME}. Allow microphone access in your system settings, then try again.`;
}
