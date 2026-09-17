import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import type {
  MacDesktopClickArgs,
  MacDesktopDragArgs,
  MacDesktopMoveArgs,
  MacDesktopPressArgs,
  MacDesktopScrollArgs,
  MacDesktopTypeArgs,
} from "../../../shared/types/macDesktop";
import { macDesktopApi } from "./macDesktopApi";
import {
  createMacDesktopTakeoverCursorFeed,
  type MacDesktopTakeoverCursorFeed,
} from "./MacDesktopTakeoverCursor";

/**
 * Turning a browser event into a real-input call on the lane's Mac.
 *
 * The translation is pure and exported, because the thing that broke here was
 * not the wiring: a forwarded click carried the CHAT session id while the lease
 * was held by this window's controller id, so the host refused every one of
 * them — and the panel swallowed the refusal with `.catch(() => {})`, which is
 * why a takeover looked like a dead screen instead of a denied one. Both halves
 * are testable facts now: the args carry `controllerId`, and a refusal has a
 * visible place to land.
 */

/** A point in the display's own coordinate plane. */
export type MacDesktopPoint = { x: number; y: number };

export type MacDesktopInputContext = {
  laneId: string;
  /** Attribution only. It is NEVER what the lease is checked against. */
  chatSessionId: string | null;
  /** This window's lease identity. The host authorises against this. */
  controllerId: string;
};

export type MacDesktopInputCall =
  | { kind: "move"; args: MacDesktopMoveArgs }
  | { kind: "click"; args: MacDesktopClickArgs }
  | { kind: "drag"; args: MacDesktopDragArgs }
  | { kind: "scroll"; args: MacDesktopScrollArgs }
  | { kind: "type"; args: MacDesktopTypeArgs }
  | { kind: "press"; args: MacDesktopPressArgs };

/** A press and release more than a few points apart is a drag, not a click. */
export const MAC_DESKTOP_DRAG_SLOP_PX = 4;

export function macDesktopPointerUpCall(
  context: MacDesktopInputContext,
  event: { from: MacDesktopPoint | null; to: MacDesktopPoint; button: number; detail: number },
): MacDesktopInputCall {
  const { from, to } = event;
  const dragged = Boolean(
    from
      && (Math.abs(from.x - to.x) > MAC_DESKTOP_DRAG_SLOP_PX
        || Math.abs(from.y - to.y) > MAC_DESKTOP_DRAG_SLOP_PX),
  );
  // Sending a drag as a click would drop the gesture the user actually made.
  if (dragged && from) {
    return {
      kind: "drag",
      args: {
        laneId: context.laneId,
        from: { x: from.x, y: from.y },
        to: { x: to.x, y: to.y },
        mode: "real",
        silent: true,
        controllerId: context.controllerId,
        chatSessionId: context.chatSessionId,
      },
    };
  }
  return {
    kind: "click",
    args: {
      laneId: context.laneId,
      x: to.x,
      y: to.y,
      mode: "real",
      button: event.button === 2 ? "right" : "left",
      count: event.detail >= 2 ? 2 : 1,
      silent: true,
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
    },
  };
}

export function macDesktopWheelCall(
  context: MacDesktopInputContext,
  event: { point: MacDesktopPoint; deltaX: number; deltaY: number },
): MacDesktopInputCall {
  const horizontal = Math.abs(event.deltaX) > Math.abs(event.deltaY);
  const delta = horizontal ? event.deltaX : event.deltaY;
  return {
    kind: "scroll",
    args: {
      laneId: context.laneId,
      x: event.point.x,
      y: event.point.y,
      mode: "real",
      direction: horizontal ? (delta > 0 ? "right" : "left") : (delta > 0 ? "down" : "up"),
      amount: Math.max(1, Math.round(Math.abs(delta) / 20)),
      silent: true,
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
    },
  };
}

export function macDesktopKeyCall(
  context: MacDesktopInputContext,
  event: {
    key: string;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
  },
): MacDesktopInputCall {
  const modifiers: Array<"cmd" | "shift" | "option" | "control"> = [];
  if (event.metaKey) modifiers.push("cmd");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("option");
  if (event.ctrlKey) modifiers.push("control");
  // A bare printable character is text, and typing it as text is what makes
  // dead keys, IME output and pasted-looking input arrive intact. Everything
  // else — and anything with a command modifier — is a key press.
  const printable = event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
  if (printable) {
    return {
      kind: "type",
      args: {
        laneId: context.laneId,
        text: event.key,
        mode: "real",
        silent: true,
        controllerId: context.controllerId,
        chatSessionId: context.chatSessionId,
      },
    };
  }
  return {
    kind: "press",
    args: {
      laneId: context.laneId,
      key: event.key.toLowerCase(),
      modifiers,
      mode: "real",
      silent: true,
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
    },
  };
}

export function macDesktopMoveCall(
  context: MacDesktopInputContext,
  point: MacDesktopPoint,
): MacDesktopInputCall {
  return {
    kind: "move",
    args: {
      laneId: context.laneId,
      x: point.x,
      y: point.y,
      silent: true,
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
    },
  };
}

/** Pointer moves forwarded per second while the user drives. */
export const MAC_DESKTOP_MOVE_HZ = 60;
export const MAC_DESKTOP_MOVE_INTERVAL_MS = Math.round(1_000 / MAC_DESKTOP_MOVE_HZ);

export type MacDesktopMovePump = {
  /** Record the pointer's position. Sends now, or at the next tick. */
  push: (point: MacDesktopPoint) => void;
  /** Drop anything still pending. The gesture is over. */
  stop: () => void;
};

/**
 * The thing that keeps a moving mouse from becoming a flood of RPCs.
 *
 * A pointer over a pane produces an event per compositor frame — 60 a second on
 * a normal display, 240 on this author's — and each one would otherwise be an
 * IPC hop, a lease check and a `CGEvent` post, on a link that may be an SSH
 * forward to another Mac. So: send the first one immediately, because the
 * latency that matters is the one at the start of a gesture, then at most one
 * per interval, and only ever the LATEST position. Intermediate points are
 * dropped rather than queued — a pointer is a position, not a path, and
 * replaying stale positions behind a live mouse is how a cursor ends up
 * visibly trailing its own input.
 *
 * Pure and injectable so the throttle is a test rather than a stopwatch.
 */
export function createMacDesktopMovePump(options: {
  send: (point: MacDesktopPoint) => void;
  intervalMs?: number;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => number;
  cancel?: (handle: number) => void;
}): MacDesktopMovePump {
  const intervalMs = options.intervalMs ?? MAC_DESKTOP_MOVE_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const schedule = options.schedule
    ?? ((fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number);
  const cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle));
  let lastSentAtMs = Number.NEGATIVE_INFINITY;
  let pending: MacDesktopPoint | null = null;
  let timer: number | null = null;

  const flush = (): void => {
    timer = null;
    const point = pending;
    pending = null;
    if (!point) return;
    lastSentAtMs = now();
    options.send(point);
  };

  return {
    push(point) {
      pending = point;
      if (timer != null) return;
      const waitedMs = now() - lastSentAtMs;
      if (waitedMs >= intervalMs) {
        flush();
        return;
      }
      timer = schedule(flush, intervalMs - waitedMs);
    },
    stop() {
      pending = null;
      if (timer == null) return;
      cancel(timer);
      timer = null;
    },
  };
}

/** The one line the strip shows when the host refuses a forwarded event. */
export function macDesktopInputRefusal(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = message.trim();
  return `Input refused: ${trimmed || "unknown error"}`;
}

export type UseMacDesktopRealInput = {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  /** The pointer left the pane: stop drawing the local glyph. */
  onPointerLeave: () => void;
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  /** Where to draw the local pointer glyph. See `MacDesktopTakeoverCursor`. */
  cursorFeed: MacDesktopTakeoverCursorFeed;
  /** Null while the host is accepting input. */
  inputError: string | null;
  clearInputError: () => void;
};

export function useMacDesktopRealInput(args: {
  laneId: string;
  sessionId: string | null;
  controllerId: string;
  /** The user holds the lease. Nothing is forwarded otherwise. */
  enabled: boolean;
  toDisplayPoint: (clientX: number, clientY: number) => MacDesktopPoint | null;
  runtimePin: OpenProjectBinding | null;
}): UseMacDesktopRealInput {
  const { controllerId, enabled, laneId, runtimePin, sessionId, toDisplayPoint } = args;
  const dragStartRef = useRef<MacDesktopPoint | null>(null);
  const loggedRef = useRef<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  // One feed for the life of the hook: the cursor component subscribes to it
  // once, and a new object per render would resubscribe on every keystroke.
  const cursorFeedRef = useRef<MacDesktopTakeoverCursorFeed | null>(null);
  cursorFeedRef.current ??= createMacDesktopTakeoverCursorFeed();
  const cursorFeed = cursorFeedRef.current;

  const send = useCallback((call: MacDesktopInputCall) => {
    const api = macDesktopApi();
    const pending = call.kind === "move" ? api.move(call.args, runtimePin)
      : call.kind === "click" ? api.click(call.args, runtimePin)
      : call.kind === "drag" ? api.drag(call.args, runtimePin)
      : call.kind === "scroll" ? api.scroll(call.args, runtimePin)
      : call.kind === "type" ? api.type(call.args, runtimePin)
      : api.press(call.args, runtimePin);
    void pending.then(
      () => setInputError(null),
      (caught: unknown) => {
        const line = macDesktopInputRefusal(caught);
        setInputError(line);
        // Once per distinct refusal: a held key against a lost lease would
        // otherwise write a log line per repeat.
        if (loggedRef.current !== line) {
          loggedRef.current = line;
          console.warn("mac_desktop.real_input_refused", { laneId, kind: call.kind, line });
        }
      },
    );
  }, [laneId, runtimePin]);
  // The pump is built once and lives for the hook's life, while `send` is
  // rebuilt whenever the runtime pin changes. Read through a ref so the pump
  // never holds a sender bound to a connection that has since moved.
  const sendRef = useRef(send);
  sendRef.current = send;

  /**
   * The throttled forwarder, rebuilt whenever the thing it sends through
   * changes, and torn down with the hook: an interval still holding a point
   * after the panel unmounted would post a pointer event for a view nobody is
   * looking at.
   */
  const movePumpRef = useRef<MacDesktopMovePump | null>(null);
  const contextRef = useRef({ laneId, sessionId, controllerId });
  contextRef.current = { laneId, sessionId, controllerId };
  if (!movePumpRef.current) {
    movePumpRef.current = createMacDesktopMovePump({
      send: (point) => {
        const context = contextRef.current;
        sendRef.current(macDesktopMoveCall(
          { laneId: context.laneId, chatSessionId: context.sessionId, controllerId: context.controllerId },
          point,
        ));
      },
    });
  }
  useEffect(() => () => movePumpRef.current?.stop(), []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const point = toDisplayPoint(event.clientX, event.clientY);
    // The letterbox bars map to nothing, so the glyph is hidden there and no
    // move is sent: a pointer parked on the black band is not a pointer on the
    // lane's screen, and clamping it to the nearest pixel of a real window is
    // the lie `viewPointToDisplayPoint` already refuses to tell.
    cursorFeed.publish(point);
    if (!point) return;
    movePumpRef.current?.push(point);
  }, [cursorFeed, enabled, toDisplayPoint]);

  const onPointerLeave = useCallback(() => {
    cursorFeed.publish(null);
    movePumpRef.current?.stop();
  }, [cursorFeed]);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    dragStartRef.current = toDisplayPoint(event.clientX, event.clientY);
  }, [enabled, toDisplayPoint]);

  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const from = dragStartRef.current;
    dragStartRef.current = null;
    const to = toDisplayPoint(event.clientX, event.clientY);
    if (!to) return;
    send(macDesktopPointerUpCall(
      { laneId, chatSessionId: sessionId, controllerId },
      { from, to, button: event.button, detail: event.detail },
    ));
  }, [controllerId, enabled, laneId, send, sessionId, toDisplayPoint]);

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const point = toDisplayPoint(event.clientX, event.clientY);
    if (!point) return;
    send(macDesktopWheelCall(
      { laneId, chatSessionId: sessionId, controllerId },
      { point, deltaX: event.deltaX, deltaY: event.deltaY },
    ));
  }, [controllerId, enabled, laneId, send, sessionId, toDisplayPoint]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return;
    event.preventDefault();
    send(macDesktopKeyCall({ laneId, chatSessionId: sessionId, controllerId }, {
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
    }));
  }, [controllerId, enabled, laneId, send, sessionId]);

  const clearInputError = useCallback(() => {
    loggedRef.current = null;
    setInputError(null);
  }, []);

  return {
    onPointerDown,
    onPointerMove,
    onPointerLeave,
    onPointerUp,
    onWheel,
    onKeyDown,
    cursorFeed,
    inputError,
    clearInputError,
  };
}
