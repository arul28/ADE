import { useCallback, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";

/**
 * A switch control acts on the press, not on the release.
 *
 * A click fires on mouse-up, 60 to 120 ms after the button went down. For a
 * control that only changes what is on screen (a chat row, a project tab, a
 * page tab) that hold is most of what the switch costs the reader; see "press
 * to content" in docs/perf/macos-baseline.md.
 *
 * Only a plain mouse press acts early: the primary button, no modifier key, on
 * the control itself. Everything else keeps the click:
 * - touch and pen, where a press can be the start of a scroll;
 * - the keyboard and assistive technology, which send a click with no press;
 * - a modified click (range and toggle selection; Ctrl+click opens the context
 *   menu on macOS and sends no click at all);
 * - a press on a control nested in this one (a close button, a link), which
 *   has its own click.
 */
const NESTED_CONTROL_SELECTOR =
  "button, a[href], input, select, textarea, [role='button'], [role='link'], [role='menuitem'], [contenteditable='true']";

export type PressActivationEvent = ReactMouseEvent<HTMLElement> | ReactPointerEvent<HTMLElement>;

/**
 * What a press-activated control does. It may return how to undo itself; the
 * undo runs when the press turns into a native drag, so that dragging a row
 * does not also switch to it.
 */
export type PressActivation = (event: PressActivationEvent) => void | (() => void);

export type PressActivationProps = {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onClick: (event: ReactMouseEvent<HTMLElement>) => void;
};

/** The primary mouse button with no modifier key held. */
export function isPlainMousePress(event: {
  pointerType?: string;
  button: number;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): boolean {
  return event.pointerType === "mouse"
    && event.button === 0
    && !event.ctrlKey
    && !event.metaKey
    && !event.shiftKey
    && !event.altKey;
}

function pressIsOnNestedControl(event: ReactPointerEvent<HTMLElement>): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const control = target.closest(NESTED_CONTROL_SELECTOR);
  return control != null && control !== event.currentTarget && event.currentTarget.contains(control);
}

/**
 * Returns `press(activate, onPress)`, which gives the `onPointerDown` and
 * `onClick` of one control. One hook serves every control of a component (a
 * list of tabs), because a mouse holds one button on one control at a time.
 * Pass `onPress: false` while the control must wait for the click.
 */
export function usePressActivation(): (activate: PressActivation, onPress?: boolean) => PressActivationProps {
  // The control whose press already activated, until that press is over. The
  // click of the same press must not activate again.
  const pressedRef = useRef<Element | null>(null);

  return useCallback((activate, onPress = true) => ({
    onPointerDown(event) {
      if (!onPress || event.defaultPrevented || !isPlainMousePress(event) || pressIsOnNestedControl(event)) return;
      const control = event.currentTarget;
      pressedRef.current = control;
      let undo: void | (() => void);
      const revert = () => {
        const revertPress = undo;
        undo = undefined;
        revertPress?.();
      };
      const finish = () => {
        window.removeEventListener("pointerup", finish, true);
        window.removeEventListener("pointercancel", finish, true);
        window.removeEventListener("dragend", finish, true);
        window.removeEventListener("blur", finish);
        // The click of this press is dispatched right after its pointerup, and
        // a native drag cancels the pointer in the task that starts it. Both
        // belong to this press, so forget the press in the next task.
        window.setTimeout(() => {
          window.removeEventListener("dragstart", revert, true);
          if (pressedRef.current === control) pressedRef.current = null;
        }, 0);
      };
      window.addEventListener("pointerup", finish, true);
      window.addEventListener("pointercancel", finish, true);
      window.addEventListener("dragstart", revert, true);
      window.addEventListener("dragend", finish, true);
      window.addEventListener("blur", finish);
      undo = activate(event);
    },
    onClick(event) {
      if (pressedRef.current === event.currentTarget) {
        pressedRef.current = null;
        return;
      }
      activate(event);
    },
  }), []);
}
