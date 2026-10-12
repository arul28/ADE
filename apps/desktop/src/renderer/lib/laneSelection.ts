type LaneRef = { id: string; laneType?: string | null };

/**
 * The lane a project opens on when nothing better is known: Primary, else the
 * first lane, else null. Shared so the app store and the Work start surface
 * agree on where a project lands.
 */
export function defaultLaneId(lanes: ReadonlyArray<LaneRef>): string | null {
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
}

/**
 * The saved lane when it is still in `lanes`, otherwise {@link defaultLaneId}.
 */
export function pickRestoredLaneId(
  lanes: ReadonlyArray<LaneRef>,
  savedLaneId: string | null | undefined,
): string | null {
  if (savedLaneId != null && lanes.some((lane) => lane.id === savedLaneId)) return savedLaneId;
  return defaultLaneId(lanes);
}
