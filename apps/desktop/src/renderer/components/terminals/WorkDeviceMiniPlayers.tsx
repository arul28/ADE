import { lazy, Suspense, type ComponentProps } from "react";
import type { AppleDeviceMiniPlayer as AppleDeviceMiniPlayerView } from "../apple/AppleDeviceMiniPlayer";
import type { AndroidDeviceMiniPlayer as AndroidDeviceMiniPlayerView } from "../android/AndroidDeviceMiniPlayer";
import { useAppleMiniPlayerTarget } from "../apple/appleMiniPlayerStore";
import { useAndroidMiniPlayerTarget } from "../android/androidMiniPlayerStore";

/*
 * The floating Apple and Android devices of the Work page.
 *
 * A player exists only after the person floats a device, and the stores do not
 * keep a floated device across a launch. So the player code (the device stage,
 * its stream and its 3D model, which bring three.js) loads the first time a
 * device floats, not with the Work page. The stores are small and stay static:
 * with no floated device these hosts render nothing, as the players did.
 */

const LazyAppleDeviceMiniPlayer = lazy(() =>
  import("../apple/AppleDeviceMiniPlayer").then((m) => ({ default: m.AppleDeviceMiniPlayer })),
);
const LazyAndroidDeviceMiniPlayer = lazy(() =>
  import("../android/AndroidDeviceMiniPlayer").then((m) => ({ default: m.AndroidDeviceMiniPlayer })),
);

export function AppleDeviceMiniPlayer(props: ComponentProps<typeof AppleDeviceMiniPlayerView>) {
  const target = useAppleMiniPlayerTarget();
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <LazyAppleDeviceMiniPlayer {...props} />
    </Suspense>
  );
}

export function AndroidDeviceMiniPlayer(props: ComponentProps<typeof AndroidDeviceMiniPlayerView>) {
  const target = useAndroidMiniPlayerTarget();
  if (!target) return null;
  return (
    <Suspense fallback={null}>
      <LazyAndroidDeviceMiniPlayer {...props} />
    </Suspense>
  );
}
