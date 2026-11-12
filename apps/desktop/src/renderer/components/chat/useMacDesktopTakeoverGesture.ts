import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { DesktopSeatKind, MacDesktopDisplay } from "../../../shared/types/macDesktop";
import {
  macDesktopPointerUpCall,
  macDesktopWheelCall,
  type MacDesktopPoint,
  type UseMacDesktopRealInput,
} from "./useMacDesktopRealInput";

/**
 * The gesture that took control, held while the takeover call is in flight.
 * `press.from` and `release.to` are null when the pointer was on the
 * letterbox. A held press has no release yet.
 */
type MacDesktopTakeoverGesture = {
  press: { from: MacDesktopPoint | null; button: number } | null;
  release: { to: MacDesktopPoint | null; detail: number } | null;
  wheel: { point: MacDesktopPoint; deltaX: number; deltaY: number } | null;
};

/**
 * Routes the screen surface's DOM input: to a takeover while this view does
 * not hold the lease, to the real-input hook once it does.
 *
 * Which seats deliver the gesture that takes control:
 *
 * - Linux and Windows private: the lane's screen has its own pointer and
 *   keyboard, and no person sits at it (the host's own lease rule says the
 *   same). The click or scroll that takes control is also sent once the
 *   lease is granted, so one click is enough, and a scroll over the picture
 *   takes control the way a click does.
 * - Mac and Windows shared: real input moves a person's one pointer, so the
 *   lease guards it. The first click only takes control, and a scroll
 *   without control is not sent and does not take control.
 *
 * The real-input hook owns the one gate between a grant and the render that
 * carries the lease: the grant opens it (`openGateUntilRender`), and both
 * this hook (`gateOpen`) and the real-input handlers read it beside the
 * rendered lease. Each render clears it and reads the lease itself again, so
 * a lease the host dropped since does not stay open here.
 *
 * Input reaches the surface as DOM events, on purpose. The decoder's canvas
 * is a React portal into a host node parked inside the surface. A portal's
 * synthetic events bubble through the React tree, to the portal's owner, and
 * never through the surface that is its DOM parent. Native listeners follow
 * the DOM, where the canvas really is.
 */
export function useMacDesktopTakeoverGesture(
  surfaceNode: HTMLElement | null,
  options: {
    realInput: UseMacDesktopRealInput;
    /** Resolves true when this view holds the lease afterwards. */
    takeControl: () => Promise<boolean>;
    toDisplayPoint: (clientX: number, clientY: number) => MacDesktopPoint | null;
    busy: boolean;
    takeoverBlocked: boolean;
    /**
     * The seat the pane resolved (`useMacDesktopPanelController`), never
     * worked out again here: an older Windows host says "shared" only in
     * `status.windowsDesktop`, and a second answer could send real input to
     * the user's own desktop.
     */
    seat: DesktopSeatKind;
    display: MacDesktopDisplay | null;
    laneId: string;
    sessionId: string | null;
    controllerId: string;
  },
): void {
  const { busy, takeoverBlocked, display, seat } = options;
  const takeoverDeliversGesture = Boolean(display) && (seat === "linux" || seat === "windows-private");
  const controlStateRef = useRef({ busy, takeoverBlocked, takeoverDeliversGesture });
  controlStateRef.current = { busy, takeoverBlocked, takeoverDeliversGesture };
  const takeControlRef = useRef(options.takeControl);
  takeControlRef.current = options.takeControl;
  const realInputRef = useRef(options.realInput);
  realInputRef.current = options.realInput;
  const toDisplayPointRef = useRef(options.toDisplayPoint);
  toDisplayPointRef.current = options.toDisplayPoint;
  const contextRef = useRef({ laneId: options.laneId, chatSessionId: options.sessionId, controllerId: options.controllerId });
  contextRef.current = { laneId: options.laneId, chatSessionId: options.sessionId, controllerId: options.controllerId };
  /** The gesture held while a takeover call is in flight. */
  const pendingTakeoverRef = useRef<MacDesktopTakeoverGesture | null>(null);

  useEffect(() => {
    const node = surfaceNode;
    if (!node) return;
    // A grant that answers after the pane is gone sends nothing and opens no gate.
    let disposed = false;
    // The real-input gate: the rendered lease, or a grant ahead of the render that carries it.
    const haveControl = () => realInputRef.current.gateOpen();
    /**
     * Sends the gesture that took control, once the lease is granted. A press
     * that is still held is not sent here: the coming pointerup ends it as a
     * normal click or drag.
     */
    const deliverTakeoverGesture = (gesture: MacDesktopTakeoverGesture) => {
      const realInput = realInputRef.current;
      const context = contextRef.current;
      if (gesture.wheel) realInput.sendInput(macDesktopWheelCall(context, gesture.wheel));
      const { press, release } = gesture;
      if (!press) return;
      if (!release) {
        realInput.holdPress(press.from);
        return;
      }
      if (!release.to) return;
      realInput.sendInput(macDesktopPointerUpCall(context, {
        from: press.from,
        to: release.to,
        button: press.button,
        detail: release.detail,
      }));
    };
    /**
     * One takeover for the whole gesture. When the host grants the lease,
     * the input gate opens at once and the held gesture is sent.
     */
    const startTakeover = (): MacDesktopTakeoverGesture | null => {
      const held = pendingTakeoverRef.current;
      if (held) return held;
      const state = controlStateRef.current;
      if (state.busy || state.takeoverBlocked) return null;
      const gesture: MacDesktopTakeoverGesture = { press: null, release: null, wheel: null };
      pendingTakeoverRef.current = gesture;
      void takeControlRef.current().then((granted) => {
        if (pendingTakeoverRef.current === gesture) pendingTakeoverRef.current = null;
        if (!granted || disposed) return;
        // The render that carries the lease comes later. Until then, the rest
        // of this gesture goes to the input hook, not to a second takeover.
        realInputRef.current.openGateUntilRender();
        deliverTakeoverGesture(gesture);
      });
      return gesture;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!haveControl()) {
        const state = controlStateRef.current;
        // The first click on the screen takes control; the strip button is
        // the same action. Right-click is a menu, not a claim.
        if (event.button === 2) return;
        if (!state.takeoverDeliversGesture) {
          if (!state.busy && !state.takeoverBlocked) void takeControlRef.current();
          return;
        }
        // Keys typed after the takeover go to the lane, with no second click.
        node.focus({ preventScroll: true });
        const gesture = startTakeover();
        if (!gesture || gesture.press || event.button !== 0) return;
        try {
          node.setPointerCapture(event.pointerId);
        } catch {
          // No capture: a release off the surface is then not seen, and the
          // held press is ended by the next pointerup instead.
        }
        gesture.press = { from: toDisplayPointRef.current(event.clientX, event.clientY), button: event.button };
        return;
      }
      realInputRef.current.onPointerDown(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerMove = (event: PointerEvent) => {
      realInputRef.current.onPointerMove(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerUp = (event: PointerEvent) => {
      const held = pendingTakeoverRef.current;
      if (held?.press && !held.release) {
        held.release = { to: toDisplayPointRef.current(event.clientX, event.clientY), detail: event.detail };
        return;
      }
      realInputRef.current.onPointerUp(event as unknown as ReactPointerEvent<HTMLDivElement>);
    };
    const onPointerLeave = () => realInputRef.current.onPointerLeave();
    const onWheel = (event: WheelEvent) => {
      const delivers = controlStateRef.current.takeoverDeliversGesture;
      if (haveControl()) {
        // On a seat with its own pointer the scroll goes to the lane only.
        // Without this the pane's own scroll container moves too, and the
        // picture slides up and down under it.
        if (delivers) event.preventDefault();
      } else if (delivers) {
        const point = toDisplayPointRef.current(event.clientX, event.clientY);
        if (!point) return;
        const gesture = startTakeover();
        // No takeover (busy, or blocked while the agent drives): the pane scrolls as usual.
        if (!gesture) return;
        event.preventDefault();
        // A trackpad sends many small wheel events while the call is in
        // flight. They add up to one scroll, sent once control is granted.
        gesture.wheel = {
          point,
          deltaX: (gesture.wheel?.deltaX ?? 0) + event.deltaX,
          deltaY: (gesture.wheel?.deltaY ?? 0) + event.deltaY,
        };
        return;
      }
      realInputRef.current.onWheel(event as unknown as ReactWheelEvent<HTMLDivElement>);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      realInputRef.current.onKeyDown(event as unknown as ReactKeyboardEvent<HTMLDivElement>);
    };
    const onContextMenu = (event: MouseEvent) => {
      if (haveControl()) event.preventDefault();
    };
    node.addEventListener("pointerdown", onPointerDown);
    node.addEventListener("pointermove", onPointerMove);
    node.addEventListener("pointerup", onPointerUp);
    node.addEventListener("pointerleave", onPointerLeave);
    // Non-passive: a scroll forwarded to the lane must not also scroll the pane.
    node.addEventListener("wheel", onWheel, { passive: false });
    node.addEventListener("keydown", onKeyDown);
    node.addEventListener("contextmenu", onContextMenu);
    return () => {
      disposed = true;
      node.removeEventListener("pointerdown", onPointerDown);
      node.removeEventListener("pointermove", onPointerMove);
      node.removeEventListener("pointerup", onPointerUp);
      node.removeEventListener("pointerleave", onPointerLeave);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("keydown", onKeyDown);
      node.removeEventListener("contextmenu", onContextMenu);
    };
  }, [surfaceNode]);
}
