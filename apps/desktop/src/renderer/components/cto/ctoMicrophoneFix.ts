import type { CtoVoiceMicrophoneBlockKind } from "../../../shared/types/ctoVoice";
import type { SystemSettingsPaneId } from "../../../shared/types/systemSettings";
import { rendererRuntimeTarget } from "../../lib/platform";

/**
 * The one place that turns a microphone refusal into a button.
 *
 * It used to live inside the start sheet, and so did the button — which is why
 * an owner with no microphone saw the sentence and nothing to press. The sheet
 * closes the moment the call goes live, and the microphone verdict arrives
 * AFTER that (capture is opened by the HUD host once the call is up), so the
 * failure was routinely shown by the page notice instead, which had a sentence
 * and no fix. A failure that names a settings pane has to carry the button to
 * every surface that can show it, so the mapping lives here and both do.
 */

export type CtoMicrophoneSettingsAction = {
  label: string;
  paneId: SystemSettingsPaneId;
};

/**
 * The pane that can actually fix this cause, and what the button should say.
 *
 * Permission and hardware are different problems in different panes: a machine
 * with no microphone needs the one that lists INPUTS, not the one that lists
 * apps, and sending it to the permission pane is how "ADE is already allowed"
 * becomes a dead end.
 *
 * Null on Linux, and null for `in-use`: there is no vetted URL for a Linux
 * sound pane, and no pane at all fixes another app holding the device. A
 * button that opens nothing is worse than no button.
 */
export function ctoMicrophoneSettingsAction(
  kind: CtoVoiceMicrophoneBlockKind | null,
  platform: string = rendererRuntimeTarget().platform,
): CtoMicrophoneSettingsAction | null {
  if (!kind) return null;
  const windows = platform === "win32";
  if (!windows && platform !== "darwin") return null;
  if (kind === "in-use") return null;
  if (kind === "no-device" || kind === "unavailable") {
    return {
      label: "Open sound settings",
      paneId: windows ? "windows-sound" : "macos-sound-input",
    };
  }
  return {
    label: "Open microphone settings",
    paneId: windows ? "windows-microphone" : "macos-microphone",
  };
}

/**
 * Open an OS pane by id, never by URL.
 *
 * `x-apple.systempreferences:` and `ms-settings:` are deliberately outside the
 * external-URL scheme allowlist, so main resolves a small enum against a vetted
 * table instead of the renderer handing it a string. See
 * `shared/types/systemSettings.ts`.
 */
export async function openCtoSettingsPane(paneId: SystemSettingsPaneId): Promise<void> {
  const open = window.ade?.app?.openSystemSettingsPane;
  if (!open) return;
  try {
    await open(paneId);
  } catch {
    // A pane that will not open is not worth a second failure on top of the
    // one already on screen.
  }
}
