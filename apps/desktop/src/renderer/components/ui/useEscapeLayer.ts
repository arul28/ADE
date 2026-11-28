import { useEffect, useRef } from "react";

/**
 * Escape closes the innermost open layer only (a dropdown inside a popover,
 * then the popover, then a narrow-window overlay), and never reaches a host
 * dialog behind it, which would otherwise close the whole window. Layers
 * stack in open order.
 *
 * One window listener in capture phase answers Escape for every layer and
 * stops the event there, so the listeners below it never see that press:
 * an `AnchoredMenu` used as a layer (LinearPopover passes its `onClose` here)
 * closes through its layer, not a second time through its own bubble-phase
 * Escape handler, and a Radix dialog's document listener stays quiet. With
 * no layer open the listener is removed and those handlers work as before.
 */
const escapeLayers: Array<() => void> = [];

function onEscapeCapture(event: KeyboardEvent): void {
  if (event.key !== "Escape" || escapeLayers.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  escapeLayers[escapeLayers.length - 1]!();
}

/** Escape closes this layer (innermost first) instead of whatever is behind it. */
export function useEscapeLayer(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return undefined;
    const layer = () => closeRef.current();
    if (escapeLayers.length === 0) window.addEventListener("keydown", onEscapeCapture, true);
    escapeLayers.push(layer);
    return () => {
      const index = escapeLayers.lastIndexOf(layer);
      if (index >= 0) escapeLayers.splice(index, 1);
      if (escapeLayers.length === 0) window.removeEventListener("keydown", onEscapeCapture, true);
    };
  }, [active]);
}
