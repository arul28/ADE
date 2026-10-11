import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

/** How to undo an action that a press started, for a press that becomes a drag. */
export type PressUndo = () => void;

/**
 * What a press-activated control does. It may return how to undo itself; the
 * undo runs when the press becomes a native drag of the control, so that a
 * drag of a row does not also open the row.
 */
export type PressAction = (event: ReactMouseEvent<HTMLElement>) => void | PressUndo;

const NESTED_CONTROL_SELECTOR =
  "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='menuitem'], [contenteditable='true']";

/**
 * The control whose press already acted, until that press is over. The click
 * of the same press must not act again. One value serves every control: a
 * mouse holds its button on one control at a time.
 */
let pressedControl: Element | null = null;

/** The press belongs to something else: a control in this one, or a portal. */
function pressIsOutsideOwnSurface(event: ReactPointerEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  // React sends a press in a portal (a menu, a hover card, its backdrop) to the
  // component that rendered the portal, although the portal is not in its DOM.
  if (!event.currentTarget.contains(target)) return true;
  const control = target.closest(NESTED_CONTROL_SELECTOR);
  return control != null && control !== event.currentTarget;
}

/**
 * The `onPointerDown` and `onClick` of a control that acts on the press of the
 * mouse button, not on its release.
 *
 * A click fires on mouse-up, 60 to 120 ms after the button went down. For a
 * control that only changes what is on screen (a chat row, a page tab) that
 * hold is most of what the switch costs the reader; see "press to content" in
 * docs/perf/macos-baseline.md.
 *
 * Only a plain mouse press acts early: the primary button, no modifier key, on
 * the control itself. Everything else keeps the click:
 * - touch and pen, where a press can be the start of a scroll;
 * - the keyboard and assistive technology, which send a click with no press;
 * - a modified click (range and toggle selection; Ctrl+click opens the context
 *   menu on macOS and sends no click);
 * - a press on a control nested in this one or in a portal of it, which has
 *   its own click.
 *
 * Pass `actOnPress: false` while the control must wait for the click.
 */
export function pressActivation(action: PressAction, actOnPress = true): {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
} {
  return {
    onPointerDown(event) {
      if (!actOnPress || event.defaultPrevented) return;
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (pressIsOutsideOwnSurface(event)) return;
      const control = event.currentTarget;
      const pointerId = event.pointerId;
      pressedControl = control;
      let undo: void | PressUndo;
      const stopListening = () => {
        window.removeEventListener("pointerup", onPointerEnd, true);
        window.removeEventListener("pointercancel", onPointerEnd, true);
        window.removeEventListener("dragstart", onDragStart, true);
        window.removeEventListener("dragend", stopListening, true);
        window.removeEventListener("pointerdown", onNextPress, true);
      };
      // A press whose release never arrived is over when the next one begins.
      const onNextPress = () => {
        stopListening();
        if (pressedControl === control) pressedControl = null;
      };
      const onDragStart = () => {
        const revert = undo;
        undo = undefined;
        revert?.();
      };
      const onPointerEnd = (ended: PointerEvent) => {
        if (ended.pointerId !== pointerId) return;
        // The click of this press is dispatched right after its pointerup, in
        // the same task. Forget the press in the next one.
        window.setTimeout(() => {
          if (pressedControl === control) pressedControl = null;
        }, 0);
        // A release ends the press, and no drag can follow it. A cancelled
        // pointer is how a native drag starts; browsers differ on whether it
        // comes before or after `dragstart`, so keep that listener until the
        // drag ends or the next press begins.
        if (ended.type === "pointerup") stopListening();
      };
      window.addEventListener("pointerup", onPointerEnd, true);
      window.addEventListener("pointercancel", onPointerEnd, true);
      window.addEventListener("dragstart", onDragStart, true);
      window.addEventListener("dragend", stopListening, true);
      // This press is already past the window's capture phase, so only a later
      // press reaches this listener.
      window.addEventListener("pointerdown", onNextPress, true);
      undo = action(event);
    },
    onClick(event) {
      if (pressedControl === event.currentTarget) {
        pressedControl = null;
        return;
      }
      action(event);
    },
  };
}
