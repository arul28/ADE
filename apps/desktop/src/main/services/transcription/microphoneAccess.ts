export type MicrophoneAccessStatus =
  | "granted"
  | "denied"
  | "not-determined"
  | "restricted"
  | "unknown";

type SystemMediaPreferences = {
  getMediaAccessStatus: (mediaType: "microphone") => MicrophoneAccessStatus;
  askForMediaAccess: (mediaType: "microphone") => Promise<boolean>;
};

export async function requestMicrophoneAccess(
  platform: NodeJS.Platform,
  preferences: SystemMediaPreferences,
): Promise<{ status: MicrophoneAccessStatus }> {
  if (platform === "win32") {
    try {
      const status = preferences.getMediaAccessStatus("microphone");
      // Windows exposes only the global Win32 privacy policy here. Treat
      // definitive OS denials as blocking; Chromium/getUserMedia owns any
      // per-origin prompt when Electron cannot determine that policy.
      return { status: status === "denied" || status === "restricted" ? status : "granted" };
    } catch {
      return { status: "granted" };
    }
  }

  if (platform !== "darwin") {
    return { status: "granted" };
  }

  const current = preferences.getMediaAccessStatus("microphone");
  if (current === "granted") {
    return { status: "granted" };
  }
  if (current === "not-determined") {
    try {
      const granted = await preferences.askForMediaAccess("microphone");
      return { status: granted ? "granted" : "denied" };
    } catch {
      return { status: "denied" };
    }
  }
  return { status: current };
}
