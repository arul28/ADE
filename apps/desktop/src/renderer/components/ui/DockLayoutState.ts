import { useCallback, useEffect, useRef, useState } from "react";

export type DockLayout = Record<string, number>;
type DockLayoutUpdater = DockLayout | ((prev: DockLayout) => DockLayout);

export function useDockLayout(layoutId: string, fallbackLayout: DockLayout) {
  const [layout, setLayout] = useState<DockLayout>(fallbackLayout);
  const [loaded, setLoaded] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    window.ade.layout
      .get(layoutId)
      .then((saved) => {
        if (cancelled) return;
        if (saved) setLayout(saved);
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
      setLayout((prev) => {
        const next = typeof update === "function" ? update(prev) : update;
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
        persistTimerRef.current = setTimeout(() => {
          window.ade.layout.set(layoutId, next).catch(() => {
            // Non-fatal; persistence failures should not break resizing.
          });
        }, 120);
        return next;
      });
    },
    [layoutId]
  );

  return { layout, loaded, saveLayout };
}
