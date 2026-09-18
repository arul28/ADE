import { useCallback, useEffect, useMemo, useState } from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import {
  MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS,
  macDesktopVisibleNotParked,
  reduceMacDesktopNotParked,
  type MacDesktopEventPayload,
  type MacDesktopNotParked,
  type MacDesktopStatus,
} from "../../../shared/types/macDesktop";
import { MAC_DESKTOP_CURSOR_FADE_MS } from "./macDesktopGeometry";
import { captionMacDesktopFrame, clearMacDesktopFrame } from "./macDesktopFrameStore";
import { macDesktopErrorText } from "./macDesktopErrorText";
import { macDesktopApi } from "./macDesktopApi";

/**
 * One lane's desktop status: the first read, the auto-start, and then events.
 *
 * Every field the panel's strip shows moves on an event the service already
 * emits, so a `getStatus` interval would be a second source of truth that is
 * always a beat behind the first. The reduction from event to status is pure
 * and lives in `reduceMacDesktopStatus`, which is what makes it testable
 * without mounting anything.
 */

/** The agent's last action point, drawn as a cursor and faded on a timer. */
export type MacDesktopAgentCursor = {
  x: number;
  y: number;
  at: number;
  caption: string | null;
};

/**
 * Folds one service event into the panel's status.
 *
 * Returns the SAME object when the event is for another lane or carries
 * nothing this status holds, so a caller can compare by identity and a React
 * state setter re-renders nothing. A null status means the first read has not
 * landed yet: an event that arrives first is dropped rather than inventing a
 * partial status the panel would then render as a missing display.
 */
export function reduceMacDesktopStatus(
  status: MacDesktopStatus | null,
  event: MacDesktopEventPayload,
  laneId: string,
): MacDesktopStatus | null {
  if (!status) return status;
  switch (event.type) {
    case "display-created":
      return event.display.laneId === laneId ? { ...status, display: event.display } : status;
    case "display-destroyed":
      return event.laneId === laneId
        // The recording went with the display: the helper closes its recorder
        // when the display dies, and a stale `running: true` made the strip
        // still offer "Stop recording" for a recorder that no longer exists.
        ? { ...status, display: null, windows: [], recording: null }
        : status;
    case "windows-changed":
      return event.laneId === laneId ? { ...status, windows: event.windows } : status;
    case "lease-changed":
      return event.laneId === laneId ? { ...status, lease: event.lease } : status;
    case "recording-changed":
      return event.status.laneId === laneId ? { ...status, recording: event.status } : status;
    case "stream-started":
    case "stream-status":
    case "stream-stopped":
    case "stream-error":
      return event.status.laneId === laneId
        ? {
            ...status,
            stream: {
              running: event.status.running,
              idle: event.status.idle,
              fps: event.status.fps,
              bitrateKbps: event.status.bitrateKbps,
              lastError: event.status.lastError,
            },
          }
        : status;
    // Permissions and driver health are the host's, not one lane's: a denied
    // Screen Recording grant is denied for every display on that Mac.
    case "permission-changed":
      return { ...status, permissions: event.permissions };
    case "driver-health":
      return { ...status, driver: event.health };
    default:
      return status;
  }
}

/**
 * The cursor an observation event puts on screen, or null.
 *
 * The agent's cursor is the last action's own point. Elements come back in the
 * same global plane the display's origin uses, so there is no second
 * coordinate space to reconcile.
 */
export function macDesktopCursorFromEvent(
  event: MacDesktopEventPayload,
  laneId: string,
  now: number,
): MacDesktopAgentCursor | null {
  if (event.type !== "observation" || event.laneId !== laneId) return null;
  const focused = event.observation.elements.find((element) => element.focused)
    ?? event.observation.elements[0]
    ?? null;
  if (!focused) return null;
  return {
    x: focused.center.x,
    y: focused.center.y,
    at: now,
    caption: event.observation.caption,
  };
}

export type UseMacDesktopStatus = {
  status: MacDesktopStatus | null;
  /**
   * Windows the driver could not park AND that are worth saying out loud,
   * newest first, at most `MAC_DESKTOP_NOT_PARKED_MAX`. Empty is the normal
   * state — a retry the driver is still working through is tracked but not
   * shown until it outlives the grace window.
   */
  notParked: readonly MacDesktopNotParked[];
  /** Drops one stranded-window line the user has read. */
  dismissNotParked: (windowId: number) => void;
  setStatus: React.Dispatch<React.SetStateAction<MacDesktopStatus | null>>;
  /** The last thing that went wrong loudly enough to replace the picture. */
  error: string | null;
  setError: (message: string | null) => void;
  refresh: () => Promise<MacDesktopStatus>;
  /** Creates the lane's display. Idempotent on the host, so a retry is safe. */
  start: () => Promise<MacDesktopStatus | null>;
  /** A create is in flight — the empty state says so instead of offering one. */
  starting: boolean;
  cursor: MacDesktopAgentCursor | null;
};

export function useMacDesktopStatus(args: {
  laneId: string;
  laneName?: string | null;
  sessionId: string | null;
  runtimePin: OpenProjectBinding | null;
}): UseMacDesktopStatus {
  const { laneId, sessionId, runtimePin } = args;
  const laneName = args.laneName ?? null;

  const [status, setStatus] = useState<MacDesktopStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<MacDesktopAgentCursor | null>(null);
  const [tracked, setTracked] = useState<readonly MacDesktopNotParked[]>([]);
  /**
   * Ticks only while a tracked retry is still inside its grace window.
   *
   * A retry that is never reported again has no event left to re-render on, so
   * without this one timer the line would appear only on the next unrelated
   * event. One timeout, armed only when something is actually waiting.
   */
  const [graceTick, setGraceTick] = useState(0);

  const refresh = useCallback(async () => {
    const next = await macDesktopApi().getStatus({ laneId, chatSessionId: sessionId }, runtimePin);
    setStatus(next);
    return next;
  }, [laneId, runtimePin, sessionId]);

  /**
   * Auto-start, and the manual retry the empty state offers.
   *
   * The spec's "there is no intermediate card" is load bearing: a tab that
   * opens onto a button saying "Start display" is a step nobody can decline
   * meaningfully. `start` is idempotent and serialized per lane on the host, so
   * two chats in the lane opening the tab at once both get the first display,
   * and a user pressing the button after a `mac-desktop stop` gets the display
   * back instead of a button that only re-reads.
   */
  const [starting, setStarting] = useState(false);

  const start = useCallback(async (): Promise<MacDesktopStatus | null> => {
    setStarting(true);
    setError(null);
    try {
      const started = await macDesktopApi().start(
        { laneId, laneName, chatSessionId: sessionId },
        runtimePin,
      );
      setStatus(started);
      return started;
    } catch (caught) {
      setError(macDesktopErrorText(
        caught instanceof Error ? caught.message : String(caught),
        { laneId, laneName },
      ));
      return null;
    } finally {
      setStarting(false);
    }
  }, [laneId, laneName, runtimePin, sessionId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const current = await refresh();
        if (cancelled || !current.supported || current.display) return;
        await start();
      } catch (caught) {
        if (!cancelled) {
          setError(macDesktopErrorText(
            caught instanceof Error ? caught.message : String(caught),
            { laneId, laneName },
          ));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [laneId, laneName, refresh, start]);

  useEffect(() => {
    const api = window.ade.macDesktop;
    if (!api) return;
    return api.onEvent((event) => {
      setStatus((current) => reduceMacDesktopStatus(current, event, laneId));
      // Tracked beside the status rather than inside it: a window that stayed on
      // the human's own screen is not part of `getStatus`'s answer, so a refresh
      // must not silently clear a warning nothing has fixed.
      setTracked((current) => reduceMacDesktopNotParked(current, event, laneId, Date.now()));
      if (event.type === "display-destroyed" && event.laneId === laneId) {
        clearMacDesktopFrame(laneId);
        return;
      }
      const next = macDesktopCursorFromEvent(event, laneId, Date.now());
      if (event.type === "observation" && event.laneId === laneId) {
        captionMacDesktopFrame(laneId, event.observation.caption);
      }
      if (next) setCursor(next);
    }, runtimePin);
  }, [laneId, runtimePin]);

  /** The cursor glyph fades on its own; no timer runs while nothing happened. */
  useEffect(() => {
    if (!cursor) return;
    const timer = setTimeout(() => setCursor(null), MAC_DESKTOP_CURSOR_FADE_MS);
    return () => clearTimeout(timer);
  }, [cursor]);

  const notParked = useMemo(
    () => macDesktopVisibleNotParked(tracked, Date.now()),
    // `graceTick` is the dependency that makes a waiting retry re-evaluate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tracked, graceTick],
  );

  useEffect(() => {
    const now = Date.now();
    const waiting = tracked
      .filter((entry) => now - entry.firstSeenAt <= MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS)
      .map((entry) => MAC_DESKTOP_NOT_PARKED_RETRY_GRACE_MS - (now - entry.firstSeenAt));
    if (!waiting.length) return;
    const timer = setTimeout(() => setGraceTick((tick) => tick + 1), Math.min(...waiting) + 50);
    return () => clearTimeout(timer);
  }, [tracked, graceTick]);

  const dismissNotParked = useCallback((windowId: number) => {
    setTracked((current) => {
      const next = current.filter((entry) => entry.windowId !== windowId);
      return next.length === current.length ? current : next;
    });
  }, []);

  return { status, setStatus, error, setError, refresh, start, starting, cursor, notParked, dismissNotParked };
}
