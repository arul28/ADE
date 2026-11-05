import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidPosture } from "../../../shared/types/androidEmulator";
import { logRendererDebugEvent } from "../../lib/debugLog";
import type { AndroidStageFold } from "./AndroidDeviceStage";

/**
 * The hinge of the lane's foldable emulator (P3 fold), as the Duo's
 * `useAppleDuoPosture` does for the iPhone Duo.
 *
 * One read when the device goes live (read again twice if it fails), then the
 * brain's `android.device.posture` events: an agent or another viewer can
 * fold it at any time. A drag on the hinge previews the angle on the 3D body
 * only; the release folds the emulator, and the drawn angle holds there until
 * Android answers.
 */
/** The waits before a second and a third read when the first fails (a slow console just after boot). */
const POSTURE_READ_RETRIES_MS = [2_000, 6_000] as const;

export function useAndroidPosture({
  laneId,
  enabled,
  runtimePinRef,
  onError,
}: {
  laneId: string;
  /** A foldable whose emulator is booted. */
  enabled: boolean;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (cause: unknown) => void;
}): {
  /** What the emulator last reported; null before the first read or on a device with no hinge. */
  posture: AndroidPosture | null;
  /** The angle to draw: the drag's, then the one sent, then the reported one. */
  angle: number;
  busy: boolean;
  preview: (angle: number) => void;
  commit: (angle: number) => void;
  /** The stage's `fold`: set once the emulator reports a hinge. */
  stageFold: AndroidStageFold | null;
} {
  const [posture, setPosture] = useState<AndroidPosture | null>(null);
  const [previewAngle, setPreviewAngle] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  /** Each commit's number: an answer to an older one never overwrites a newer fold. */
  const sequenceRef = useRef(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const pinKey = runtimePinRef.current?.key ?? null;
  useEffect(() => {
    setPreviewAngle(null);
    if (!enabled) {
      setPosture(null);
      return undefined;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    const api = window.ade.androidEmulator;
    const read = (attempt: number) => {
      const readAt = sequenceRef.current;
      api.getPosture({ laneId }, runtimePinRef.current)
        .then((next) => {
          if (!cancelled && sequenceRef.current === readAt) setPosture(next.supported ? next : null);
        })
        .catch((cause: unknown) => {
          logRendererDebugEvent("android.posture_read_failed", { attempt, error: cause instanceof Error ? cause.message : String(cause) });
          // Until a read answers, the pane has no hinge controls: read again a little later.
          if (!cancelled && attempt < POSTURE_READ_RETRIES_MS.length) {
            retryTimer = window.setTimeout(() => read(attempt + 1), POSTURE_READ_RETRIES_MS[attempt]);
          }
        });
    };
    read(0);
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== "android.device.posture" || event.laneId !== laneId) return;
      setPosture(event.posture.supported ? event.posture : null);
    }, runtimePinRef.current);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      unsubscribe();
    };
  }, [enabled, laneId, pinKey, runtimePinRef]);

  const commit = useCallback((angle: number) => {
    const sequence = ++sequenceRef.current;
    setPreviewAngle(angle);
    setBusy(true);
    void window.ade.androidEmulator.setPosture({ laneId, angle }, runtimePinRef.current)
      .then((result) => {
        if (sequenceRef.current !== sequence) return;
        setPosture(result.supported ? result : null);
        setPreviewAngle(null);
      })
      .catch((cause: unknown) => {
        if (sequenceRef.current !== sequence) return;
        setPreviewAngle(null);
        onErrorRef.current(cause);
      })
      .finally(() => {
        if (sequenceRef.current === sequence) setBusy(false);
      });
  }, [laneId, runtimePinRef]);

  const angle = previewAngle ?? posture?.angle ?? 180;
  const hasHinge = posture !== null;
  const stageFold = useMemo<AndroidStageFold | null>(
    () => (hasHinge ? { angle, onPreview: setPreviewAngle, onCommit: commit } : null),
    [angle, commit, hasHinge],
  );
  return { posture, angle, busy, preview: setPreviewAngle, commit, stageFold };
}
