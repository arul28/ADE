import { fixedFrameOf, fixedPoint, fixedViewport } from "./webZoom";

/**
 * Place a `position: fixed` menu above an anchor. The anchor rect is a screen
 * rect, and `left`/`top` are written in the frame the menu is placed in
 * (`fixedFrameOf`): the viewport under hosted web's body zoom, or the transformed
 * container the menu renders into. Converting the rect there keeps the menu on
 * its anchor, where a raw rect written as a style would be zoomed twice.
 *
 * `top: anchor.top` plus `translateY(calc(-100% - gap))` keeps the gap in style
 * pixels, and the percentage is the menu's own height, so callers do not have to
 * measure first.
 */

export type FixedMenuAboveAnchorStyle = {
  left: number;
  top: number;
  width: number;
  transform: string;
};

export function fixedMenuAboveAnchorStyle(
  rect: { left: number; top: number; right: number; bottom?: number },
  options: {
    width: number;
    gap?: number;
    gutter?: number;
    align?: "start" | "end";
    /** The element the menu renders into, when it is not the body. */
    container?: Element | null;
    /**
     * Opens below the anchor instead (needs `rect.bottom`): for a caller that
     * measured no room above, such as a pill near the top of a dialog.
     */
    below?: boolean;
  },
): FixedMenuAboveAnchorStyle {
  const gap = options.gap ?? 8;
  const gutter = options.gutter ?? 8;
  const frame = fixedFrameOf(options.container ?? null);
  const viewport = fixedViewport(frame);
  const anchorLeft = fixedPoint(frame, rect.left, rect.top).left;
  const anchorRight = fixedPoint(frame, rect.right, rect.top).left;
  const anchorTop = fixedPoint(frame, rect.left, rect.top).top;
  const rawLeft = options.align === "end" ? anchorRight - options.width : anchorLeft;
  const minLeft = viewport.left + gutter;
  const maxLeft = Math.max(minLeft, viewport.right - options.width - gutter);
  const left = Math.min(Math.max(minLeft, rawLeft), maxLeft);
  if (options.below && rect.bottom != null) {
    return {
      left,
      top: fixedPoint(frame, rect.left, rect.bottom).top,
      width: options.width,
      transform: `translateY(${gap}px)`,
    };
  }
  return {
    left,
    top: anchorTop,
    width: options.width,
    transform: `translateY(calc(-100% - ${gap}px))`,
  };
}
