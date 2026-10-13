import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { cssZoomOf } from "../../lib/webZoom";

export type SelectionAnchor<T> = {
  selection: T;
  /** Where a toolbar of the given width sits: right of the selection's end, above it. */
  left: number;
  top: number;
};

/**
 * Follows the text selection for a small toolbar that acts on it (the chat's
 * and the PR thread's "Add to chat").
 *
 * `read` returns the selection this toolbar accepts, with the rect of its last
 * line, or null. It runs on every selection change and mouse-up. Scrolling and
 * resizing only move a toolbar that is already open: they cannot change the
 * selection, and a streaming transcript scrolls itself many times a second.
 * Escape closes it.
 */
export function useSelectionAnchor<T extends { rect: DOMRect }>(
  enabled: boolean,
  read: () => T | null,
  toolbarWidth: number,
): [SelectionAnchor<T> | null, () => void] {
  const [anchor, setAnchor] = useState<SelectionAnchor<T> | null>(null);
  const showingRef = useRef(false);
  showingRef.current = anchor != null;
  // The latest reader and width, so the listeners stay subscribed across renders.
  const latest = useRef({ read, toolbarWidth });
  latest.current = { read, toolbarWidth };

  useLayoutEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }
    const sync = () => {
      try {
        const next = latest.current.read();
        if (!next) {
          setAnchor(null);
          return;
        }
        // Rects are zoomed under the hosted web client's body zoom; styles are
        // not (see `cssZoomOf`).
        const zoom = cssZoomOf();
        const width = latest.current.toolbarWidth;
        setAnchor({
          selection: next,
          left: Math.min(Math.max(8, next.rect.right / zoom + 8), Math.max(8, window.innerWidth / zoom - width - 8)),
          top: Math.max(8, next.rect.top / zoom - 36),
        });
      } catch {
        setAnchor(null);
      }
    };
    const onScrollOrResize = () => {
      if (showingRef.current) sync();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAnchor(null);
    };
    document.addEventListener("selectionchange", sync);
    document.addEventListener("mouseup", sync);
    window.addEventListener("resize", onScrollOrResize);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("selectionchange", sync);
      document.removeEventListener("mouseup", sync);
      window.removeEventListener("resize", onScrollOrResize);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled]);

  const clear = useCallback(() => {
    window.getSelection()?.removeAllRanges();
    setAnchor(null);
  }, []);
  return [anchor, clear];
}
