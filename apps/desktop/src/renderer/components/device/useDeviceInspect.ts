import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Inspect state every device pane shares (Apple and Android): the switch, one
 * snapshot of the screen's elements per switch-on, and the hovered and
 * selected element. Each pane draws its own overlay from this.
 *
 * Driving the device is off while Inspect is on, so the snapshot cannot go
 * stale under the pointer. Escape clears the selection wherever the focus is.
 */
export function useDeviceInspect<E>({
  live,
  takeSnapshot,
  offOnError = false,
  onSnapshot,
  onError,
}: {
  /** The device is streaming; a snapshot is only taken then. */
  live: boolean;
  /**
   * Must be stable for one device (a `useCallback` keyed on the lane and
   * device): a new function takes a new snapshot while Inspect is on.
   */
  takeSnapshot: () => Promise<E[]>;
  /** Turn Inspect off when the snapshot fails, instead of leaving it on empty. */
  offOnError?: boolean;
  /** Each snapshot that is still current, for what else it tells (the orientation). */
  onSnapshot?: ((elements: E[]) => void) | undefined;
  onError: (cause: unknown) => void;
}): {
  inspectOn: boolean;
  toggleInspect: () => void;
  elements: E[];
  hovered: string | null;
  setHovered: (id: string | null) => void;
  selected: string | null;
  setSelected: (id: string | null) => void;
  /** Read through a ref, so a new closure from the pane never re-takes a snapshot. */
  onErrorRef: { readonly current: (cause: unknown) => void };
} {
  const [inspectOn, setInspectOn] = useState(false);
  const [elements, setElements] = useState<E[]>([]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;

  const toggleInspect = useCallback(() => {
    setInspectOn((on) => !on);
    setSelected(null);
    setHovered(null);
  }, []);

  useEffect(() => {
    if (!inspectOn || !live) {
      if (!inspectOn) setElements([]);
      return undefined;
    }
    let cancelled = false;
    void takeSnapshot()
      .then((next) => {
        if (cancelled) return;
        setElements(next);
        onSnapshotRef.current?.(next);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        onErrorRef.current(cause);
        if (offOnError) setInspectOn(false);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectOn, live, offOnError, takeSnapshot]);

  useEffect(() => {
    if (!selected) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected]);

  return { inspectOn, toggleInspect, elements, hovered, setHovered, selected, setSelected, onErrorRef };
}
