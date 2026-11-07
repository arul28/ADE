import { useCallback, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidEmulatorPreloadApi } from "../../../shared/types/androidEmulator";
import { showToast } from "../app/toast/toastStore";

/**
 * The rail's Screenshot and Play Store screenshots buttons. Both run on the
 * lane's machine (the pin), and a toast says what was saved. Play Store
 * screenshots are filed under the pane's chat.
 */
export function useAndroidScreenCaptures({
  api,
  laneId,
  chatSessionId,
  runtimePinRef,
  onError,
}: {
  api: AndroidEmulatorPreloadApi | null;
  laneId: string;
  chatSessionId: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (caught: unknown) => void;
}) {
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [storeShotsPending, setStoreShotsPending] = useState(false);

  const storeScreenshots = useCallback(() => {
    if (!api) return;
    setStoreShotsPending(true);
    void api.storeScreenshots({ laneId, chatSessionId }, runtimePinRef.current)
      .then((result) => showToast({
        id: "android-store-shots",
        tone: "success",
        title: result.shots.length === 1 ? "Play Store screenshot saved" : `${result.shots.length} Play Store screenshots saved`,
        message: result.shots.map((shot) => `${shot.display === "screen" ? shot.slot : `${shot.display} screen`} ${shot.width}×${shot.height}`).join(" · "),
      }))
      .catch(onError)
      .finally(() => setStoreShotsPending(false));
  }, [api, chatSessionId, laneId, onError, runtimePinRef]);

  const screenshot = useCallback(() => {
    if (!api) return;
    setScreenshotPending(true);
    void api.screenshot({ laneId }, runtimePinRef.current)
      .then((shot) => showToast({
        id: "android-screenshot",
        tone: "success",
        title: "Screenshot saved",
        message: `${shot.width}×${shot.height} · ${shot.path}`,
      }))
      .catch(onError)
      .finally(() => setScreenshotPending(false));
  }, [api, laneId, onError, runtimePinRef]);

  return { screenshot, screenshotPending, storeScreenshots, storeShotsPending };
}
