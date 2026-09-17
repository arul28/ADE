import { useCallback, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
} from "react";

import type { OpenProjectBinding } from "../../../shared/types";
import type {
  MacDesktopClickArgs,
  MacDesktopDragArgs,
  MacDesktopPressArgs,
  MacDesktopScrollArgs,
  MacDesktopTypeArgs,
} from "../../../shared/types/macDesktop";
import { macDesktopApi } from "./macDesktopApi";

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
      controllerId: context.controllerId,
      chatSessionId: context.chatSessionId,
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
  onPointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onWheel: (event: ReactWheelEvent<HTMLDivElement>) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
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

  const send = useCallback((call: MacDesktopInputCall) => {
    const api = macDesktopApi();
    const pending = call.kind === "click" ? api.click(call.args, runtimePin)
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

  return { onPointerDown, onPointerUp, onWheel, onKeyDown, inputError, clearInputError };
}
