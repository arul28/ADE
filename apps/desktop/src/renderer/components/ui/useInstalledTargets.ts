import { useEffect, useState } from "react";

/**
 * The three answers a "what is installed on this machine" detector can give.
 * `items` is null until the detector settles, so "still looking" and "found
 * nothing" stay distinguishable — an empty list is a real answer.
 */
export type InstalledTargets<T> = {
  items: T[] | null;
  error: string | null;
};

/**
 * Run one of the app namespace's detector methods.
 *
 * Both "Open in ▸" submenus ask the same question of the same bridge shape:
 * is the method there at all (the hosted-web client implements none of them),
 * what did it return, and did it fail. Only the payload differs, so only the
 * payload is a parameter. `detector` must be a stable reference — pass the
 * bridge method itself, not a wrapper.
 */
export function useInstalledTargets<T>(
  detector: (() => Promise<T[]>) | undefined,
): InstalledTargets<T> {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof detector !== "function") {
      // No bridge here: a platform where this menu has nothing extra to offer.
      setItems([]);
      return;
    }
    let cancelled = false;
    void detector()
      .then((found) => {
        if (!cancelled) setItems(found);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setItems([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [detector]);

  return { items, error };
}
