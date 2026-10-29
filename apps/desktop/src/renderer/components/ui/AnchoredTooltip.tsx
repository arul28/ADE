import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { fixedFrameOf, fixedRect, fixedViewport } from "../../lib/webZoom";
import { usePortalContainer } from "./portalContainer";
import { computeTooltipPosition, type TooltipPlacement, type TooltipSide } from "./tooltipPosition";
import { ViewportOverlayHost } from "./ViewportOverlayHost";

/**
 * A read-only card placed next to a trigger the caller owns: a commit preview
 * on a history row, a help hint, a chart's day readout.
 *
 * For tooltips whose content or trigger is too custom for `SmartTooltip` or
 * `PaneTooltip`; it uses the same placement (`computeTooltipPosition`: flip,
 * then shift, never over the trigger). Rendered on the viewport tooltip layer
 * (or inside the open dialog), so no clipping parent can cut it off. It stays
 * hidden until placed, so it never paints in the corner first.
 *
 * The caller owns `open`. `onDismiss` runs on a scroll or resize while open:
 * the card would otherwise stay put while its trigger moves away. Pass anything
 * that changes the card's size as `remeasureKey`.
 */
export function AnchoredTooltip({
  open,
  triggerRef,
  side = "top",
  remeasureKey = null,
  onDismiss,
  id,
  className,
  style,
  testId,
  children,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  side?: TooltipSide;
  remeasureKey?: unknown;
  onDismiss: () => void;
  id?: string;
  className?: string;
  style?: CSSProperties;
  testId?: string;
  children: ReactNode;
}) {
  const portalContainer = usePortalContainer();
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const placement = useTooltipPlacement({ open, triggerRef, tooltipRef, side, remeasureKey, onDismiss });
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <ViewportOverlayHost layer="tooltip">
      <div
        ref={tooltipRef}
        id={id}
        role="tooltip"
        data-testid={testId}
        className={className}
        style={{
          ...style,
          // The host is a viewport-sized layer, so these are viewport coordinates.
          position: "absolute",
          left: placement?.x ?? 0,
          top: placement?.y ?? 0,
          visibility: placement ? "visible" : "hidden",
        }}
      >
        {children}
      </div>
    </ViewportOverlayHost>,
    portalContainer ?? document.body,
  );
}

function useTooltipPlacement({
  open,
  triggerRef,
  tooltipRef,
  side = "top",
  gap,
  pad,
  remeasureKey = null,
  onDismiss,
}: {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  tooltipRef: RefObject<HTMLElement | null>;
  side?: TooltipSide;
  gap?: number;
  pad?: number;
  remeasureKey?: unknown;
  onDismiss: () => void;
}): TooltipPlacement | null {
  const [placement, setPlacement] = useState<TooltipPlacement | null>(null);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (!open) return;
    const dismiss = () => onDismissRef.current();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [open]);

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
