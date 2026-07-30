import type { LaneSummary } from "../../../shared/types";
import {
  ALLOCATABLE_LANE_COLORS,
  LANE_CLASSIC_COLORS,
  LANE_CLASSIC_COUNT,
  LANE_COLOR_PALETTE,
  LANE_FALLBACK_COLORS,
  LANE_RAINBOW_COLORS,
  PRIMARY_LANE_COLOR,
  allocateLaneColor,
  laneColorName,
  nextAvailableLaneColor,
  resolveLaneAccentColor,
  type LaneColor,
} from "../../../shared/laneColorPalette";

export {
  // `LANE_COLOR_PALETTE` is everything the manual picker may offer;
  // `ALLOCATABLE_LANE_COLORS` is what auto-assignment may draw from. They differ
  // by exactly one entry: the Primary lane's reserved ADE purple.
  ALLOCATABLE_LANE_COLORS,
  LANE_CLASSIC_COLORS,
  LANE_CLASSIC_COUNT,
  LANE_COLOR_PALETTE,
  LANE_FALLBACK_COLORS,
  LANE_RAINBOW_COLORS,
  PRIMARY_LANE_COLOR,
  laneColorName,
  resolveLaneAccentColor,
  type LaneColor,
};

export function getLaneAccent(lane: Pick<LaneSummary, "color"> | null | undefined, fallbackIndex: number): string {
  if (lane?.color) return lane.color;
  return LANE_FALLBACK_COLORS[fallbackIndex % LANE_FALLBACK_COLORS.length];
}

export function colorsInUse(lanes: readonly LaneSummary[], excludeLaneId?: string): Set<string> {
  const used = new Set<string>();
  for (const lane of lanes) {
    if (lane.archivedAt) continue;
    if (excludeLaneId && lane.id === excludeLaneId) continue;
    if (lane.color) used.add(lane.color.toLowerCase());
  }
  return used;
}

export function nextAvailableColor(lanes: readonly LaneSummary[]): string | null {
  return nextAvailableLaneColor(colorsInUse(lanes));
}

export { allocateLaneColor };
