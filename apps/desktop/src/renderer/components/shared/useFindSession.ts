/**
 * The lifecycle every floating ⌘F bar shares (chat transcript, diff):
 * claiming the `find` menu command when its scope owns ⌘F, putting the caret
 * in the field, giving focus back on close, ⌘G / ⇧⌘G / Escape while open, and
 * the paint frame — coalesced to one per frame, cancelled and cleared on close
 * and unmount. Each surface keeps only its own matching and painting.
 */
import { useCallback, useEffect, useId, useRef, useState, type MutableRefObject } from "react";
import { claimAppMenuCommands } from "../../lib/appMenuCommands";
import { trackFindTargets } from "../../lib/findScope";
import { focusFindInput, publishFindHighlights } from "../../lib/findText";
import { eventMatchesBinding } from "../../lib/keybindings";

type FindSession = {
  open: boolean;
  /** Read in callbacks that must not wait for a render. */
  openRef: MutableRefObject<boolean>;
  inputRef: MutableRefObject<HTMLInputElement | null>;
  /** A stable id to publish this surface's highlights under. */
  surfaceId: string;
  openBar: () => void;
  closeBar: () => void;
  /** Run the surface's `paint` on the next frame; repeated calls in one frame paint once. */
  schedulePaint: () => void;
};

export function useFindSession({
  ownsFind,
  onStep,
  onClosed,
  paint,
  escapeRootRef,
  openedByShortcut,
}: {
  /** True when ⌘F, ⌘G and Escape belong to this surface right now. */
  ownsFind: () => boolean;
  onStep: (direction: 1 | -1) => void;
  /** Clear the surface's own match state; runs before focus is given back. */
  onClosed: () => void;
  /** Find the matches and publish highlights under `surfaceId`. */
  paint: () => void;
  /** Escape pressed from inside this element (not the field) also closes the bar. */
  escapeRootRef: MutableRefObject<HTMLElement | null>;
  /** Called when ⌘F opens the bar. Not when ⌘F lands on a bar already open, nor for other openers. */
  openedByShortcut?: () => void;
}): FindSession {
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const surfaceId = useId();
  const ownsFindRef = useRef(ownsFind);
  ownsFindRef.current = ownsFind;
  const openedByShortcutRef = useRef(openedByShortcut);
  openedByShortcutRef.current = openedByShortcut;
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const paintRef = useRef(paint);
  paintRef.current = paint;
  const frameRef = useRef<number | null>(null);

  const cancelPaint = useCallback(() => {
    if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
    // Cleared, not just cancelled: a remount (React's dev double mount, a
    // parked surface coming back) must be able to schedule again.
    frameRef.current = null;
  }, []);

  const schedulePaint = useCallback(() => {
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      paintRef.current();
    });
  }, []);

  const openBar = useCallback(() => {
    if (!openRef.current) {
      const active = document.activeElement;
      restoreFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
      openRef.current = true;
      setOpen(true);
    }
    focusFindInput(inputRef);
  }, []);

  const closeBar = useCallback(() => {
    openRef.current = false;
    setOpen(false);
    cancelPaint();
    onClosedRef.current();
    publishFindHighlights(surfaceId, null);
    const restore = restoreFocusRef.current;
    restoreFocusRef.current = null;
    if (restore?.isConnected) restore.focus({ preventScroll: true });
  }, [cancelPaint, surfaceId]);

  useEffect(() => () => {
    cancelPaint();
    publishFindHighlights(surfaceId, null);
  }, [cancelPaint, surfaceId]);

  useEffect(() => {
    trackFindTargets();
    return claimAppMenuCommands((command) => {
      if (command !== "find" || !ownsFindRef.current()) return false;
      const wasOpen = openRef.current;
      openBar();
      if (!wasOpen) openedByShortcutRef.current?.();
      return true;
    });
  }, [openBar]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        const target = event.target;
        const root = escapeRootRef.current;
        const fromSurface = target === document.body || (target instanceof Node && Boolean(root?.contains(target)));
        if (!fromSurface || !ownsFindRef.current()) return;
        event.preventDefault();
        closeBar();
        return;
      }
      const forward = eventMatchesBinding(event, "Mod+G");
      if (!forward && !eventMatchesBinding(event, "Mod+Shift+G")) return;
      if (!ownsFindRef.current()) return;
      event.preventDefault();
      onStepRef.current(forward ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeBar, escapeRootRef, open]);

  return { open, openRef, inputRef, surfaceId, openBar, closeBar, schedulePaint };
}
