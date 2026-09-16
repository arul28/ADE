import type { CtoVoiceMicrophoneBlockKind } from "../../../shared/types/ctoVoice";

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

export type MicrophoneAccessOptions = {
  /**
   * Whether this is a signed, installed build.
   *
   * Injected rather than read from `app` so the classification is testable, and
   * because it changes the ANSWER and not just the wording: an unpackaged
   * macOS build has no TCC identity, so a refusal there is not something the
   * user can grant. Telling them to allow ADE in System Settings when the entry
   * they are looking at belongs to a different binary is the failure this
   * distinction exists to stop.
   */
  isPackaged: boolean;
};

export type MicrophoneAccessResult = {
  status: MicrophoneAccessStatus;
  /** Null when access was granted. The reason a caller can act on otherwise. */
  block: CtoVoiceMicrophoneBlockKind | null;
};

/**
 * Ask the OS for the microphone, and say what kind of no it was.
 *
 * `not-determined` is the one status worth acting on: it means nobody has been
 * asked yet, so this is where the real OS prompt comes from. Everything else is
 * a settled answer, and the only question left is whether the user can change
 * it — which is exactly what `isPackaged` decides on macOS.
 */
export async function requestMicrophoneAccess(
  platform: NodeJS.Platform,
  preferences: SystemMediaPreferences,
  options: MicrophoneAccessOptions = { isPackaged: true },
): Promise<MicrophoneAccessResult> {
  if (platform === "win32") {
    try {
      const status = preferences.getMediaAccessStatus("microphone");
      // Windows exposes only the global Win32 privacy policy here. Treat
      // definitive OS denials as blocking; Chromium/getUserMedia owns any
      // per-origin prompt when Electron cannot determine that policy.
      //
      // Deliberately NOT classified as `dev-build` when unpackaged: that switch
      // is one global toggle covering every desktop app, an unsigned Electron
      // included, so the settings pane really is the fix and "start it from a
      // terminal" would be false advice.
      if (status === "denied" || status === "restricted") {
        return { status, block: "os-denied" };
      }
      return { status: "granted", block: null };
    } catch {
      return { status: "granted", block: null };
    }
  }

  if (platform !== "darwin") {
    return { status: "granted", block: null };
  }

  /** A settled macOS refusal, attributed to whoever can actually undo it. */
  const refused = (status: MicrophoneAccessStatus): MicrophoneAccessResult => ({
    status,
    block: options.isPackaged ? "os-denied" : "dev-build",
  });

  const current = preferences.getMediaAccessStatus("microphone");
  if (current === "granted") {
    return { status: "granted", block: null };
  }
  if (current === "not-determined") {
    try {
      // The only call that can raise the real OS prompt. On a packaged build it
      // does; on an unsigned one it returns false without showing anything,
      // which is the whole reason the answer below is attributed differently.
      const granted = await preferences.askForMediaAccess("microphone");
      return granted ? { status: "granted", block: null } : refused("denied");
    } catch {
      return refused("denied");
    }
  }
  return refused(current);
}
