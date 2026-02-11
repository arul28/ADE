import { useCallback, useEffect, useState } from "react";

export type DockLayout = Record<string, number>;

export function useDockLayout(layoutId: string, fallbackLayout: DockLayout) {
  const [layout, setLayout] = useState<DockLayout>(fallbackLayout);
  const [loaded, setLoaded] = useState(false);

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
    };
  }, [layoutId]);

  const saveLayout = useCallback(
    (next: DockLayout) => {
      setLayout(next);
      window.ade.layout.set(layoutId, next).catch(() => {
        // Non-fatal; persistence failures should not break resizing.
      });
    },
    [layoutId]
  );

  return { layout, loaded, saveLayout };
}

