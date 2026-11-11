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

/** One building of the skyline. */
export type CloudSkylineLane = { id: string; awake: boolean };

/** Building shapes in turn, so the row reads as a skyline and not as bars. */
const BUILDINGS = [
  { width: 10, height: 12 },
  { width: 12, height: 17 },
  { width: 9, height: 10 },
  { width: 11, height: 14 },
  { width: 9, height: 8 },
] as const;
/** The skyline draws at most this many buildings; more lanes still count in the subtitle. */
const SKYLINE_MAX = 5;
const SKYLINE_WIDTH = 46;
const SKYLINE_HEIGHT = 20;
const GROUND_Y = 18.5;

/**
 * A tiny skyline of the person's ADE Cloud lanes, one building for each lane
 * (up to five), awake ones lit. The box has one fixed size whatever the
 * count, so the menu row never changes height or width as lanes come and go.
 * With no lanes it draws an empty plot, still the same size.
 */
export function CloudSkyline({ lanes, className }: { lanes: readonly CloudSkylineLane[]; className?: string }) {
  // Awake lanes first, so the lit windows stand in the middle of the row.
  const shown = [...lanes]
    .sort((a, b) => Number(b.awake) - Number(a.awake) || a.id.localeCompare(b.id))
    .slice(0, SKYLINE_MAX);
  const totalWidth = shown.reduce((sum, _lane, index) => sum + BUILDINGS[index % BUILDINGS.length]!.width, 0)
    + Math.max(0, shown.length - 1);
  let x = Math.max(0, (SKYLINE_WIDTH - totalWidth) / 2);
  const anyAwake = shown.some((lane) => lane.awake);
  return (
    <svg
      width={SKYLINE_WIDTH}
      height={SKYLINE_HEIGHT}
      viewBox={`0 0 ${SKYLINE_WIDTH} ${SKYLINE_HEIGHT}`}
      className={className}
      aria-hidden="true"
      focusable="false"
      style={{ display: "block", flexShrink: 0 }}
    >
      {anyAwake ? <ellipse className="adec-sky-glow" cx={SKYLINE_WIDTH / 2} cy={GROUND_Y} rx={18} ry={3} /> : null}
      {shown.length === 0 ? (
        <rect className="adec-sky-empty" x={14} y={9} width={18} height={9} rx={1} />
      ) : null}
      {shown.map((lane, index) => {
        const shape = BUILDINGS[index % BUILDINGS.length]!;
        const left = x;
        x += shape.width + 1;
        const top = GROUND_Y - shape.height;
        const windows: Array<{ wx: number; wy: number; dark: boolean }> = [];
        for (let row = 0; top + 2.5 + row * 3.5 < GROUND_Y - 2.5; row += 1) {
          for (let column = 0; left + 2 + column * 3.2 < left + shape.width - 2.4; column += 1) {
            // A fixed pattern, so a lit building keeps the same windows on.
            windows.push({ wx: left + 2 + column * 3.2, wy: top + 2.5 + row * 3.5, dark: (row + column + index) % 3 === 2 });
          }
        }
        return (
          <g key={lane.id} className={lane.awake ? "adec-sky-lit" : "adec-sky-asleep"}>
            <rect className="adec-sky-wall" x={left} y={top} width={shape.width} height={shape.height} />
            <rect className="adec-sky-side" x={left + shape.width - 2} y={top} width={2} height={shape.height} />
            <rect className="adec-sky-edge" x={left} y={top} width={shape.width} height={0.8} />
            {windows.map((window) => (
              <rect
                key={`${window.wx}:${window.wy}`}
                className={lane.awake && window.dark ? "adec-sky-window-dark" : "adec-sky-window"}
                x={window.wx}
                y={window.wy}
                width={1.4}
                height={1.6}
              />
            ))}
          </g>
        );
      })}
      <line className="adec-sky-ground" x1={2} x2={SKYLINE_WIDTH - 2} y1={GROUND_Y} y2={GROUND_Y} strokeWidth={0.8} />
    </svg>
  );
}

/** "3 lanes · 1 awake", "1 lane", or "No lanes yet": the ADE Cloud row's second line. */
export function cloudSkylineSummary(lanes: readonly CloudSkylineLane[]): string {
  if (lanes.length === 0) return "No lanes yet";
  const awake = lanes.filter((lane) => lane.awake).length;
  const count = `${lanes.length} ${lanes.length === 1 ? "lane" : "lanes"}`;
  return awake > 0 ? `${count} · ${awake} awake` : count;
}
