import { useEffect, useState } from "react";
import { globalVoiceModelInstaller } from "../services/globalVoiceModelInstaller";

/**
 * Whether the on-device voice transcription model is installed.
 * Returns `null` until known, then `true`/`false`. The transcription bridge is
 * absent in non-Electron / test surfaces, which is treated as not installed.
 *
 * Backed by the app-global installer singleton (the same source the Settings
 * download drives), so when a download completes the mic flips live — no app
 * restart. Pass `enabled = false` to skip the probe (e.g. while voice input is
 * disabled).
 */
export function useVoiceModelInstalled(enabled = true): boolean | null {
  const [state, setState] = useState(() => globalVoiceModelInstaller.getState());
  useEffect(() => {
    // Disabled → this hook returns null below, so subscribing would only churn
    // setState for a value we discard. Gate the whole effect on `enabled` (the
    // sibling useVoiceModelInstall subscribes unconditionally because it always
    // surfaces live phase/progress, even while disabled).
    if (!enabled) return;
    const unsubscribe = globalVoiceModelInstaller.subscribe(setState);
    // Sync immediately in case state changed between render and subscribe.
    setState(globalVoiceModelInstaller.getState());
    void globalVoiceModelInstaller.refresh();
    return unsubscribe;
  }, [enabled]);

  if (!enabled || !state.probed) return null;
  return state.binaryInstalled && state.modelInstalled;
}
