import React from "react";

import { useHostEnginePaint } from "./hostEngineStore";

/**
 * The host's own engine, painted over a plugin page at the rect the page asked
 * for.
 *
 * Absolutely positioned inside the page host's own box, so it moves with the
 * pane and cannot be positioned relative to anything else. It sits ABOVE the
 * guest deliberately: an engine the page could draw over would be an engine the
 * page could put a transparent layer on top of and harvest clicks from, which
 * is the whole reason input stays host-side.
 *
 * `pointerEvents` is left at the browser default rather than disabled: the
 * engine IS interactive — the inspector takes clicks, the simulator takes taps
 * — and it is host code receiving them, in the host's own component, with the
 * page nowhere in the path.
 *
 * Nothing is drawn when there is no placement, no registered engine, or no
 * intersection with the frame. All three are ordinary states — the page has not
 * measured yet, the surface offering the engine is not on screen, the hole is
 * scrolled out of view — and the honest rendering of each is nothing at all.
 */
export function HostEngineOverlay({ guestKey }: { guestKey: string | null }) {
  const paint = useHostEnginePaint(guestKey);
  if (!paint) return null;
  return (
    <div
      data-host-engine={paint.engineId}
      style={{
        position: "absolute",
        left: paint.rect.x,
        top: paint.rect.y,
        width: paint.rect.width,
        height: paint.rect.height,
        // Above the guest, and clipped to the rect the page asked for: an
        // engine that overflowed its hole would be drawing over the page's own
        // chrome, which is the mirror of the rule that keeps it inside the
        // frame.
        zIndex: 2,
        overflow: "hidden",
        display: "flex",
        minHeight: 0,
        minWidth: 0,
      }}
    >
      {paint.render()}
    </div>
  );
}

export default HostEngineOverlay;
