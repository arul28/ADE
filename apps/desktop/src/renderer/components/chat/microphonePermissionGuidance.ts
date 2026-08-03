import { rendererPlatformAttribute } from "../../lib/platform";

export function microphonePermissionGuidance(
  platform = rendererPlatformAttribute(),
): string {
  if (platform === "win32") {
    return "Microphone access is off for ADE. Open Settings → Privacy & security → Microphone, then turn on Microphone access and Let desktop apps access your microphone.";
  }
  if (platform === "darwin") {
    return "Microphone access is off for ADE. Turn it on in System Settings → Privacy & Security → Microphone, then try again.";
  }
  return "Microphone access is off for ADE. Allow microphone access in your system settings, then try again.";
}
