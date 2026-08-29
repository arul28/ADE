/**
 * Place a `position: fixed` menu above an anchor using only the anchor rect
 * for the vertical axis.
 *
 * `bottom: window.innerHeight - rect.top` is correct under Electron webFrame
 * zoom, where innerHeight and getBoundingClientRect share a CSS-pixel space.
 * Hosted web applies CSS `zoom` on <body>: innerHeight stays in viewport
 * pixels, then `bottom` is multiplied by zoom, and the menu jumps to the top
 * of the window. That is why the permission picker (always opens upward)
 * drifted while Radix/model pickers that set `top` from the rect did not.
 *
 * `top: rect.top` plus `translateY(calc(-100% - gap))` keeps the offset in
 * the same zoomed space as the rect, and the percentage is the menu's own
 * height so callers do not have to measure first.
 */

export type FixedMenuAboveAnchorStyle = {
  left: number;
  top: number;
  width: number;
  transform: string;
};

export function fixedMenuAboveAnchorStyle(
  rect: { left: number; top: number; right: number },
  options: {
    width: number;
    gap?: number;
    gutter?: number;
    align?: "start" | "end";
    viewportWidth?: number;
  },
): FixedMenuAboveAnchorStyle {
  const gap = options.gap ?? 8;
  const gutter = options.gutter ?? 8;
  const viewportWidth = options.viewportWidth ?? window.innerWidth;
  const rawLeft = options.align === "end" ? rect.right - options.width : rect.left;
  const maxLeft = Math.max(gutter, viewportWidth - options.width - gutter);
  const left = Math.min(Math.max(gutter, rawLeft), maxLeft);
  return {
    left,
    top: rect.top,
    width: options.width,
    transform: `translateY(calc(-100% - ${gap}px))`,
  };
}
