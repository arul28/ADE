/**
 * Linear issue normalization, shared by the desktop's Linear client and the
 * ADE Cloud reads (the account server passes Linear's own `data` back). Pure:
 * no Node and no DOM, so the renderer and the web client can run it.
 */

import type { CtoLinearQuickViewProject, CtoLinearQuickViewTeam, LinearIssueRef, NormalizedLinearIssue } from "./types";
import { linearPriorityLabel } from "./laneLinearIssue";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A trimmed string, or null for an empty or missing one. */
function asString(value: unknown): string | null {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw.length > 0 ? raw : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function priorityIsValid(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 4;
}

function isOpenStateType(stateType: string): boolean {
  return stateType !== "completed" && stateType !== "canceled" && stateType !== "duplicate";
}

function isRelatedRelationType(type: string | null): boolean {
  return type === "related" || type === "duplicate";
}

function toIssueRef(value: unknown): LinearIssueRef | null {
  if (!isRecord(value)) return null;
  const id = asString(value.id);
  if (!id) return null;
  const state = isRecord(value.state) ? value.state : null;
  return {
    id,
    identifier: asString(value.identifier) ?? "",
    title: asString(value.title) ?? "",
    stateId: state ? asString(state.id) ?? "" : "",
    stateName: state ? asString(state.name) ?? "" : "",
    stateType: state ? asString(state.type) ?? "" : "",
  };
}

function dedupeIssueRefs(refs: Array<LinearIssueRef | null>): LinearIssueRef[] {
  const seen = new Map<string, LinearIssueRef>();
  for (const ref of refs) {
    if (ref && !seen.has(ref.id)) seen.set(ref.id, ref);
  }
  return [...seen.values()];
}

export function toNormalizedIssue(node: Record<string, unknown>): NormalizedLinearIssue | null {
  const id = asString(node.id);
  const identifier = asString(node.identifier);
  const title = asString(node.title);
  if (!id || !identifier || !title) return null;

  // Linear allows issues without a project (they live in a team only), so
  // `project` is optional during normalization — falling through to empty
  // strings keeps the existing display fallbacks (`projectName || projectSlug
  // || teamKey`) intact. `team` and `state` remain required since every
  // Linear issue has them.
  const project = isRecord(node.project) ? node.project : null;
  const team = isRecord(node.team) ? node.team : null;
  const state = isRecord(node.state) ? node.state : null;
  if (!team || !state) return null;

  const projectId = project ? (asString(project.id) ?? "") : "";
  const projectSlug = project ? (asString(project.slug) ?? asString(project.slugId) ?? "") : "";
  const teamId = asString(team.id);
  const teamKey = asString(team.key);
  const stateId = asString(state.id);
  const stateName = asString(state.name);
  const stateType = asString(state.type);
  if (!teamId || !teamKey || !stateId || !stateName || !stateType) return null;

  const labelsNodes = isRecord(node.labels) ? asArray(node.labels.nodes) : [];
  const labels = labelsNodes
    .map((entry) => (isRecord(entry) ? asString(entry.name) : null))
    .filter((entry): entry is string => entry != null)
    .map((entry) => entry.toLowerCase());

  const labelColors = labelsNodes
    .filter((ln: unknown): ln is Record<string, unknown> => isRecord(ln))
    .map((ln) => {
      const labelId = asString(ln.id);
      return {
        ...(labelId ? { id: labelId } : {}),
        name: asString(ln.name) ?? "",
        color: asString(ln.color) ?? null,
      };
    });

  const cycle = isRecord(node.cycle) ? node.cycle : null;
  const cycleId = cycle ? asString(cycle.id) : null;
  const cycleName = cycle ? asString(cycle.name) : null;
  const cycleStartsAt = cycle ? asString(cycle.startsAt) : null;
  const cycleEndsAt = cycle ? asString(cycle.endsAt) : null;

  const childIssues = (isRecord(node.children) ? asArray(node.children.nodes) : [])
    .map(toIssueRef)
    .filter((entry): entry is LinearIssueRef => entry != null);

  const parentIssue = toIssueRef(node.parent);

  // Linear stores "A blocks B" once, as a relation on A. B sees it through
  // `inverseRelations` (its source `issue` is the blocker), so "blocked by"
  // comes from inverse `blocks` relations — never from sub-issues.
  const inverseRelationNodes = isRecord(node.inverseRelations)
    ? asArray(node.inverseRelations.nodes).filter(isRecord)
    : [];
  const outgoingRelationNodes = isRecord(node.relations)
    ? asArray(node.relations.nodes).filter(isRecord)
    : null;
  const blockedByIssues = dedupeIssueRefs(
    inverseRelationNodes
      .filter((relation) => asString(relation.type) === "blocks")
      .map((relation) => toIssueRef(relation.issue)),
  );
  const blockingIssues = outgoingRelationNodes
    ? dedupeIssueRefs(
      outgoingRelationNodes
        .filter((relation) => asString(relation.type) === "blocks")
        .map((relation) => toIssueRef(relation.relatedIssue)),
    )
    : undefined;
  const relatedIssues = outgoingRelationNodes
    ? dedupeIssueRefs([
      ...outgoingRelationNodes
        .filter((relation) => isRelatedRelationType(asString(relation.type)))
        .map((relation) => toIssueRef(relation.relatedIssue)),
      ...inverseRelationNodes
        .filter((relation) => isRelatedRelationType(asString(relation.type)))
        .map((relation) => toIssueRef(relation.issue)),
    ])
    : undefined;
  const blockerIssueIds = blockedByIssues.map((entry) => entry.id);
  const hasOpenBlockers = blockedByIssues.some((entry) => isOpenStateType(entry.stateType));

  const assignee = isRecord(node.assignee) ? node.assignee : null;
  const owner = isRecord(node.creator) ? node.creator : null;
  const priority = Number(node.priority ?? 0);
  const metadataRecord = isRecord(node.metadata) ? node.metadata : null;
  const metadataTagsRaw = metadataRecord && Array.isArray(metadataRecord.tags)
    ? (metadataRecord.tags as unknown[])
    : [];
  const metadataTags = metadataTagsRaw.filter((tag): tag is string => typeof tag === "string");

  return {
    id,
    identifier,
    title,
    description: asString(node.description) ?? "",
    url: asString(node.url),
    projectId,
    projectSlug,
    projectName: project ? asString(project.name) : null,
    teamId,
    teamKey,
    teamName: asString(team.name),
    stateId,
    stateName,
    stateType,
    priority: Number.isFinite(priority) ? priority : 0,
    priorityLabel: linearPriorityLabel(Number.isFinite(priority) ? priority : 0),
    labels,
    labelColors,
    cycleId,
    cycleName,
    cycleStartsAt,
    cycleEndsAt,
    childIssues,
    parentIssue,
    blockedByIssues,
    ...(blockingIssues ? { blockingIssues } : {}),
    ...(relatedIssues ? { relatedIssues } : {}),
    branchName: asString(node.branchName),
    metadataTags,
    assigneeId: assignee ? asString(assignee.id) : null,
    assigneeName: assignee ? (asString(assignee.displayName) ?? asString(assignee.name)) : null,
    assigneeAvatarUrl: assignee ? asString(assignee.avatarUrl) : null,
    ownerId: owner ? asString(owner.id) : null,
    creatorId: owner ? asString(owner.id) : null,
    creatorName: owner ? (asString(owner.displayName) ?? asString(owner.name)) : null,
    blockerIssueIds,
    hasOpenBlockers,
    dueDate: asString(node.dueDate),
    estimate: typeof node.estimate === "number" && Number.isFinite(node.estimate) ? node.estimate : null,
    archivedAt: asString(node.archivedAt),
    completedAt: asString(node.completedAt),
    canceledAt: asString(node.canceledAt),
    startedAt: asString(node.startedAt),
    createdAt: asString(node.createdAt) ?? new Date().toISOString(),
    updatedAt: asString(node.updatedAt) ?? new Date().toISOString(),
    raw: node,
  };
}

/** A project row of the Linear pane, from Linear's own project node. */
export function mapLinearQuickViewProject(project: Record<string, unknown>): CtoLinearQuickViewProject {
  const status = isRecord(project.status) ? project.status : null;
  const lead = isRecord(project.lead) ? project.lead : null;
  const teamNodes = asArray(isRecord(project.teams) ? project.teams.nodes : []).filter(isRecord);
  const teamName = teamNodes
    .map((team) => asString(team.name))
    .find((entry): entry is string => Boolean(entry?.trim())) ?? "Unassigned";
  const teamKey = teamNodes
    .map((team) => asString(team.key))
    .find((entry): entry is string => Boolean(entry?.trim())) ?? null;
  return {
    id: String(project.id ?? ""),
    name: String(project.name ?? "Untitled project"),
    slug: String(project.slugId ?? ""),
    teamName,
    ...(teamKey ? { teamKey } : {}),
    url: asString(project.url),
    color: asString(project.color),
    icon: asString(project.icon),
    description: asString(project.description),
    statusName: status ? asString(status.name) : null,
    statusType: status ? asString(status.type) : null,
    health: asString(project.health),
    progress: typeof project.progress === "number" ? project.progress : null,
    scope: typeof project.scope === "number" ? project.scope : null,
    priority: typeof project.priority === "number" ? project.priority : null,
    priorityLabel: asString(project.priorityLabel),
    // Weekly snapshot, not a live count. Live counts come from countIssues.
    issueCount: Array.isArray(project.issueCountHistory) ? Number(project.issueCountHistory.at(-1) ?? 0) : null,
    completedIssueCount: Array.isArray(project.completedIssueCountHistory)
      ? Number(project.completedIssueCountHistory.at(-1) ?? 0)
      : null,
    startDate: asString(project.startDate),
    targetDate: asString(project.targetDate),
    leadName: lead ? (asString(lead.displayName) ?? asString(lead.name)) : null,
    teamKeys: teamNodes.map((team) => asString(team.key)).filter((entry): entry is string => Boolean(entry)),
  };
}

/** A team row of the Linear pane, from Linear's own team node. */
export function mapLinearQuickViewTeam(team: Record<string, unknown>): CtoLinearQuickViewTeam {
  return {
    id: String(team.id ?? ""),
    key: String(team.key ?? ""),
    name: String(team.name ?? "Team"),
    displayName: String(team.displayName ?? team.name ?? "Team"),
    color: asString(team.color),
    issueCount: typeof team.issueCount === "number" ? team.issueCount : null,
    cyclesEnabled: typeof team.cyclesEnabled === "boolean" ? team.cyclesEnabled : null,
    private: typeof team.private === "boolean" ? team.private : null,
  };
}

/** The filters of an issue search, as the Linear pane passes them. */
export type LinearIssueFilterParams = {
  projectId?: string | null;
  projectSlug?: string | null;
  teamKey?: string | null;
  stateTypes?: string[];
  stateIds?: string[];
  assigneeId?: string | null;
  assignedToViewer?: boolean;
  activeCycle?: boolean;
  priority?: number | null;
};

/** Every filter of an issue search except the text query, as Linear's `IssueFilter`. */
export function buildLinearIssueBaseFilter(params: LinearIssueFilterParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const projectId = params.projectId?.trim();
  const projectSlug = params.projectSlug?.trim();
  const teamKey = params.teamKey?.trim();
  const stateTypes = (params.stateTypes ?? []).map((entry) => entry.trim()).filter(Boolean);
  const stateIds = (params.stateIds ?? []).map((entry) => entry.trim()).filter(Boolean);
  const assigneeId = params.assigneeId?.trim();

  if (projectId) {
    filter.project = { id: { eq: projectId } };
  } else if (projectSlug) {
    filter.project = { slugId: { eq: projectSlug } };
  }
  if (teamKey) {
    filter.team = { key: { eq: teamKey } };
  }
  if (stateTypes.length > 0 || stateIds.length > 0) {
    filter.state = {
      ...(stateTypes.length > 0 ? { type: { in: stateTypes } } : {}),
      ...(stateIds.length > 0 ? { id: { in: stateIds } } : {}),
    };
  }
  if (assigneeId) {
    filter.assignee = { id: { eq: assigneeId } };
  } else if (params.assignedToViewer === true) {
    filter.assignee = { isMe: { eq: true } };
  }
  if (params.activeCycle === true) {
    filter.cycle = { isActive: { eq: true } };
  }
  if (priorityIsValid(params.priority)) {
    filter.priority = { eq: params.priority };
  }
  return filter;
}
