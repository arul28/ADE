import { useEffect, useState } from "react";
import { rootAppStoreApi, useRootAppStore } from "../../state/appStore";

/**
 * Whether to say once more, beside a Mac's first stop, what a stop keeps.
 * Shown the first time a stopped Mac is on screen (the chat header's menu,
 * Settings' row), then never again on any machine (a synced account setting).
 * It stays for the view that showed it, so it never vanishes as it is read.
 */
export function useCloudMacFirstStopLine(stoppedMacShown: boolean): boolean {
  const seen = useRootAppStore((state) => state.cloudMacStopSeen);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (!stoppedMacShown || seen) return;
    setLatched(true);
    rootAppStoreApi.getState().setCloudMacStopSeen(true);
  }, [seen, stoppedMacShown]);
  return latched || (stoppedMacShown && !seen);
}
