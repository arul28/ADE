import type { LinearIssueCreateInput } from "./types";

/**
 * A Linear create request, read from whatever a caller sent: IPC, a runtime
 * action, a phone, the CLI. Blank strings are "not set", numbers must be
 * finite, and a team and a title are required.
 */
export function parseLinearIssueCreateInput(value: unknown): LinearIssueCreateInput {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const text = (entry: unknown): string | null => (typeof entry === "string" && entry.trim() ? entry.trim() : null);
  const number = (entry: unknown): number | null => (typeof entry === "number" && Number.isFinite(entry) ? entry : null);
  const teamKey = text(input.teamKey);
  const title = text(input.title);
  if (!teamKey || !title) throw new Error("A Linear issue needs a team and a title.");
  return {
    teamKey,
    title,
    description: typeof input.description === "string" ? input.description : null,
    projectId: text(input.projectId),
    projectMilestoneId: text(input.projectMilestoneId),
    parentId: text(input.parentId),
    stateId: text(input.stateId),
    assigneeId: text(input.assigneeId),
    cycleId: text(input.cycleId),
    dueDate: text(input.dueDate),
    templateId: text(input.templateId),
    priority: number(input.priority),
    estimate: number(input.estimate),
    labelIds: Array.isArray(input.labelIds)
      ? input.labelIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      : [],
  };
}
