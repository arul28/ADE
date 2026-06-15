import { useEffect, useState } from "react";

/**
 * Probe whether the on-device voice transcription model is installed.
 * Returns `null` until known, then `true`/`false`. The transcription bridge is
 * absent in non-Electron / test surfaces, which is treated as not installed.
 *
 * Pass `enabled = false` to skip the probe (e.g. while voice input is disabled).
 */
export function useVoiceModelInstalled(enabled = true): boolean | null {
  const [installed, setInstalled] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const status = window.ade?.transcription?.status;
    if (!status) {
      setInstalled(false);
      return;
    }
    let cancelled = false;
    status()
      .then((result) => {
        if (!cancelled) setInstalled(result.installed);
      })
      .catch(() => {
        if (!cancelled) setInstalled(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return installed;
}
