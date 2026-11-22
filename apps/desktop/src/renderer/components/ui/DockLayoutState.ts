import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../../state/appStore";
import { clientLayoutScope, readClientLayout, writeClientLayout } from "./clientLayoutStore";

export type DockLayout = Record<string, number>;
type DockLayoutUpdater = DockLayout | ((prev: DockLayout) => DockLayout);

function isDockLayout(value: unknown): value is DockLayout {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function useDockLayout(layoutId: string, fallbackLayout: DockLayout) {
  const [layout, setLayout] = useState<DockLayout>(fallbackLayout);
  const [loaded, setLoaded] = useState(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The repository of the surface that owns this layout (its own store), so a
  // delayed save stays with it after another tab comes to the front.
  const binding = useAppStore((state) => state.projectBinding);
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  // The read follows the layout's repository scope, which can change for the
  // same binding key once a local folder's origin is known.
  const layoutScope = clientLayoutScope(binding);
  /* Buffer resize updates in a ref so we don't re-render on every drag frame.
     State + persistence commit after the resize gesture settles. */
  const pendingRef = useRef<DockLayout | null>(null);
  const layoutRef = useRef<DockLayout>(fallbackLayout);
  layoutRef.current = layout;

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    // This client's layout (see `clientLayoutStore`), never a machine's.
    void readClientLayout("dock", layoutId, bindingRef.current)
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
  }, [layoutScope, layoutId]);

  const saveLayout = useCallback(
    (update: DockLayoutUpdater) => {
      const base = pendingRef.current ?? layoutRef.current;
      const next = typeof update === "function" ? update(base) : update;
      pendingRef.current = next;

      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      const owner = bindingRef.current;
      persistTimerRef.current = setTimeout(() => {
        const final = pendingRef.current;
        if (final) {
          setLayout(final);
          layoutRef.current = final;
          pendingRef.current = null;
          writeClientLayout("dock", layoutId, final, owner);
        }
      }, 150);
    },
    [layoutId]
  );

  return { layout, loaded, saveLayout };
}
