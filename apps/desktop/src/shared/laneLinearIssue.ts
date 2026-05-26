import type { LaneLinearIssue } from "./types";

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

export function parseLaneLinearIssueValue(value: unknown): LaneLinearIssue | null {
  const issue = readRecord(value);
  if (!issue) return null;
  const id = readString(issue.id);
  const identifier = readString(issue.identifier);
  const title = readString(issue.title);
  const projectId = readString(issue.projectId) ?? "";
  const projectSlug = readString(issue.projectSlug) ?? "";
  const teamId = readString(issue.teamId);
  const teamKey = readString(issue.teamKey);
  const stateId = readString(issue.stateId);
  const stateName = readString(issue.stateName);
  const stateType = readString(issue.stateType);
  const createdAt = readString(issue.createdAt);
  const updatedAt = readString(issue.updatedAt);
  if (!id || !identifier || !title || !teamId || !teamKey || !stateId || !stateName || !stateType || !createdAt || !updatedAt) {
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

export function parseLaneLinearIssueJson(raw: string | null): LaneLinearIssue | null {
  if (!raw) return null;
  try {
    return parseLaneLinearIssueValue(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function finalizeLaneLinearIssue(issue: LaneLinearIssue, branchName: string): LaneLinearIssue {
  return {
    ...issue,
    id: issue.id.trim(),
    identifier: issue.identifier.trim(),
    title: issue.title.trim(),
    description: issue.description ?? null,
    url: issue.url ?? null,
    projectId: issue.projectId.trim(),
    projectSlug: issue.projectSlug.trim(),
    projectName: issue.projectName ?? null,
    teamId: issue.teamId.trim(),
    teamKey: issue.teamKey.trim(),
    teamName: issue.teamName ?? null,
    stateId: issue.stateId.trim(),
    stateName: issue.stateName.trim(),
    stateType: issue.stateType.trim(),
    labels: issue.labels.map((entry) => entry.trim()).filter(Boolean).slice(0, 24),
    assigneeId: issue.assigneeId ?? null,
    assigneeName: issue.assigneeName ?? null,
    creatorId: issue.creatorId ?? null,
    creatorName: issue.creatorName ?? null,
    dueDate: issue.dueDate ?? null,
    estimate: issue.estimate ?? null,
    branchName,
  };
}

export function laneLinearIssueMissingFields(issue: LaneLinearIssue): string[] {
  const missing: string[] = [];
  if (!issue.id.trim()) missing.push("id");
  if (!issue.identifier.trim()) missing.push("identifier");
  if (!issue.title.trim()) missing.push("title");
  if (!issue.teamId.trim()) missing.push("teamId");
  if (!issue.teamKey.trim()) missing.push("teamKey");
  if (!issue.stateId.trim()) missing.push("stateId");
  if (!issue.stateName.trim()) missing.push("stateName");
  if (!issue.stateType.trim()) missing.push("stateType");
  if (!issue.createdAt.trim()) missing.push("createdAt");
  if (!issue.updatedAt.trim()) missing.push("updatedAt");
  return missing;
}

export function isLinkableLaneLinearIssue(issue: LaneLinearIssue): boolean {
  return Boolean(
    issue.id.trim()
    && issue.identifier.trim()
    && issue.title.trim()
    && issue.teamKey.trim(),
  );
}
