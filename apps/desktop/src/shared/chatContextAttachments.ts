import type { AgentChatContextAttachment, LaneLinearIssue } from "./types";

export function chatContextAttachmentKey(attachment: AgentChatContextAttachment): string {
  return `linear:${attachment.issue.id}`;
}

export function makeLinearIssueContextAttachment(
  issue: LaneLinearIssue,
  source: "manual" | "lane_link" = "manual",
): AgentChatContextAttachment {
  return {
    type: "linear_issue",
    issue,
    source,
    attachedAt: new Date().toISOString(),
  };
}

export function mergeChatContextAttachments(
  current: AgentChatContextAttachment[],
  incoming: AgentChatContextAttachment[],
): AgentChatContextAttachment[] {
  const deduped = new Map<string, AgentChatContextAttachment>();
  for (const attachment of current) deduped.set(chatContextAttachmentKey(attachment), attachment);
  for (const attachment of incoming) deduped.set(chatContextAttachmentKey(attachment), attachment);
  return [...deduped.values()];
}

export function removeChatContextAttachment(
  current: AgentChatContextAttachment[],
  key: string,
): AgentChatContextAttachment[] {
  return current.filter((attachment) => chatContextAttachmentKey(attachment) !== key);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function readNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function normalizeLinearIssue(value: unknown): LaneLinearIssue | null {
  const issue = readRecord(value);
  if (!issue) return null;
  const id = readString(issue.id);
  const identifier = readString(issue.identifier);
  const title = readString(issue.title);
  const projectId = readString(issue.projectId);
  const projectSlug = readString(issue.projectSlug);
  const teamId = readString(issue.teamId);
  const teamKey = readString(issue.teamKey);
  const stateId = readString(issue.stateId);
  const stateName = readString(issue.stateName);
  const stateType = readString(issue.stateType);
  const createdAt = readString(issue.createdAt);
  const updatedAt = readString(issue.updatedAt);
  if (!id || !identifier || !title || !projectId || !projectSlug || !teamId || !teamKey || !stateId || !stateName || !stateType || !createdAt || !updatedAt) {
    return null;
  }
  const rawPriorityLabel = readString(issue.priorityLabel);
  const priorityLabel: LaneLinearIssue["priorityLabel"] = rawPriorityLabel === "urgent" || rawPriorityLabel === "high" || rawPriorityLabel === "normal" || rawPriorityLabel === "low" || rawPriorityLabel === "none"
    ? rawPriorityLabel
    : "none";
  return {
    id,
    identifier,
    title,
    description: readNullableString(issue.description),
    url: readNullableString(issue.url),
    projectId,
    projectSlug,
    projectName: readNullableString(issue.projectName),
    teamId,
    teamKey,
    teamName: readNullableString(issue.teamName),
    stateId,
    stateName,
    stateType,
    priority: readNumber(issue.priority),
    priorityLabel,
    labels: readStringArray(issue.labels),
    assigneeId: readNullableString(issue.assigneeId),
    assigneeName: readNullableString(issue.assigneeName),
    creatorId: readNullableString(issue.creatorId),
    creatorName: readNullableString(issue.creatorName),
    dueDate: readNullableString(issue.dueDate),
    estimate: issue.estimate == null ? null : readNumber(issue.estimate),
    branchName: readNullableString(issue.branchName),
    createdAt,
    updatedAt,
  };
}

export function normalizeChatContextAttachments(value: unknown): AgentChatContextAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: AgentChatContextAttachment[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    if (!record || record.type !== "linear_issue") continue;
    const issue = normalizeLinearIssue(record.issue);
    if (!issue) continue;
    out.push({
      type: "linear_issue",
      issue,
      source: record.source === "lane_link" ? "lane_link" : "manual",
      attachedAt: readNullableString(record.attachedAt) ?? undefined,
    });
  }
  return mergeChatContextAttachments([], out);
}

function cleanIssueValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed?.length ? trimmed : null;
}

function formatLinearIssueContext(issue: LaneLinearIssue): string {
  const project = cleanIssueValue(issue.projectName) ?? cleanIssueValue(issue.projectSlug) ?? cleanIssueValue(issue.teamKey);
  const team = cleanIssueValue(issue.teamName) ?? cleanIssueValue(issue.teamKey);
  const labels = issue.labels.filter((label) => label.trim().length > 0).join(", ");
  return [
    `- Provider: Linear`,
    `- Identifier: ${issue.identifier}`,
    `- Linear issue id: ${issue.id}`,
    `- Title: ${issue.title}`,
    project ? `- Project: ${project}` : null,
    team ? `- Team: ${team}` : null,
    `- State: ${issue.stateName} (${issue.stateType})`,
    `- Priority: ${issue.priorityLabel} (${issue.priority})`,
    issue.assigneeName ? `- Assignee: ${issue.assigneeName}` : `- Assignee: Unassigned`,
    issue.creatorName ? `- Creator: ${issue.creatorName}` : null,
    issue.dueDate ? `- Due date: ${issue.dueDate}` : null,
    issue.estimate != null ? `- Estimate: ${issue.estimate}` : null,
    labels ? `- Labels: ${labels}` : null,
    issue.branchName ? `- Suggested branch: ${issue.branchName}` : null,
    issue.url ? `- URL: ${issue.url}` : null,
    issue.description?.trim() ? `- Description:\n${issue.description.trim()}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildChatContextAttachmentPrompt(
  contextAttachments: AgentChatContextAttachment[],
): string {
  if (!contextAttachments.length) return "";
  return [
    "Attached issue context:",
    "ADE already stores any local Linear credentials; do not ask the user for a Linear API key. Use the identifiers below, and refresh from ADE/Linear tooling only if current state matters.",
    ...contextAttachments.map((attachment, index) => [
      `Linear issue ${index + 1}:`,
      formatLinearIssueContext(attachment.issue),
    ].join("\n")),
  ].join("\n\n");
}
