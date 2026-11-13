import { useId } from "react";
import { Cloud } from "@phosphor-icons/react";
import type { CloudTierId } from "../../../shared/cloudTiers";
import "./cloudBrand.css";

export const ADE_CLOUD_NAME = "ADE Cloud";

/**
 * The logo's cloud outline (viewBox `1 3 30 20`), shared with the dashboard's sky.
 * Change one, change both: the billing return page draws the same cloud
 * (apps/account-directory/src/cloud/returnPage.ts).
 */
export const CLOUD_LOGO_PATH =
  "M9 21H24A5.5 5.5 0 0 0 24.6 10.03A7.5 7.5 0 0 0 10.4 8.2A6.5 6.5 0 0 0 9 21Z";

/**
 * ADE Cloud's logo: a violet-to-rose cloud with one lit window, the lamp gold
 * of the night city's windows (one lit window is one agent at work). The same
 * mark as the website. Draws at any size from 11px up; `glow` adds the soft
 * halo around the window for large sizes (a filter, so only where it shows).
 * Its colours are fixed on purpose (the same in both themes, and the same as
 * the website and the billing return page), so they don't read the tokens.
 */
export function CloudLogo({
  size = 16,
  className,
  glow = false,
  title,
}: {
  size?: number;
  className?: string;
  glow?: boolean;
  title?: string;
}) {
  const id = `adec-logo-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  // The outline's box is 30 x 20: the width follows the height so the cloud keeps its shape.
  const width = Math.round(size * 1.5 * 100) / 100;
  return (
    <svg
      width={width}
      height={size}
      viewBox="1 3 30 20"
      className={["adec-logo", className].filter(Boolean).join(" ")}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
      style={{ display: "block", flexShrink: 0, overflow: "visible" }}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#c4b5fd" />
          <stop offset="55%" stopColor="#8b5cf6" />
          <stop offset="100%" stopColor="#db2777" />
        </linearGradient>
        {glow ? (
          <filter id={`${id}-glow`} x="-100%" y="-100%" width="300%" height="300%">
            <feGaussianBlur stdDeviation="1.1" />
          </filter>
        ) : null}
      </defs>
      <path d={CLOUD_LOGO_PATH} fill={`url(#${id}-fill)`} />
      <path d={CLOUD_LOGO_PATH} fill="none" stroke="white" strokeOpacity="0.35" strokeWidth="0.6" />
      {glow ? <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a" filter={`url(#${id}-glow)`} opacity="0.9" /> : null}
      <rect x="15" y="12.2" width="4.4" height="4.4" rx="0.9" fill="#ffd27a" />
    </svg>
  );
}

/**
 * ADE Cloud's mark. `bold` draws the outline heavier at small sizes. `brand`
 * draws the full-colour logo (`CloudLogo`) instead: use it wherever the mark
 * stands for ADE Cloud itself (its page, its chip, the header meter). Without
 * it the mark is a one-colour outline in `color`, for a notice's tone tile or
 * a menu row that colours its own icon.
 */
export function CloudMark({
  size = 14,
  className,
  color = "currentColor",
  bold = false,
  brand = false,
}: {
  size?: number | string;
  className?: string;
  color?: string;
  bold?: boolean;
  brand?: boolean;
}) {
  if (brand) {
    // The logo is wider than tall: the same height reads as the same size as the outline.
    const px = typeof size === "number" ? size : Number.parseFloat(size) || 14;
    return <CloudLogo size={Math.round(px * 0.78 * 10) / 10} className={className} />;
  }
  return (
    <Cloud
      size={size}
      className={className}
      color={color}
      weight={bold ? "bold" : "regular"}
      aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}
    />
  );
}

/** The cloud outline the size icon fills (24 unit box). */
const CLOUD_PATH = "M6.9 18.6A4.2 4.2 0 0 1 6.532 10.216A5.4 5.4 0 0 1 17.12 9.419A4.6 4.6 0 0 1 16.7 18.6Z";

/** Where the fill's top edge sits for each size: a quarter, a half, three quarters, full. */
const FILL_TOP: Record<CloudTierId, number> = {
  small: 14.9,
  medium: 11.9,
  large: 8.6,
  xlarge: 2,
};

/**
 * The size of an ADE Cloud computer as the cloud mark filled from the bottom:
 * Small a quarter, Medium a half, Large three quarters, X-Large full. The
 * fill moves (CSS transition, off with reduced motion) when the size changes.
 * The element stays mounted across sizes so the move can play.
 */
export function CloudSizeIcon({
  tier,
  size = 16,
  className,
}: {
  tier: CloudTierId;
  size?: number;
  className?: string;
}) {
  const clipId = `adec-size-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const lineWidth = size >= 28 ? 1.3 : 2.1;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0, overflow: "visible" }}
    >
      <defs>
        <clipPath id={clipId}>
          <path d={CLOUD_PATH} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        <rect className="adec-size-empty" x="0" y="0" width="24" height="24" />
        <rect
          className="adec-size-fill"
          x="0"
          y="0"
          width="24"
          height="24"
          style={{ transform: `translateY(${FILL_TOP[tier]}px)` }}
        />
      </g>
      <path className="adec-size-line" d={CLOUD_PATH} strokeWidth={lineWidth} />
    </svg>
  );
}
