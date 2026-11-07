import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OpenProjectBinding } from "../../../shared/types";
import type { AndroidRecording } from "../../../shared/types/androidEmulator";

/**
 * The rail's Record button: start and stop the lane's recording, and show one
 * an agent started. A stopped recording is filed to proof by the service,
 * under the chat that started it (`chatSessionId`).
 */
export function useAndroidRecording({
  laneId,
  live,
  chatSessionId,
  runtimePinRef,
  onError,
}: {
  laneId: string;
  live: boolean;
  chatSessionId: string | null;
  runtimePinRef: MutableRefObject<OpenProjectBinding | null>;
  onError: (cause: unknown) => void;
}): {
  active: AndroidRecording | null;
  busy: boolean;
  /** The last recording this pane stopped, for the "Saved to proof" receipt. */
  saved: AndroidRecording | null;
  toggleRecording: () => void;
} {
  const [active, setActive] = useState<AndroidRecording | null>(null);
  const [saved, setSaved] = useState<AndroidRecording | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  /** The newest `android.recording.state` that arrived while a press was busy. */
  const heldEventRef = useRef<AndroidRecording | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  // One read when the device goes live, then the brain's `android.recording.state`
  // events: an agent can start or stop a recording at any time.
  const pinKey = runtimePinRef.current?.key ?? null;
  useEffect(() => {
    if (!live) {
      setActive(null);
      return undefined;
    }
    let cancelled = false;
    const api = window.ade.androidEmulator;
    api.recordList({ laneId }, runtimePinRef.current)
      .then((list) => {
        if (!cancelled && !busyRef.current) setActive(list.recordings.find((recording) => recording.active) ?? null);
      })
      .catch(() => {
        // No list: the button starts off, and the next event corrects it.
      });
    const unsubscribe = api.onEvent((event) => {
      if (event.type !== "android.recording.state" || event.laneId !== laneId) return;
      // A Start or Stop press owns the button until it answers. Keep the
      // newest event for it: an agent can start a new recording meanwhile.
      if (busyRef.current) {
        heldEventRef.current = event.recording;
        return;
      }
      setActive((current) => nextActiveRecording(current, event.recording));
    }, runtimePinRef.current);
    return () => { cancelled = true; unsubscribe(); };
  }, [laneId, live, pinKey, runtimePinRef]);

  const toggleRecording = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const api = window.ade.androidEmulator;
    heldEventRef.current = null;
    const work = active
      ? api.recordStop({ laneId, chatSessionId }, runtimePinRef.current).then((stopped) => {
        setActive(null);
        setSaved(stopped);
      })
      : api.recordStart({ laneId, chatSessionId }, runtimePinRef.current).then((started) => {
        setActive(started);
        setSaved(null);
      });
    void work
      .catch((cause: unknown) => onErrorRef.current(cause))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        // The brain frees the lane before a stopped recording is rendered, so an
        // agent's input can start a new one before the reply. Apply the newest
        // event held while busy; no extra read.
        const held = heldEventRef.current;
        heldEventRef.current = null;
        if (held) setActive((current) => nextActiveRecording(current, held));
      });
  }, [active, chatSessionId, laneId, runtimePinRef]);

  return { active, busy, saved, toggleRecording };
}

/**
 * The button's recording after one event. An active recording shows. An
 * inactive one clears the button only when it is the recording shown: a late
 * "stopped" event for an old recording must not hide a newer one.
 */
function nextActiveRecording(current: AndroidRecording | null, event: AndroidRecording): AndroidRecording | null {
  if (event.active) return event;
  return current && current.id !== event.id ? current : null;
}
