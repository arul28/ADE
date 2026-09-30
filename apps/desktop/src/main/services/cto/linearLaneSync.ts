import type { LinearIngressEventRecord } from "../../../shared/types/linearSync";
import type { LinearPriorityLabel } from "../../../shared/types";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const PRIORITY_LABELS: Record<number, LinearPriorityLabel> = { 0: "none", 1: "urgent", 2: "high", 3: "normal", 4: "low" };

/**
 * Reads the fields a lane keeps about its Linear issue out of an `Issue`
 * webhook, so lanes stay in step with Linear. Returns null for other events.
 */
export function linearIssuePatchFromEvent(event: LinearIngressEventRecord): {
  id: string;
  title?: string | null;
  stateId?: string | null;
  stateName?: string | null;
  stateType?: string | null;
  assigneeId?: string | null;
  assigneeName?: string | null;
  priority?: number | null;
  priorityLabel?: LinearPriorityLabel | null;
  updatedAt?: string | null;
  actorName?: string | null;
} | null {
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
    priorityLabel: priority != null ? PRIORITY_LABELS[priority] ?? null : null,
    updatedAt: str(data.updatedAt),
    actorName: str(actor?.name) ?? str(actor?.displayName),
  };
}
