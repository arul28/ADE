import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import type { LinearIssueSnapshotPatch } from "../../../shared/types";
import { linearPriorityLabel } from "../../../shared/laneLinearIssue";
import { isRecord, toOptionalString as str } from "../shared/utils";

const record = (value: unknown): Record<string, unknown> | null => (isRecord(value) ? value : null);

/**
 * Reads the fields a lane keeps about its Linear issue out of an `Issue`
 * webhook, so lanes stay in step with Linear. Returns null for other events.
 */
export function linearIssuePatchFromEvent(event: LinearIngressEventRecord): LinearIssueSnapshotPatch | null {
  if ((event.entityType ?? "").toLowerCase() !== "issue" || event.action === "remove") return null;
  const payload = record(event.payload);
  const data = record(payload?.data);
  const id = str(data?.id) ?? event.issueId;
  if (!data || !id) return null;
  const state = record(data.state);
  const assignee = record(data.assignee);
  const actor = record(payload?.actor);
  const priority = typeof data.priority === "number" && Number.isInteger(data.priority) ? data.priority : null;
  return {
    id,
    title: str(data.title),
    stateId: str(data.stateId) ?? str(state?.id),
    stateName: str(state?.name),
    stateType: str(state?.type),
    // `assigneeId: null` in the payload means unassigned; absent means unknown.
    ...(Object.prototype.hasOwnProperty.call(data, "assigneeId")
      ? { assigneeId: str(data.assigneeId), assigneeName: str(assignee?.name) ?? str(assignee?.displayName) }
      : {}),
    priority,
    priorityLabel: priority != null ? linearPriorityLabel(priority) : null,
    updatedAt: str(data.updatedAt),
    actorName: str(actor?.name) ?? str(actor?.displayName),
  };
}
