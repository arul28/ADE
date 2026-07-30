export type LaneColor = {
  hex: string;
  name: string;
};

export const LANE_CLASSIC_COLORS: readonly LaneColor[] = [
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
];

export const LANE_RAINBOW_COLORS: readonly LaneColor[] = [
  { hex: "#ef4444", name: "Bright Red" },
  { hex: "#f97316", name: "Bright Orange" },
  { hex: "#facc15", name: "Bright Yellow" },
  { hex: "#22c55e", name: "Bright Green" },
  { hex: "#2563eb", name: "Bright Blue" },
  { hex: "#4f46e5", name: "Indigo" },
  { hex: "#7c3aed", name: "Bright Violet" },
] as const;

export const LANE_COLOR_PALETTE: readonly LaneColor[] = [
  ...LANE_CLASSIC_COLORS,
  ...LANE_RAINBOW_COLORS,
] as const;

export const LANE_CLASSIC_COUNT = LANE_CLASSIC_COLORS.length;

/**
 * ADE purple — `--color-accent` in `index.css`, and `LANE_CLASSIC_COLORS[0]`
 * ("Violet"). RESERVED for the Primary lane, which exists on every ADE machine
 * and is the one lane whose colour is worth learning by heart. Reserving it is
 * what makes that possible: no auto-assigned lane may claim it (see
 * `ALLOCATABLE_LANE_COLORS`), so purple in the sidebar always means Primary.
 *
 * It stays in `LANE_COLOR_PALETTE` on purpose — the manual picker may still
 * offer it, and lanes that already hold it are left alone.
 */
export const PRIMARY_LANE_COLOR = "#a78bfa";

/**
 * The pool auto-allocation draws from: every palette entry except the reserved
 * Primary purple.
 */
export const ALLOCATABLE_LANE_COLORS: readonly LaneColor[] = LANE_COLOR_PALETTE
  .filter((entry) => entry.hex.toLowerCase() !== PRIMARY_LANE_COLOR);

// Fallback accents are auto-assigned too (a lane with no stored colour picks one
// by index), so they come off the allocatable pool rather than the full palette.
export const LANE_FALLBACK_COLORS: readonly string[] = ALLOCATABLE_LANE_COLORS
  .slice(0, 8)
  .map((entry) => entry.hex);

export function nextAvailableLaneColor(usedColors: Iterable<string>): string | null {
  const used = new Set(
    [...usedColors]
      .map((color) => color.trim().toLowerCase())
      .filter((color) => color.length > 0),
  );
  for (const entry of ALLOCATABLE_LANE_COLORS) {
    if (!used.has(entry.hex.toLowerCase())) return entry.hex;
  }
  return null;
}

export function randomLaneColor(): string {
  const index = Math.floor(Math.random() * ALLOCATABLE_LANE_COLORS.length);
  return ALLOCATABLE_LANE_COLORS[index]?.hex ?? ALLOCATABLE_LANE_COLORS[0]!.hex;
}

export function allocateLaneColor(usedColors: Iterable<string>): string {
  return nextAvailableLaneColor(usedColors) ?? randomLaneColor();
}

/**
 * The accent a lane renders with. Primary is LOCKED to ADE purple regardless of
 * what its row stores: primaries created before the colour was reserved carry a
 * null colour, and the whole point of the reservation is that Primary looks the
 * same on every machine and in every project.
 */
export function resolveLaneAccentColor(
  lane: { laneType?: string | null; color?: string | null } | null | undefined,
): string | null {
  if (!lane) return null;
  if (lane.laneType === "primary") return PRIMARY_LANE_COLOR;
  return lane.color ?? null;
}

export function laneColorName(hex: string | null | undefined): string | null {
  if (!hex) return null;
  const lower = hex.toLowerCase();
  return LANE_COLOR_PALETTE.find((entry) => entry.hex.toLowerCase() === lower)?.name ?? null;
}
