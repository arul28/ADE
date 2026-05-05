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
  shouldIgnore?: (target: Node) => boolean,
): void {
  useEffect(() => {
    if (!active) return;
    const handler = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (shouldIgnore?.(target)) return;
      if (ref.current && !ref.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [active, ref, onClose, shouldIgnore]);
}
