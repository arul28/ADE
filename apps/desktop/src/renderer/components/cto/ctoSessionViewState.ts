export function resolveCtoPrimaryLaneId(lanes: Array<{ id: string; laneType?: string | null }>): string | null {
  return lanes.find((lane) => lane.laneType === "primary")?.id ?? lanes[0]?.id ?? null;
}
