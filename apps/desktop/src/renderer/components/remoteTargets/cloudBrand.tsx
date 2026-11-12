import { useId } from "react";
import { Cloud } from "@phosphor-icons/react";
import type { CloudTierId } from "../../../shared/cloudTiers";
import "./cloudBrand.css";

export const ADE_CLOUD_NAME = "ADE Cloud";

/**
 * ADE Cloud's mark. `bold` draws it heavier at small sizes. `brand` paints it
 * in the Night sky color (theme-aware, see cloudBrand.css) instead of
 * `color`.
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
  return (
    <Cloud
      size={size}
      className={brand ? ["adec-mark", className].filter(Boolean).join(" ") : className}
      color={brand ? "currentColor" : color}
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
