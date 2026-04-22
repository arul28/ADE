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
      setReduced(Boolean((e as MediaQueryListEvent).matches ?? (e as MediaQueryList).matches));
    };
    // Update once in case SSR-rendered default differed from hydrated value.
    handler(mql);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handler as (e: MediaQueryListEvent) => void);
      return () => mql.removeEventListener("change", handler as (e: MediaQueryListEvent) => void);
    }
    // Legacy Safari.
    if (typeof (mql as MediaQueryList & { addListener?: unknown }).addListener === "function") {
      (mql as unknown as { addListener: (fn: (e: MediaQueryListEvent) => void) => void }).addListener(
        handler as (e: MediaQueryListEvent) => void,
      );
      return () => {
        (mql as unknown as { removeListener: (fn: (e: MediaQueryListEvent) => void) => void }).removeListener(
          handler as (e: MediaQueryListEvent) => void,
        );
      };
    }
    return;
  }, []);

  return reduced;
}
