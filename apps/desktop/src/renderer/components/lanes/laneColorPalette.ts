import type { LaneSummary } from "../../../shared/types";

export type LaneColor = {
  hex: string;
  name: string;
};

// 12 primary-leaning hexes. The first 8 are kept compatible with the legacy
// LANE_ACCENT_COLORS array used as an index-based fallback for unassigned lanes.
export const LANE_COLOR_PALETTE: readonly LaneColor[] = [
  { hex: "#a78bfa", name: "Violet" },
  { hex: "#60a5fa", name: "Blue" },
  { hex: "#34d399", name: "Emerald" },
  { hex: "#fbbf24", name: "Amber" },
  { hex: "#f472b6", name: "Pink" },
  { hex: "#fb923c", name: "Orange" },
  { hex: "#2dd4bf", name: "Teal" },
  { hex: "#c084fc", name: "Purple" },
  { hex: "#f87171", name: "Red" },
  { hex: "#a3e635", name: "Lime" },
  { hex: "#22d3ee", name: "Cyan" },
  { hex: "#e879f9", name: "Fuchsia" },
] as const;

export const LANE_FALLBACK_COLORS: readonly string[] = LANE_COLOR_PALETTE
  .slice(0, 8)
  .map((c) => c.hex);

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
  const used = colorsInUse(lanes);
  for (const entry of LANE_COLOR_PALETTE) {
    if (!used.has(entry.hex.toLowerCase())) return entry.hex;
  }
  return null;
}

export function laneColorName(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const lower = hex.toLowerCase();
  return LANE_COLOR_PALETTE.find((c) => c.hex.toLowerCase() === lower)?.name ?? null;
}
