import { useCallback, useEffect, useRef, useState } from "react";
import type { IosSimulatorLaunchProgress } from "../../../shared/types/iosSimulator";

/** Where a remembered build duration lives, keyed by build root. */
const BUILD_MEMORY_PREFIX = "ade.iosSimulator.buildMs:";

/**
 * Owns the remembered duration of the last Xcode build of a build root.
 *
 * A cold build runs for minutes with no progress bar and no ceiling a reader
 * can see, so the launch stepper looks stuck. The previous duration for the
 * same root is the only honest reassurance available, and `localStorage` is
 * where it belongs: it describes this machine's view of that root, not a fact
 * about the project worth writing to the database.
 *
 * This sits outside the simulator drawer because it reads no device, no
 * session, and no stream. It is bookkeeping about a directory, so the drawer
 * carried it only by accident of where the stepper is rendered.
 */
export function useIosSimBuildDuration({
  launchProgress,
  buildRoot,
  projectRoot,
}: {
  launchProgress: IosSimulatorLaunchProgress[];
  buildRoot: string | null;
  projectRoot: string | null;
}): number | null {
  const buildTimingRef = useRef<{ launchId: string; startedAtMs: number } | null>(null);
  const [lastBuildMs, setLastBuildMs] = useState<number | null>(null);

  const buildMemoryKey = useCallback((root: string | null | undefined): string | null => (
    root?.trim() ? `${BUILD_MEMORY_PREFIX}${root.trim()}` : null
  ), []);

  useEffect(() => {
    const key = buildMemoryKey(buildRoot ?? projectRoot);
    if (!key) return;
    try {
      const stored = Number(window.localStorage.getItem(key));
      setLastBuildMs(Number.isFinite(stored) && stored > 0 ? stored : null);
    } catch {
      // Private mode and a disabled store both throw. The stepper simply omits
      // the hint rather than failing the launch it decorates.
      setLastBuildMs(null);
    }
  }, [buildMemoryKey, buildRoot, projectRoot]);

  useEffect(() => {
    for (const step of launchProgress) {
      if (step.step !== "build-app") continue;
      const at = Date.parse(step.updatedAt);
      if (!Number.isFinite(at)) continue;
      if (step.status === "running") {
        buildTimingRef.current = { launchId: step.launchId, startedAtMs: at };
        continue;
      }
      if (step.status !== "complete") continue;
      const started = buildTimingRef.current;
      if (!started || started.launchId !== step.launchId) continue;
      buildTimingRef.current = null;
      const durationMs = at - started.startedAtMs;
      // A build that finished in under a second did not build anything. Storing
      // it would turn the hint into a lie on the next cold build.
      if (durationMs < 1_000) continue;
      setLastBuildMs(durationMs);
      const key = buildMemoryKey(step.buildRoot ?? buildRoot ?? projectRoot);
      if (!key) continue;
      try {
        window.localStorage.setItem(key, String(durationMs));
      } catch {
        // See above: a write that cannot happen costs the hint, nothing else.
      }
    }
  }, [buildMemoryKey, buildRoot, launchProgress, projectRoot]);

  return lastBuildMs;
}
