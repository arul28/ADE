import type { AgentChatContextAttachment, LaneLinearIssue } from "./types";
import { parseLaneLinearIssueValue } from "./laneLinearIssue";

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

function readNullableString(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === "string" ? value : null;
}

export function normalizeChatContextAttachments(value: unknown): AgentChatContextAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: AgentChatContextAttachment[] = [];
  for (const entry of value) {
    const record = readRecord(entry);
    if (!record || record.type !== "linear_issue") continue;
    const issue = parseLaneLinearIssueValue(record.issue);
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
