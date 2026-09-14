import React from "react";

/**
 * The CTO's mark.
 *
 * One glyph, used everywhere the CTO is named — the tab rail, the thread
 * header, the call HUD. A tab gets a stock icon; the one colleague in ADE that
 * has a name gets a mark of its own.
 *
 * It is a compass needle, because that is the job: the CTO holds the whole
 * project in view and points at the thing that matters next. Deliberately not a
 * brain (lumpy and illegible at 16px, and every AI product has one) and not a
 * four-point sparkle (the same, minus the lump).
 *
 * Geometry is a needle on a 45° axis about the centre, drawn as two triangles
 * meeting at the waist: the leading half solid, the trailing half faint. That
 * asymmetry is what makes it read as *pointing* rather than as a diamond, and
 * it survives being drawn at 14px.
 */

export type CtoMarkProps = {
  size?: number;
  /**
   * Draw the ring. Turn it off when the mark already sits in a frame — a ring
   * inside a rounded chip is two borders arguing.
   *
   * The needle grows to fill the space when the ring goes, because a needle
   * sized for the inside of a ring reads as a speck without one.
   */
  ring?: boolean;
  className?: string;
  style?: React.CSSProperties;
  title?: string;
  /**
   * Accepted and ignored, so the mark is a drop-in wherever a Phosphor icon
   * goes — the tab rail renders every icon with `weight="regular"`. This mark
   * has one weight on purpose: an identity that changes shape is not one.
   */
  weight?: string;
};

export function CtoMark({ size = 18, ring = true, className, style, title }: CtoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {ring ? (
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="1.4"
          opacity="0.32"
        />
      ) : null}
      <g transform={ring ? undefined : "translate(12 12) scale(1.5) translate(-12 -12)"}>
        {/* Leading half — the direction the needle points. */}
        <path d="M16.38 7.62 L13.34 13.34 L10.66 10.66 Z" fill="currentColor" />
        {/* Trailing half — present, but never competing with the point. */}
        <path d="M7.62 16.38 L13.34 13.34 L10.66 10.66 Z" fill="currentColor" opacity="0.38" />
      </g>
    </svg>
  );
}
