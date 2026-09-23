import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  MAC_DESKTOP_STOP_WAIT_MS,
  macDesktopPendingStop,
  macDesktopStatusKey,
  publishMacDesktopStatus,
  publishMacDesktopUnconfirmed,
  stopMacDesktopLane,
  subscribeMacDesktopRuntimeChanges,
  withMacDesktopTimeout,
} from "./macDesktopStatusStore";

/**
 * One lane's desktop status: the first read, then events, and an explicit start.
 *
 * Watching never creates a display. Opening the pane only reads; a lane with
 * no display shows the Off card, and only its Start (or an agent's
 * `ade mac-desktop start`) creates one. This is the Apple tool's rule.
 *
 * Every field the panel's strip shows moves on an event the service already
 * emits, so a `getStatus` interval would be a second source of truth that is
 * always a beat behind the first. The reduction from event to status is pure
 * and lives in `reduceMacDesktopStatus`, which is what makes it testable
 * without mounting anything.
 */

/**
 * How often a wait that has not moved re-reads the truth.
 *
 * The same cadence as the Apple pane's `APPLE_LOADING_RECHECK_MS`. A start
 * whose reply never comes, or a `display-destroyed` event that was missed,
 * must not leave the pane on "Starting" or "Connecting video" for ever.
 */
export const MAC_DESKTOP_LOADING_RECHECK_MS = 8_000;
/**
 * Past this a start has failed whatever its promise says. The pane then says
 * so and offers Start again, as the Apple pane does at `APPLE_START_GIVE_UP_MS`.
 */
export const MAC_DESKTOP_START_GIVE_UP_MS = 150_000;
export const MAC_DESKTOP_START_TOO_LONG = "Mac Desktop is taking too long to start.";
/**
 * Coming back to the window re-reads the status, at most this often.
 *
 * Returning to the pane after typing elsewhere used to show whatever the pane
 * last knew, and a display that died meanwhile stayed "live" until an event
 * that never came.
 */
export const MAC_DESKTOP_REVALIDATE_MIN_MS = 3_000;

/**
 * Re-reads the status every `MAC_DESKTOP_LOADING_RECHECK_MS` while `waiting`.
 *
 * A failed read changes nothing: the next tick tries again, and the wait
 * itself is what the pane shows.
 */
export function useMacDesktopRecheck(waiting: boolean, refresh: () => Promise<unknown>): void {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => {
      void refreshRef.current().catch(() => undefined);
    }, MAC_DESKTOP_LOADING_RECHECK_MS);
    return () => clearInterval(timer);
  }, [waiting]);
}

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
  /**
   * Why the newest status read failed, or null once one succeeds.
   *
   * Kept apart from `error`: a read that failed or timed out says nothing
   * about the display, only that the host did not answer, and the next good
   * read clears it by itself.
   */
  readError: string | null;
  /**
   * The newest read failed. What `status` says may be out of date, so the
   * pane must not present it as live without saying so.
   */
  unconfirmed: boolean;
  refresh: () => Promise<MacDesktopStatus>;
  /** Stops the lane's display, then reads the truth. */
  stop: () => Promise<boolean>;
  /** A stop is in flight, from this pane or from closing the tab. */
  stopping: boolean;
  /** Creates the lane's display. Idempotent on the host, so a retry is safe. */
  start: () => Promise<MacDesktopStatus | null>;
  /** A create is in flight — the empty state says so instead of offering one. */
  starting: boolean;
  /**
   * The last start ran past `MAC_DESKTOP_START_GIVE_UP_MS`. `error` holds the
   * sentence; the pane offers Start rather than a permission re-check.
   */
  gaveUp: boolean;
  cursor: MacDesktopAgentCursor | null;
};

export function useMacDesktopStatus(args: {
  laneId: string;
  laneName?: string | null;
  sessionId: string | null;
  runtimePin: OpenProjectBinding | null;
  /** The machine the pin names, for the "update ADE there" sentence. */
  machineName?: string | null;
  /** That machine's ADE version, when known. */
  machineVersion?: string | null;
}): UseMacDesktopStatus {
  const { laneId, sessionId, runtimePin } = args;
  const laneName = args.laneName ?? null;
  const machineName = args.machineName ?? null;
  const machineVersion = args.machineVersion ?? null;

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

  const [readError, setReadError] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const storeKey = macDesktopStatusKey(laneId, runtimePin);
  const [stopping, setStopping] = useState(() => macDesktopPendingStop(storeKey) !== null);

  const errorText = useCallback((caught: unknown) => macDesktopErrorText(
    caught instanceof Error ? caught.message : String(caught),
    { laneId, laneName, machineName, machineVersion },
  ), [laneId, laneName, machineName, machineVersion]);
  const errorTextRef = useRef(errorText);
  errorTextRef.current = errorText;

  /**
   * Which read is the newest, and how many display events came in since.
   *
   * Reads overlap: the first read, the recheck, a focus re-read and a Start's
   * follow-up can all be out at once, and the slowest used to win. Only the
   * newest read may write, and only if no display event arrived while it was
   * out, because that event is newer than anything the read saw.
   *
   * "Newest" is by when a read was sent, among the ones that have answered.
   * Ranking against reads still out would let an 8 s recheck supersede every
   * read before its 10 s timeout fired, and a stuck host would never be said
   * to be stuck.
   */
  const readSeqRef = useRef(0);
  const settledSeqRef = useRef(0);
  const eventEpochRef = useRef(0);

  const refresh = useCallback(async () => {
    const seq = readSeqRef.current + 1;
    readSeqRef.current = seq;
    const epoch = eventEpochRef.current;
    const newest = () => {
      if (seq <= settledSeqRef.current) return false;
      settledSeqRef.current = seq;
      return true;
    };
    try {
      // A read that never answers is a failed read. Without the timeout the
      // pane sat on "Checking Mac Desktop…" for as long as the host was stuck.
      const next = await withMacDesktopTimeout(
        macDesktopApi().getStatus({ laneId, chatSessionId: sessionId }, runtimePin),
      );
      if (newest()) {
        if (epoch === eventEpochRef.current) setStatus(next);
        setReadError(null);
        setUnconfirmed(false);
      }
      return next;
    } catch (caught) {
      if (newest()) {
        setReadError(errorTextRef.current(caught));
        setUnconfirmed(true);
      }
      throw caught;
    }
  }, [laneId, runtimePin, sessionId]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const statusRef = useRef(status);
  statusRef.current = status;

  // The tool card draws from the same entry, so the two cannot disagree.
  useEffect(() => {
    if (status) publishMacDesktopStatus(storeKey, { status, confirmed: !unconfirmed });
    else if (unconfirmed) publishMacDesktopUnconfirmed(storeKey);
  }, [status, storeKey, unconfirmed]);

  /**
   * The explicit start: the Off card's Start, "Check again" and a retry.
   *
   * `start` is idempotent and serialized per lane on the host, so two chats in
   * the lane pressing Start at once both get the first display. Each call takes
   * a token, and only the current one may settle the wait: a start that the
   * `display-created` event, the give-up timer or a newer start already
   * replaced changes nothing when its promise finally lands.
   */
  const startTokenRef = useRef(0);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const starting = startedAt !== null;
  const [gaveUp, setGaveUp] = useState(false);

  const settleStart = useCallback(() => {
    startTokenRef.current += 1;
    setStartedAt(null);
  }, []);

  const start = useCallback(async (): Promise<MacDesktopStatus | null> => {
    const token = startTokenRef.current + 1;
    startTokenRef.current = token;
    const current = () => startTokenRef.current === token;
    setStartedAt(Date.now());
    setGaveUp(false);
    setError(null);
    try {
      const started = await macDesktopApi().start(
        { laneId, laneName, chatSessionId: sessionId },
        runtimePin,
      );
      // A replaced start's answer may be older than what the pane shows now,
      // so it is not applied. A re-read gives the truth instead.
      if (current()) setStatus(started);
      else void refresh().catch(() => undefined);
      return started;
    } catch (caught) {
      if (current()) setError(errorText(caught));
      return null;
    } finally {
      if (current()) setStartedAt(null);
    }
  }, [errorText, laneId, laneName, refresh, runtimePin, sessionId]);

  /**
   * Stop: the header's Stop, and Reset when the pane cannot tell what state
   * the lane is in. Always followed by a read, so the pane shows what the host
   * says rather than what the stop promised.
   */
  const stop = useCallback(async (): Promise<boolean> => {
    settleStart();
    setGaveUp(false);
    setError(null);
    setStopping(true);
    let stopped = true;
    try {
      await withMacDesktopTimeout(
        stopMacDesktopLane({ laneId, chatSessionId: sessionId, runtimePin }),
        MAC_DESKTOP_STOP_WAIT_MS,
        "Mac Desktop did not stop in time.",
      );
    } catch (caught) {
      stopped = false;
      setError(errorText(caught));
    } finally {
      setStopping(false);
    }
    await refresh().catch(() => undefined);
    return stopped;
  }, [errorText, laneId, refresh, runtimePin, sessionId, settleStart]);

  // A display for this lane ends the start, whether the promise, the event or
  // a re-read brought it.
  const hasDisplay = Boolean(status?.display);
  useEffect(() => {
    if (starting && hasDisplay) settleStart();
  }, [hasDisplay, settleStart, starting]);

  // Past the give-up time the start has failed, whatever its promise says.
  useEffect(() => {
    if (startedAt === null) return undefined;
    const timer = setTimeout(() => {
      settleStart();
      setGaveUp(true);
      setError(MAC_DESKTOP_START_TOO_LONG);
    }, Math.max(0, startedAt + MAC_DESKTOP_START_GIVE_UP_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [settleStart, startedAt]);

  // A start belongs to one lane on one machine; another one starts fresh.
  useEffect(() => {
    settleStart();
  }, [refresh, settleStart]);

  // The first read only. Watching never creates a display. It runs again when
  // the machine's name or version arrives, so a failure can name them.
  //
  // A stop still in flight is waited for first. Closing the tab sends one and
  // does not wait, and a pane reopened a moment later used to read the display
  // that was about to go, show it, then flip to Off.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setGaveUp(false);
    void (async () => {
      const pendingStop = macDesktopPendingStop(storeKey);
      if (pendingStop) {
        setStopping(true);
        await withMacDesktopTimeout(pendingStop, MAC_DESKTOP_STOP_WAIT_MS).catch(() => undefined);
        if (cancelled) return;
        setStopping(false);
      }
      // A failure lands in `readError`, which the pane shows with Try again.
      await refresh().catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, [laneId, laneName, machineName, machineVersion, refresh, storeKey]);

  // While the first read or a start is pending, re-read the truth.
  useMacDesktopRecheck(starting || (status === null && readError === null && !stopping), refresh);

  // Coming back to the window re-reads. A display that died while the person
  // was typing elsewhere must not still look live when they return. So does a
  // brain restart or a runtime reconnect: the new brain has no display to say
  // "destroyed" about, so no event would ever correct the pane.
  useEffect(() => {
    let last = 0;
    const revalidate = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - last < MAC_DESKTOP_REVALIDATE_MIN_MS) return;
      last = now;
      void refreshRef.current().catch(() => undefined);
    };
    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    const disposeRuntime = subscribeMacDesktopRuntimeChanges(revalidate);
    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      disposeRuntime();
    };
  }, []);

  useEffect(() => {
    const api = window.ade.macDesktop;
    if (!api) return;
    return api.onEvent((event) => {
      setStatus((current) => reduceMacDesktopStatus(current, event, laneId));
      if (
        (event.type === "display-created" && event.display.laneId === laneId)
        || (event.type === "display-destroyed" && event.laneId === laneId)
      ) {
        // A read already out saw the world before this event. Only once there
        // is a status for the event to have changed: before that the reducer
        // drops it, and the read is the only thing that can fill the pane.
        if (statusRef.current) eventEpochRef.current += 1;
        // Before the first read lands the reducer drops the event, so read
        // again: the pane must not wait for the next tick to show the change.
        if (!statusRef.current) void refreshRef.current().catch(() => undefined);
        // A failure shown before is stale once a display arrives, and once the
        // display it was about has closed: that must read as the Off card. A
        // failed start's own error stays, as there was no display to close.
        if (event.type === "display-created" || statusRef.current?.display) {
          setGaveUp(false);
          setError(null);
        }
      }
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

  return {
    status,
    setStatus,
    error,
    setError,
    readError,
    unconfirmed,
    refresh,
    stop,
    stopping,
    start,
    starting,
    gaveUp,
    cursor,
    notParked,
    dismissNotParked,
  };
}
