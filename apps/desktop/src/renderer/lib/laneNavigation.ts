export function openLaneInLanesTabPath(laneId: string): string {
  const params = new URLSearchParams({
    laneId,
    focus: "single",
  });
  return `/lanes?${params.toString()}`;
}
