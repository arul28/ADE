import { useEffect, useState } from "react";
import {
  globalVoiceModelInstaller,
  type VoiceModelInstallState,
} from "../services/globalVoiceModelInstaller";

export type UseVoiceModelInstall = VoiceModelInstallState & {
  /** Begin (or join) the background model download. */
  start: () => void;
  /** Re-probe install state from the main process. */
  refresh: () => void;
};

/**
 * Subscribe to the app-global voice-model install state. The underlying download
 * runs in the main process and the installer singleton lives at module scope, so
 * progress and completion survive this component (or the whole Settings page)
 * unmounting mid-download.
 *
 * Pass `enabled = false` to skip the initial status probe (e.g. while voice input
 * is disabled).
 */
export function useVoiceModelInstall(enabled = true): UseVoiceModelInstall {
  const [state, setState] = useState<VoiceModelInstallState>(() =>
    globalVoiceModelInstaller.getState(),
  );

  useEffect(() => {
    const unsubscribe = globalVoiceModelInstaller.subscribe(setState);
    // Sync immediately in case state changed between render and subscribe.
    setState(globalVoiceModelInstaller.getState());
    if (enabled) void globalVoiceModelInstaller.refresh();
    return unsubscribe;
  }, [enabled]);

  return {
    ...state,
    start: () => void globalVoiceModelInstaller.start(),
    refresh: () => void globalVoiceModelInstaller.refresh(),
  };
}
