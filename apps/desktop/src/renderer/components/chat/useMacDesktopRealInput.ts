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
  MacDesktopInputResult,
  MacDesktopMoveArgs,
  MacDesktopPressArgs,
  MacDesktopScrollArgs,
  MacDesktopTypeArgs,
} from "../../../shared/types/macDesktop";
import { macDesktopApi } from "./macDesktopApi";
import { macDesktopErrorText, type MacDesktopErrorTextOptions } from "./macDesktopErrorText";
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
): MacDesktopInputCall | null {
  const modifiers: Array<"cmd" | "shift" | "option" | "control"> = [];
  if (event.metaKey) modifiers.push("cmd");
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("option");
  if (event.ctrlKey) modifiers.push("control");
  const named = macDesktopNamedKey(event.key);
  // A modifier by itself is not a keystroke. Sending `event.key` of "Control"
  // as `press key=control` is what printed "is not a key this driver knows"
  // on every Ctrl/Shift/Cmd tap. The chord is the next key, which already
  // carries these flags.
  if (MAC_DESKTOP_MODIFIER_KEYS.has(named)) return null;
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
      key: named,
      modifiers,
      mode: "real",
      silent: true,
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
    },
  };
}

/** Browser `event.key` values that are only modifiers. */
const MAC_DESKTOP_MODIFIER_KEYS = new Set([
  "control",
  "shift",
  "meta",
  "alt",
  "option",
  "cmd",
  "command",
  "hyper",
  "capslock",
  "os",
  "fn",
]);

/** Browser names → the names `KeyCodes` in the driver actually has. */
const MAC_DESKTOP_KEY_ALIASES: Record<string, string> = {
  arrowleft: "left",
  arrowright: "right",
  arrowup: "up",
  arrowdown: "down",
  " ": "space",
  spacebar: "space",
  esc: "escape",
  return: "return",
};

function macDesktopNamedKey(key: string): string {
  const lowered = key.toLowerCase();
  return MAC_DESKTOP_KEY_ALIASES[lowered] ?? lowered;
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
export function macDesktopInputRefusal(
  error: unknown,
  options?: MacDesktopErrorTextOptions,
): string {
  const message = error instanceof Error ? error.message : String(error);
  const peeled = macDesktopErrorText(message, options);
  return `Input refused: ${peeled || "unknown error"}`;
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

/**
 * Where a forwarded call goes.
 *
 * The desktop panel leaves this unset and the hook dispatches through
 * `macDesktopApi()` exactly as it always has. The hosted web client injects
 * the sync action instead, which is what makes this hook usable off Electron:
 * everything above the call — the gesture translation, the coalescing, the
 * keyboard rules, the cursor feed — is the same code on both surfaces.
 */
export type MacDesktopInputSender = (
  call: MacDesktopInputCall,
) => Promise<MacDesktopInputResult | null>;

/** What the driver reads for each real-input command. Mirrors `macDesktopInput.ts`. */
export function macDesktopDriverPayload(call: MacDesktopInputCall): Record<string, unknown> {
  switch (call.kind) {
    case "move":
      return { to: { x: call.args.x, y: call.args.y } };
    case "click":
      return {
        at: { x: call.args.x, y: call.args.y },
        button: call.args.button ?? "left",
        count: Math.max(1, Math.min(3, Math.round(call.args.count ?? 1))),
      };
    case "drag":
      return { from: call.args.from, to: call.args.to, durationMs: call.args.durationMs ?? 300 };
    case "scroll":
      return {
        x: call.args.x,
        y: call.args.y,
        direction: call.args.direction,
        amount: Math.max(1, Math.min(50, Math.round(call.args.amount ?? 3))),
      };
    case "type":
      return { text: call.args.text };
    case "press":
      return { key: call.args.key, modifiers: call.args.modifiers ?? [] };
  }
}

/**
 * The takeover fast path: one local HTTP request per event, straight into the
 * driver, on the loopback port the stream already comes from. Built from the
 * stream URL because that is the one place the renderer holds the lane's token.
 * Returns null when there is no transport yet, so the caller falls back to
 * the IPC dispatch.
 */
export function createMacDesktopFastInputSender(streamUrl: string | null | undefined): MacDesktopInputSender | null {
  if (!streamUrl) return null;
  let target: URL;
  try {
    target = new URL(streamUrl);
  } catch {
    return null;
  }
  target.pathname = "/mac-desktop/input";
  const endpoint = target.toString();
  return async (call) => {
    const { controllerId, chatSessionId } = call.args;
    // The driver's own payload shapes, the same translation the service
    // applies on the RPC path. Forwarding the renderer's flat args (`x`, `y`,
    // `button`) as-is left `click` and `scroll` unrecognised at the driver.
    const payload = macDesktopDriverPayload(call);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ controllerId, chatSessionId: chatSessionId ?? null, command: call.kind, payload }),
      keepalive: true,
    });
    if (response.status === 204) return { ok: true, action: call.kind, mode: "real", silent: true, resolved: null, observation: null, trace: null };
    let detail: { code?: string; message?: string } = {};
    try { detail = await response.json(); } catch { /* not JSON */ }
    const error = new Error(detail.message ?? `Input refused (${response.status}).`) as Error & { code?: string };
    error.code = detail.code;
    throw error;
  };
}

/** The desktop's dispatch, unchanged, as the hook's default sender. */
function sendMacDesktopInputCall(
  call: MacDesktopInputCall,
  runtimePin: OpenProjectBinding | null,
): Promise<MacDesktopInputResult> {
  const api = macDesktopApi();
  return call.kind === "move" ? api.move(call.args, runtimePin)
    : call.kind === "click" ? api.click(call.args, runtimePin)
    : call.kind === "drag" ? api.drag(call.args, runtimePin)
    : call.kind === "scroll" ? api.scroll(call.args, runtimePin)
    : call.kind === "type" ? api.type(call.args, runtimePin)
    : api.press(call.args, runtimePin);
}

export function useMacDesktopRealInput(args: {
  laneId: string;
  sessionId: string | null;
  controllerId: string;
  /** The user holds the lease. Nothing is forwarded otherwise. */
  enabled: boolean;
  toDisplayPoint: (clientX: number, clientY: number) => MacDesktopPoint | null;
  runtimePin: OpenProjectBinding | null;
  /** Injected transport. See {@link MacDesktopInputSender}. */
  sender?: MacDesktopInputSender | null;
  /**
   * Forward throttled pointer moves.
   *
   * Off for the desktop, deliberately: a hover `CGEvent` teleports the one
   * system cursor onto the virtual display, and a 60 Hz warp+post flood stalls
   * ScreenCaptureKit — the desktop draws a local glyph instead. A remote
   * controller is a different trade: the pointer in the picture has to track
   * something, so the web opts in and the pump below (one call per frame,
   * latest position only) is what keeps it from becoming a flood.
   */
  forwardPointerMoves?: boolean;
}): UseMacDesktopRealInput {
  const {
    controllerId,
    enabled,
    forwardPointerMoves = false,
    laneId,
    runtimePin,
    sender,
    sessionId,
    toDisplayPoint,
  } = args;
  const dragStartRef = useRef<MacDesktopPoint | null>(null);
  const loggedRef = useRef<string | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);

  // One feed for the life of the hook: the cursor component subscribes to it
  // once, and a new object per render would resubscribe on every keystroke.
  const cursorFeedRef = useRef<MacDesktopTakeoverCursorFeed | null>(null);
  cursorFeedRef.current ??= createMacDesktopTakeoverCursorFeed();
  const cursorFeed = cursorFeedRef.current;

  const send = useCallback((call: MacDesktopInputCall) => {
    const pending = sender ? sender(call) : sendMacDesktopInputCall(call, runtimePin);
    void pending.then(
      () => setInputError(null),
      (caught: unknown) => {
        const line = macDesktopInputRefusal(caught, { laneId });
        setInputError(line);
        // Once per distinct refusal: a held key against a lost lease would
        // otherwise write a log line per repeat.
        if (loggedRef.current !== line) {
          loggedRef.current = line;
          console.warn("mac_desktop.real_input_refused", { laneId, kind: call.kind, line });
        }
      },
    );
  }, [laneId, runtimePin, sender]);

  // The pump is built once and lives for the hook's life, while `send` is
  // rebuilt whenever the transport changes. Read through refs so the pump never
  // holds a sender bound to a connection that has since moved.
  const sendRef = useRef(send);
  sendRef.current = send;
  const contextRef = useRef({ laneId, sessionId, controllerId });
  contextRef.current = { laneId, sessionId, controllerId };
  const movePumpRef = useRef<MacDesktopMovePump | null>(null);
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
  useEffect(() => {
    // A pending move posted after the gesture (or the takeover) ended would
    // move the lane's pointer from a view nobody is driving.
    if (!enabled || !forwardPointerMoves) movePumpRef.current?.stop();
  }, [enabled, forwardPointerMoves]);
  useEffect(() => () => movePumpRef.current?.stop(), []);

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const point = toDisplayPoint(event.clientX, event.clientY);
    // The local glyph is the pointer the person sees. Hover `CGEvent`s are
    // not sent by the desktop: each one teleports the one system cursor onto
    // the virtual display (and a 60Hz flood of warp+post stalls the capture).
    // Clicks, drags, scrolls and keys still go through. A letterbox hit does
    // not hide the glyph — that is what made the yellow arrow vanish.
    if (point) cursorFeed.publish(point);
    if (!point || !forwardPointerMoves) return;
    movePumpRef.current?.push(point);
  }, [cursorFeed, enabled, forwardPointerMoves, toDisplayPoint]);

  const onPointerLeave = useCallback(() => {
    // The system cursor may leave this element for the length of a posted
    // click; that is the warp, not the person walking off. The glyph stays.
  }, []);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled) return;
    event.currentTarget.focus({ preventScroll: true });
    // Restore-after-post warps the system cursor off this element for a beat
    // and would otherwise cancel the gesture before `pointerup`. Capture keeps
    // the click/drag on this target through that warp. A host where capture is
    // unavailable (or refuses the pointer id) must not drop the gesture: the
    // click is still sent from `pointerup`, with no press point to compare
    // against so it reads as a click rather than a drag.
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Capture failed; continue with the gesture.
    }
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
    const call = macDesktopKeyCall({ laneId, chatSessionId: sessionId, controllerId }, {
      key: event.key,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
    });
    if (!call) return;
    event.preventDefault();
    send(call);
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
