import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function readInitial(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Subscribes to the `prefers-reduced-motion: reduce` media query.
 *
 * Returns `false` outside of a browser environment.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readInitial);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(QUERY);
    } catch {
      return;
    }
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      setReduced(Boolean(e.matches));
    };
    // Update once in case SSR-rendered default differed from hydrated value.
    handler(mql);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler);
      return () => mql.removeEventListener("change", handler);
    }
    // Legacy Safari.
    const legacy = mql as MediaQueryList & {
      addListener?: (fn: (e: MediaQueryListEvent) => void) => void;
      removeListener?: (fn: (e: MediaQueryListEvent) => void) => void;
    };
    if (typeof legacy.addListener === "function") {
      legacy.addListener(handler);
      return () => legacy.removeListener?.(handler);
    }
    return;
  }, []);

  return reduced;
}
