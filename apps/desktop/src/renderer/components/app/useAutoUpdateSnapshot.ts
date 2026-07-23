import { useEffect, useState } from "react";
import type { AutoUpdateSnapshot } from "../../../shared/types";

/** Neutral steady-state snapshot before the first main-process read lands. */
export const EMPTY_AUTO_UPDATE_SNAPSHOT: AutoUpdateSnapshot = {
  status: "idle",
  currentVersion: "",
  latestKnownVersion: null,
  version: null,
  progressPercent: null,
  bytesPerSecond: null,
  transferredBytes: null,
  totalBytes: null,
  releaseNotesUrl: null,
  error: null,
  errorDetails: null,
  recentlyInstalled: null,
  parked: null,
  autoApplyPending: null,
  autoApplySuppressedUntil: null,
};

/**
 * Subscribes to the auto-update snapshot (initial read + live events). Shared by
 * every truthful-version surface (top-bar pill, app-shell banner, About panel)
 * so they never disagree about what is running versus what is staged.
 */
export function useAutoUpdateSnapshot(): AutoUpdateSnapshot {
  const [snapshot, setSnapshot] = useState<AutoUpdateSnapshot>(EMPTY_AUTO_UPDATE_SNAPSHOT);

  useEffect(() => {
    let cancelled = false;

    void window.ade.updateGetState()
      .then((next) => {
        if (!cancelled) setSnapshot(next);
      })
      .catch(() => {
        // Best effort only; live events will fill in.
      });

    const unsubscribe = window.ade.onUpdateEvent((next) => {
      if (!cancelled) setSnapshot(next);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return snapshot;
}
