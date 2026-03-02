import { useEffect, type RefObject } from "react";

/**
 * Calls `onClose` when a mousedown event lands outside the element
 * referenced by `ref`, but only while `active` is true.
 * Cleans up the listener when `active` flips to false or on unmount.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  active: boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, ref, onClose]);
}
