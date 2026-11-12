import { useCallback, useEffect, useRef, useState } from "react";
import { readClientLayout, writeClientLayout } from "./clientLayoutStore";

export type DockLayout = Record<string, number>;
type DockLayoutUpdater = DockLayout | ((prev: DockLayout) => DockLayout);

function isDockLayout(value: unknown): value is DockLayout {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function useDockLayout(layoutId: string, fallbackLayout: DockLayout) {
  const [layout, setLayout] = useState<DockLayout>(fallbackLayout);
  const [loaded, setLoaded] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Buffer resize updates in a ref so we don't re-render on every drag frame.
     State + persistence commit after the resize gesture settles. */
  const pendingRef = useRef<DockLayout | null>(null);
  const layoutRef = useRef<DockLayout>(fallbackLayout);
  layoutRef.current = layout;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    // This client's layout (see `clientLayoutStore`), never a machine's.
    void readClientLayout("dock", layoutId)
      .then((value) => {
        if (cancelled) return;
        const saved = isDockLayout(value) ? value : null;
        if (saved) {
          setLayout(saved);
          layoutRef.current = saved;
        }
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setLoaded(true);
      });

    return () => {
      cancelled = true;
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [layoutId]);

  const saveLayout = useCallback(
    (update: DockLayoutUpdater) => {
      const base = pendingRef.current ?? layoutRef.current;
      const next = typeof update === "function" ? update(base) : update;
      pendingRef.current = next;

      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        const final = pendingRef.current;
        if (final) {
          setLayout(final);
          layoutRef.current = final;
          pendingRef.current = null;
          writeClientLayout("dock", layoutId, final);
        }
      }, 150);
    },
    [layoutId]
  );

  return { layout, loaded, saveLayout };
}
