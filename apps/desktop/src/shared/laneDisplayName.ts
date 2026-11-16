/**
 * What the UI calls a lane. A project's primary lane (its main checkout, not
 * a worktree) is stored as "Primary"; every screen shows it as "Main
 * checkout". The stored name stays, and code that matches the primary lane by
 * name (`useDraftMachineRouting.ts`) keeps matching "Primary".
 */
export const PRIMARY_LANE_DISPLAY_NAME = "Main checkout";

export function laneDisplayName(lane: { name: string; laneType?: string | null }): string {
  if (lane.laneType === "primary" && (lane.name.trim() === "" || lane.name.trim().toLowerCase() === "primary")) return PRIMARY_LANE_DISPLAY_NAME;
  return lane.name;
}
