import { useCallback, useEffect, type KeyboardEvent, type RefObject } from "react";

/**
 * The app's one focus trap for surfaces that are not Radix dialogs.
 *
 * Centered modals use `ui/dialog/Dialog`, whose Radix FocusScope is the trap.
 * The top-bar sheets (`HeaderSheet` and the Activity popover in
 * `HeaderActivityControl`) use `useDialogFocusTrap` below, built on
 * `getFocusableElements`: one selector and one set of visibility rules, so no
 * two surfaces disagree about whether a `<summary>`, an `[aria-hidden]` subtree
 * or a closed `<details>` is reachable.
 */
export const DIALOG_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "summary",
  "textarea:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function getFocusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR),
  ).filter((element) => {
    const closedDetails = element.closest<HTMLDetailsElement>(
      "details:not([open])",
    );
    const isClosedDetailsSummary =
      closedDetails?.querySelector(":scope > summary") === element;
    return (
      !element.closest('[hidden], [aria-hidden="true"]') &&
      (!closedDetails || isClosedDetailsSummary) &&
      !element.hasAttribute("disabled") &&
      element.tabIndex >= 0
    );
  });
}

/**
 * Focus the panel on open, close on Escape, and keep Tab / Shift+Tab inside
 * the panel. Returns the panel's `onKeyDown` handler.
 *
 * Keys whose target is outside the panel are ignored: React bubbles events
 * from portaled children (a dialog raised from inside the sheet) through the
 * panel's handler, and those keys belong to that child, not to the sheet.
 */
export function useDialogFocusTrap(
  panelRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  open: boolean,
): (event: KeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, panelRef]);

  return useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = getFocusableElements(panel);
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === panel) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onClose, panelRef],
  );
}
