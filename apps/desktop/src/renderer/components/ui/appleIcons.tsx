import React from "react";
import type { Icon, IconProps } from "@phosphor-icons/react";

/**
 * The Apple Development tool's own glyphs.
 *
 * Phosphor owns every other tool icon, and the catalogue types them as its
 * `Icon`, so these are built to the same contract: a forwarded `<svg>` that
 * takes `size`, paints in `currentColor`, and quietly swallows the props only a
 * Phosphor icon understands (`weight`, `mirrored`, `alt`). A card can swap
 * `DeviceMobile` for `AppleLogo` without knowing which family it came from.
 *
 * Monochrome on purpose. The tools grid is six 16px marks in one ink; an Apple
 * logo in Apple's own colours would be the only branded thing on the page.
 */

type GlyphProps = Omit<IconProps, "weight" | "mirrored" | "alt"> & {
  weight?: IconProps["weight"];
  mirrored?: IconProps["mirrored"];
  alt?: IconProps["alt"];
};

function glyph(
  displayName: string,
  viewBox: string,
  body: React.ReactNode,
): Icon {
  const Component = React.forwardRef<SVGSVGElement, IconProps>(function Glyph(
    { size = 16, color = "currentColor", weight: _weight, mirrored: _mirrored, alt, ...rest }: GlyphProps,
    ref,
  ) {
    return (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        viewBox={viewBox}
        width={size}
        height={size}
        fill={color}
        role={alt ? "img" : undefined}
        aria-label={alt}
        {...rest}
      >
        {alt ? <title>{alt}</title> : null}
        {body}
      </svg>
    );
  });
  Component.displayName = displayName;
  return Component as unknown as Icon;
}

/** The Apple mark. Solid, because the outline of an apple is just an apple. */
export const AppleLogo: Icon = glyph(
  "AppleLogo",
  "0 0 24 24",
  <path d="M17.02 12.64c-.03-2.72 2.22-4.03 2.32-4.09-1.26-1.85-3.23-2.1-3.93-2.13-1.67-.17-3.27.98-4.11.98-.85 0-2.16-.96-3.55-.94-1.82.03-3.5 1.06-4.44 2.69-1.89 3.29-.48 8.16 1.36 10.83.9 1.31 1.97 2.77 3.38 2.72 1.35-.05 1.87-.88 3.5-.88 1.64 0 2.1.88 3.54.85 1.46-.02 2.39-1.33 3.28-2.64 1.03-1.51 1.46-2.98 1.48-3.05-.03-.02-2.84-1.1-2.87-4.34zM14.58 4.6c.74-.9 1.25-2.16 1.11-3.41-1.07.04-2.37.71-3.14 1.61-.7.79-1.3 2.07-1.14 3.29 1.2.09 2.42-.6 3.17-1.49z" />,
);

/**
 * One silhouette per family, at the family's own proportions — the point of a
 * silhouette in the picker is that an iPad does not look like an iPhone from
 * across the pane, so these are deliberately NOT one rounded rectangle with a
 * different label under it.
 */
export const AppleDeviceIPhoneGlyph: Icon = glyph(
  "AppleDeviceIPhoneGlyph",
  "0 0 24 24",
  <>
    <rect x="6.5" y="1.5" width="11" height="21" rx="2.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <rect x="10" y="3.4" width="4" height="1" rx="0.5" />
  </>,
);

export const AppleDeviceIPadGlyph: Icon = glyph(
  "AppleDeviceIPadGlyph",
  "0 0 24 24",
  <>
    <rect x="3.5" y="2.5" width="17" height="19" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <circle cx="12" cy="19.4" r="0.8" />
  </>,
);

export const AppleDeviceWatchGlyph: Icon = glyph(
  "AppleDeviceWatchGlyph",
  "0 0 24 24",
  <>
    <rect x="7" y="6.5" width="10" height="11" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M9 6.5 9.6 2.6h4.8l.6 3.9M9 17.5l.6 3.9h4.8l.6-3.9" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </>,
);

export const AppleDeviceTvGlyph: Icon = glyph(
  "AppleDeviceTvGlyph",
  "0 0 24 24",
  <>
    <rect x="2.5" y="4.5" width="19" height="13" rx="2" fill="none" stroke="currentColor" strokeWidth="1.4" />
    <path d="M8 21h8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </>,
);

export const AppleDeviceVisionGlyph: Icon = glyph(
  "AppleDeviceVisionGlyph",
  "0 0 24 24",
  <path
    d="M3.2 11.3c0-2.6 3.3-4.2 8.8-4.2s8.8 1.6 8.8 4.2c0 2.8-1.4 5.6-3.6 5.6-1.7 0-2.9-1.5-5.2-1.5s-3.5 1.5-5.2 1.5c-2.2 0-3.6-2.8-3.6-5.6Z"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.4"
    strokeLinejoin="round"
  />,
);
