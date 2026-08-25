import type { CursorCloudAgentSummary, CursorCloudFleetEntry, CursorCloudFleetRunStatus } from "./types/config";

/**
 * Canonical fleet-row status logic, shared by the main-process fleet service
 * and the renderer so section placement, Stop-button visibility, and filter
 * results can never drift between layers.
 *
 * Status resolution: the latest run refines the coarse agent-list status;
 * an unknown run status on a live agent reads as "creating" (the agent exists
 * and has not finished anything yet).
 */
export function cursorCloudFleetRunStatus(
  entry: Pick<CursorCloudFleetEntry, "runStatus" | "agent">,
): CursorCloudFleetRunStatus {
  if (entry.runStatus) return entry.runStatus;
  const lower = entry.agent.status?.toLowerCase();
  if (lower === "running") return "running";
  if (lower === "finished") return "finished";
  if (lower === "error") return "error";
  return "creating";
}

export function isCursorCloudFleetEntryActive(
  entry: Pick<CursorCloudFleetEntry, "runStatus" | "agent">,
): boolean {
  if (entry.agent.archived) return false;
  const status = cursorCloudFleetRunStatus(entry);
  return status === "creating" || status === "running";
}

/** Display string: archived wins over run state. */
export function cursorCloudFleetDisplayStatus(
  entry: Pick<CursorCloudFleetEntry, "runStatus" | "agent">,
): CursorCloudFleetRunStatus | "archived" {
  if (entry.agent.archived) return "archived";
  return cursorCloudFleetRunStatus(entry);
}

export type { CursorCloudAgentSummary };
