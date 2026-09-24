import { useCallback, useEffect, type KeyboardEventHandler, type RefObject } from "react";

/**
 * The app's one focus trap for surfaces that are not Radix dialogs.
 *
 * Centered modals use `ui/dialog/Dialog`, whose Radix FocusScope is the trap.
 * Everything else that must hold focus — the top-bar sheets (`HeaderSheet`),
 * popover panels, and the few overlays that keep bespoke motion — uses
 * `useDialogFocusTrap` below, or `getFocusableElements` when it needs a
 * window-level handler. One selector and one set of visibility rules, so no two
 * surfaces disagree about whether a `<summary>`, an `[aria-hidden]` subtree or a
 * closed `<details>` is reachable.
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
 */
export function useDialogFocusTrap(
  panelRef: RefObject<HTMLDivElement>,
  onClose: () => void,
  open: boolean,
): KeyboardEventHandler<HTMLDivElement> {
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      panelRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, panelRef]);

  return useCallback(
    (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
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
