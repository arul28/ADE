import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

/**
 * How long after its capture ends a viewer that still wants frames asks
 * again. Short, but long enough for a power-off's `stopped` event, which
 * arrives just after the stream's, to take the device away first.
 */
export const STREAM_RECOVER_DELAY_MS = 750;
/**
 * Automatic reconnects in a row before the viewer stops and shows Reconnect.
 * Reset by the first frame, so a stream that recovers can recover again.
 */
export const STREAM_RECOVER_MAX_TRIES = 3;

export type UseStreamRecoveryArgs = {
  /** Read when a retry fires: a viewer that stopped asking does not reconnect. */
  wantedRef: MutableRefObject<boolean>;
  /** Asks the service for the stream again. */
  reconnect: () => void;
  /** The tries ran out. The tool shows its own stall. */
  onGiveUp: () => void;
  /** A new device: its failures start from zero. */
  resetKey: string | null;
};

export type StreamRecovery = {
  /** The automatic reconnects ran out with no frame in between. */
  gaveUp: boolean;
  /** Ask again after a pause that grows with each try, or give up. */
  scheduleRecover: () => void;
  /** A frame arrived: the next failure starts from zero. */
  noteRecovered: () => void;
};

/*
 * A viewer that still wants frames never waits for a remount.
 *
 * The capture can end under it: another viewer's stop, a helper restart, a
 * device reset. The viewer asks again by itself, a few times with a pause
 * between, and the service's `startStream` either joins the capture that is
 * running or opens a new one.
 */
export function useStreamRecovery({ wantedRef, reconnect, onGiveUp, resetKey }: UseStreamRecoveryArgs): StreamRecovery {
  const [gaveUp, setGaveUp] = useState(false);
  const reconnectRef = useRef(reconnect);
  reconnectRef.current = reconnect;
  const onGiveUpRef = useRef(onGiveUp);
  onGiveUpRef.current = onGiveUp;
  const timerRef = useRef<number | null>(null);
  const triesRef = useRef(0);

  const scheduleRecover = useCallback(() => {
    if (timerRef.current != null) return;
    if (triesRef.current >= STREAM_RECOVER_MAX_TRIES) {
      setGaveUp(true);
      onGiveUpRef.current();
      return;
    }
    triesRef.current += 1;
    const delay = STREAM_RECOVER_DELAY_MS * triesRef.current;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      if (wantedRef.current) reconnectRef.current();
    }, delay);
  }, [wantedRef]);

  const noteRecovered = useCallback(() => {
    triesRef.current = 0;
    setGaveUp(false);
  }, []);

  useEffect(() => () => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current);
  }, []);
  useEffect(() => {
    triesRef.current = 0;
    setGaveUp(false);
  }, [resetKey]);

  return { gaveUp, scheduleRecover, noteRecovered };
}
