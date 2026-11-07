import { useEffect } from "react";
import { isImeComposing } from "./imeComposition";

/**
 * Escape cancels and Enter confirms a confirm dialog.
 *
 * The keys are bound at the window, because a click on the dialog's text
 * moves focus off the buttons, and a panel handler then never sees the key.
 * Capture and stopPropagation keep the Work page's own Escape handlers away
 * from the key that answered the question. A focused button answers Enter
 * itself. Leave out `onConfirm` when Enter must do nothing.
 */
export function useConfirmKeys(onCancel: () => void, onConfirm?: () => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (!onConfirm || event.key !== "Enter" || event.shiftKey || isImeComposing(event)) return;
      if ((event.target as HTMLElement | null)?.tagName?.toLowerCase() === "button") return;
      event.preventDefault();
      onConfirm();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm]);
}
