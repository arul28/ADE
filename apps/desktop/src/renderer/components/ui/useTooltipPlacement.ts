import { useLayoutEffect, useState, type RefObject } from "react";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../lib/webZoom";
import { computeTooltipPosition, type TooltipPlacement, type TooltipSide } from "./tooltipPosition";

/**
 * Places a `position: fixed`, portalled tooltip next to its trigger with
 * `computeTooltipPosition` (flip, then shift, never over the trigger).
 *
 * For hand-built hover cards whose content is too custom for `SmartTooltip` or
 * `PaneTooltip`. Render the tooltip with `visibility: hidden` until this
 * returns a placement, so it never paints in the corner first. Pass anything
 * that changes the tooltip's size as `remeasureKey`.
 */
export function useTooltipPlacement({
  open,
  triggerRef,
  tooltipRef,
  side = "top",
  gap,
  pad,
  remeasureKey = null,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  tooltipRef: RefObject<HTMLElement | null>;
  side?: TooltipSide;
  gap?: number;
  pad?: number;
  remeasureKey?: unknown;
}): TooltipPlacement | null {
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);

  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const tooltip = tooltipRef.current;
    if (!open || !trigger || !tooltip) {
      setPlacement(null);
      return;
    }
    // Measured rects are screen px; convert the trigger, tooltip and window into
    // the frame the tooltip is written in (the body, or a transformed dialog).
    const frame = fixedFrameOf(tooltip.parentElement);
    const triggerBox = fixedRect(frame, trigger.getBoundingClientRect());
    const tooltipBox = fixedRect(frame, tooltip.getBoundingClientRect());
    const viewport = fixedViewport(frame);
    const next = computeTooltipPosition({
      preferredSide: side,
      trigger: {
        top: triggerBox.top,
        left: triggerBox.left,
        right: triggerBox.right,
        bottom: triggerBox.bottom,
        width: triggerBox.width,
        height: triggerBox.height,
      },
      tooltip: { width: tooltipBox.width, height: tooltipBox.height },
      viewport: { width: viewport.width, height: viewport.height },
      gap,
      pad,
    });
    setPlacement((prev) => (
      prev && prev.x === next.x && prev.y === next.y && prev.side === next.side ? prev : next
    ));
  }, [open, side, gap, pad, remeasureKey, triggerRef, tooltipRef]);

  return placement;
}
