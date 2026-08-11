import { useEffect, useState } from "react";

/**
 * `prefers-contrast: more`, the counterpart to `usePrefersReducedMotion`.
 *
 * Same shape and same reasoning as that hook: plain `matchMedia`, no dependency
 * on an animation library, and the initial value read synchronously so the
 * first paint already honours the preference rather than flashing the default.
 */
export function usePrefersMoreContrast(): boolean {
  const query = "(prefers-contrast: more)";
  const [more, setMore] = useState(() =>
    typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(query).matches);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(query);
    const onChange = () => setMore(media.matches);
    media.addEventListener?.("change", onChange);
    return () => media.removeEventListener?.("change", onChange);
  }, []);

  return more;
}
