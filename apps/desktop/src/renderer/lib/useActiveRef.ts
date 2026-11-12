import { useEffect, useRef, type MutableRefObject } from "react";

/**
 * True only while the component is mounted and `active`.
 *
 * For work that ends long after it started (a background create): the code
 * that finishes it reads this to learn whether the user is still on the page,
 * which a kept-alive page cannot tell from being mounted.
 */
export function useActiveRef(active: boolean): MutableRefObject<boolean> {
  const ref = useRef(false);
  useEffect(() => {
    ref.current = active;
    return () => {
      ref.current = false;
    };
  }, [active]);
  return ref;
}
