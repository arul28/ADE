import type { LaneSummary } from "../../../desktop/src/shared/types/lanes";

export function sortLanesForStackGraph(lanes: LaneSummary[]): LaneSummary[] {
  return [...lanes].sort((a, b) => Number(b.laneType === "primary") - Number(a.laneType === "primary") || a.name.localeCompare(b.name));
}
