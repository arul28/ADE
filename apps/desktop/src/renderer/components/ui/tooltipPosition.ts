/**
 * Collision-aware placement for a tooltip anchored to a trigger rect.
 *
 * Pure so it can be tested without a layout engine: everything it needs — the
 * trigger box, the tooltip box, and the viewport — is passed in. Two rules the
 * pane's tooltips depend on:
 *
 * 1. **Flip before shift.** A tooltip that would leave the window flips to the
 *    opposite side if that side fits; only then is it shifted along its cross
 *    axis. Shifting first is what produced the clipped "Clos" — a tooltip
 *    pinned to the window edge, half of it outside the pane.
 * 2. **Never over the trigger.** The returned rect is guaranteed not to
 *    overlap the trigger, so a tooltip can't cover the control it describes.
 *    When no side has room the tooltip is placed on the roomiest side and
 *    pushed flush against the trigger rather than on top of it.
 */

export type TooltipSide = "top" | "bottom" | "left" | "right";

export type TooltipRect = {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
};

export type TooltipPlacement = {
  /** Window coordinates of the tooltip's top-left corner. */
  x: number;
  y: number;
  side: TooltipSide;
};

export type TooltipPositionInput = {
  preferredSide: TooltipSide;
  trigger: TooltipRect;
  tooltip: { width: number; height: number };
  viewport: { width: number; height: number };
  /** Distance between trigger edge and tooltip edge. */
  gap?: number;
  /** Minimum distance the tooltip keeps from the window edges. */
  pad?: number;
};

/** Trigger → tooltip. Small enough to read as attached to the control. */
const DEFAULT_GAP = 6;
/** Tooltip → window edge. Never zero: a tooltip flush to the glass reads clipped. */
const DEFAULT_PAD = 8;

const OPPOSITE: Record<TooltipSide, TooltipSide> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

function clamp(value: number, min: number, max: number): number {
  // A tooltip wider than the window has min > max; keeping `min` means the
  // left/top edge stays visible, which is the half that carries the text.
  if (min > max) return min;
  return Math.min(Math.max(value, min), max);
}

/** Free space between the trigger and the window edge on one side. */
function spaceOn(side: TooltipSide, trigger: TooltipRect, viewport: { width: number; height: number }): number {
  switch (side) {
    case "top":
      return trigger.top;
    case "bottom":
      return viewport.height - trigger.bottom;
    case "left":
      return trigger.left;
    case "right":
      return viewport.width - trigger.right;
  }
}

function fitsOn(
  side: TooltipSide,
  trigger: TooltipRect,
  tooltip: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number,
  pad: number,
): boolean {
  const needed = (side === "top" || side === "bottom" ? tooltip.height : tooltip.width) + gap + pad;
  return spaceOn(side, trigger, viewport) >= needed;
}

export function resolveTooltipSide(input: TooltipPositionInput): TooltipSide {
  const { preferredSide, trigger, tooltip, viewport } = input;
  const gap = input.gap ?? DEFAULT_GAP;
  const pad = input.pad ?? DEFAULT_PAD;
  if (fitsOn(preferredSide, trigger, tooltip, viewport, gap, pad)) return preferredSide;
  const opposite = OPPOSITE[preferredSide];
  if (fitsOn(opposite, trigger, tooltip, viewport, gap, pad)) return opposite;
  // Neither the preferred axis nor its flip has room. Try the cross axis before
  // giving up, then fall back to whichever side is roomiest.
  const crossAxis: TooltipSide[] = preferredSide === "top" || preferredSide === "bottom"
    ? ["right", "left"]
    : ["bottom", "top"];
  for (const side of crossAxis) {
    if (fitsOn(side, trigger, tooltip, viewport, gap, pad)) return side;
  }
  const all: TooltipSide[] = ["top", "bottom", "left", "right"];
  return all.reduce((best, side) => (
    spaceOn(side, trigger, viewport) > spaceOn(best, trigger, viewport) ? side : best
  ), preferredSide);
}

export function computeTooltipPosition(input: TooltipPositionInput): TooltipPlacement {
  const { trigger, tooltip, viewport } = input;
  const gap = input.gap ?? DEFAULT_GAP;
  const pad = input.pad ?? DEFAULT_PAD;
  const side = resolveTooltipSide(input);

  const centerX = trigger.left + trigger.width / 2 - tooltip.width / 2;
  const centerY = trigger.top + trigger.height / 2 - tooltip.height / 2;
  const maxX = viewport.width - pad - tooltip.width;
  const maxY = viewport.height - pad - tooltip.height;

  switch (side) {
    case "top":
      return {
        side,
        x: clamp(centerX, pad, maxX),
        // `Math.min` keeps the bottom edge above the trigger even when the
        // clamp would otherwise push the tooltip down over it.
        y: Math.min(clamp(trigger.top - gap - tooltip.height, pad, maxY), trigger.top - tooltip.height),
      };
    case "bottom":
      return {
        side,
        x: clamp(centerX, pad, maxX),
        y: Math.max(clamp(trigger.bottom + gap, pad, maxY), trigger.bottom),
      };
    case "left":
      return {
        side,
        x: Math.min(clamp(trigger.left - gap - tooltip.width, pad, maxX), trigger.left - tooltip.width),
        y: clamp(centerY, pad, maxY),
      };
    case "right":
      return {
        side,
        x: Math.max(clamp(trigger.right + gap, pad, maxX), trigger.right),
        y: clamp(centerY, pad, maxY),
      };
  }
}

/** True when the two boxes share any area — the invariant a tooltip must not break. */
export function rectsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: TooltipRect,
): boolean {
  return a.x < b.right && a.x + a.width > b.left && a.y < b.bottom && a.y + a.height > b.top;
}
