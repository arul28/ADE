import type { AgentChatContextAttachment, LaneLinearIssue } from "./types";
import type { OrchestrationContextItem } from "./types/orchestration";

export function chatContextAttachmentKey(attachment: AgentChatContextAttachment): string {
  switch (attachment.type) {
    case "linear_issue":
      return `linear:${attachment.issue.id}`;
    case "orchestration_annotation":
      return orchestrationAnnotationAttachmentKey(attachment.item);
  }
}

/**
 * Each annotation gets a unique key so multiple selections of the same anchor
 * still merge as distinct entries. The capturedAt timestamp is the source of
 * uniqueness; the anchor id/kind keep the key human-readable in dev tools.
 */
function orchestrationAnnotationAttachmentKey(item: OrchestrationContextItem): string {
  const anchorId = item.anchor.id ?? "anon";
  return `orchestration-annotation:${item.runId}:${item.anchor.kind}:${anchorId}:${item.capturedAt}`;
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

export function makeOrchestrationAnnotationContextAttachment(
  item: OrchestrationContextItem,
): AgentChatContextAttachment {
  return {
    type: "orchestration_annotation",
    item,
    source: "manual",
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

function escapeUntrustedXml(value: string): string {
  // Entity-escape characters that would otherwise let untrusted Linear content
  // break out of the surrounding `<untrusted-data>` wrapper. `&` must be first
  // so we don't double-escape entities introduced by later replacements.
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapUntrustedLinearText(value: string): string {
  // Linear titles/descriptions are author-controlled and may contain
  // prompt-injection content. Wrap them so downstream agents know the text
  // inside is data, not instructions.
  return `<untrusted-data source="linear">${escapeUntrustedXml(value)}</untrusted-data>`;
}

function formatLinearIssueContext(issue: LaneLinearIssue): string {
  const project = cleanIssueValue(issue.projectName) ?? cleanIssueValue(issue.projectSlug) ?? cleanIssueValue(issue.teamKey);
  const team = cleanIssueValue(issue.teamName) ?? cleanIssueValue(issue.teamKey);
  const labels = issue.labels.filter((label) => label.trim().length > 0).join(", ");
  const description = issue.description?.trim();
  return [
    `- Provider: Linear`,
    `- Identifier: ${issue.identifier}`,
    `- Linear issue id: ${issue.id}`,
    `- Title: ${wrapUntrustedLinearText(issue.title)}`,
    project ? `- Project: ${wrapUntrustedLinearText(project)}` : null,
    team ? `- Team: ${wrapUntrustedLinearText(team)}` : null,
    `- State: ${wrapUntrustedLinearText(issue.stateName)} (${wrapUntrustedLinearText(issue.stateType)})`,
    `- Priority: ${issue.priorityLabel} (${issue.priority})`,
    issue.assigneeName ? `- Assignee: ${wrapUntrustedLinearText(issue.assigneeName)}` : `- Assignee: Unassigned`,
    issue.creatorName ? `- Creator: ${wrapUntrustedLinearText(issue.creatorName)}` : null,
    issue.dueDate ? `- Due date: ${issue.dueDate}` : null,
    issue.estimate != null ? `- Estimate: ${issue.estimate}` : null,
    labels ? `- Labels: ${wrapUntrustedLinearText(labels)}` : null,
    issue.branchName ? `- Suggested branch: ${wrapUntrustedLinearText(issue.branchName)}` : null,
    issue.url ? `- URL: ${wrapUntrustedLinearText(issue.url)}` : null,
    description ? `- Description:\n${wrapUntrustedLinearText(description)}` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function formatOrchestrationAnnotation(item: OrchestrationContextItem): string {
  const anchor = item.anchor;
  const anchorLabel = `${anchor.kind}${anchor.id ? `:${anchor.id}` : ""}`;
  const preview = anchor.preview.trim();
  const excerpt = item.selectionExcerpt.trim();
  const comment = item.comment.trim();
  return [
    `- Run id: ${item.runId}`,
    `- Anchor: ${anchorLabel}`,
    anchor.href ? `- Href: ${anchor.href}` : null,
    anchor.sectionId ? `- Section: ${anchor.sectionId}` : null,
    preview ? `- Preview:\n${preview}` : null,
    excerpt ? `- Selection excerpt:\n${excerpt}` : null,
    comment ? `- User comment:\n${comment}` : `- User comment: (none — anchor only)`,
    `- Captured at: ${item.capturedAt}`,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

export function buildChatContextAttachmentPrompt(
  contextAttachments: AgentChatContextAttachment[],
): string {
  if (!contextAttachments.length) return "";
  const linear = contextAttachments.filter(
    (entry): entry is Extract<AgentChatContextAttachment, { type: "linear_issue" }> =>
      entry.type === "linear_issue",
  );
  const annotations = contextAttachments.filter(
    (entry): entry is Extract<AgentChatContextAttachment, { type: "orchestration_annotation" }> =>
      entry.type === "orchestration_annotation",
  );
  const sections: string[] = [];
  if (linear.length) {
    sections.push([
      "Attached issue context:",
      "ADE already stores any local Linear credentials; do not ask the user for a Linear API key. Use the identifiers below, and refresh from ADE/Linear tooling only if current state matters.",
      ...linear.map((attachment, index) => [
        `Linear issue ${index + 1}:`,
        formatLinearIssueContext(attachment.issue),
      ].join("\n")),
    ].join("\n\n"));
  }
  if (annotations.length) {
    sections.push([
      "Plan-panel annotations (ephemeral — user selected these in the orchestration plan view):",
      ...annotations.map((attachment, index) => [
        `Annotation ${index + 1}:`,
        formatOrchestrationAnnotation(attachment.item),
      ].join("\n")),
    ].join("\n\n"));
  }
  return sections.join("\n\n");
}
